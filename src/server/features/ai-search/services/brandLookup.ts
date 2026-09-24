import { waitUntil } from "cloudflare:workers";
import { identity, sortBy } from "remeda";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  createDataforseoClient,
  prepareDataforseoBatch,
  type PreparedDataforseoCall,
} from "@/server/lib/dataforseo";
import {
  buildLlmTarget,
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  type LlmPlatform,
} from "@/server/lib/dataforseo";
import type { LlmCrossAggregatedItem } from "@/server/lib/dataforseoLlmSchemas";
import { AppError } from "@/server/lib/errors";
import { assertPaidOperationsEnabled } from "@/server/budget/ledger";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import {
  resolveCompetitorGroups,
  type CompetitorGroup,
  type CrossOutcome,
} from "@/server/features/ai-search/services/shareOfVoice";
import {
  shapeResult,
  type PlatformBundle,
  type PlatformOutcome,
} from "@/server/features/ai-search/services/brandLookupShaping";
import {
  brandLookupResultSchema,
  type BrandLookupInput,
  type BrandLookupResult,
} from "@/types/schemas/ai-search";
import { detectTarget } from "@/shared/targetDetection";
import {
  parseResearchTarget,
  type ResearchTarget,
} from "@/shared/researchScope";

/**
 * Brand Lookup is the AI-search analog of Domain Overview. The user types a
 * brand name or domain; we hit DataForSEO's LLM Mentions API across ChatGPT
 * (US-only) and Google AI Overview, then shape the response into something
 * the UI can render directly. Stateless — no DB writes, R2 caching only.
 */

/** Brand lookup data refreshes daily; underlying API is updated monthly. */
const BRAND_LOOKUP_TTL_SECONDS = 24 * 60 * 60;

const PLATFORMS: LlmPlatform[] = ["chat_gpt", "google"];

// Prompt rows supply explainable examples for cited pages. Ranked source rows
// come from top_pages so the table is not limited to this sample.
const MENTIONS_PER_PLATFORM = 100;
const TOP_SOURCES_PER_PLATFORM = 10;

export async function getBrandLookup(
  input: BrandLookupInput,
  billingCustomer: BillingCustomerContext,
): Promise<BrandLookupResult> {
  const detected = detectTarget(input.query);
  const researchTarget = resolveResearchTarget(input, detected);
  // The LLM mentions API only scopes a domain target by subdomain inclusion;
  // exact_url/subfolder are honored by post-filtering page rows in shaping.
  const includeSubdomains =
    researchTarget === null || researchTarget.scope === "subdomains";
  const competitorGroups = resolveCompetitorGroups(
    detected.value,
    input.competitors,
  );

  // Changing this key's param set orphans every pre-deploy cache entry; with a
  // 24h TTL that's at most one re-charged lookup per cached target — accepted
  // rather than maintaining parallel legacy-shape parsing.
  const cacheKey = await buildCacheKey("ai-search:brand-lookup", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    targetType: detected.type,
    // Values are lowercased for DataForSEO's matching semantics. Competitors
    // are canonical detected values too, so equivalent casing/order shares one
    // paid cache entry.
    targetValue: detected.value.toLowerCase(),
    competitors: sortBy(
      competitorGroups.map((g) => g.detected.value.toLowerCase()),
      identity(),
    ).join("|"),
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    // Scope changes both the provider call (include_subdomains) and the
    // page-level filtering, so it must not share a cache entry. The path only
    // affects output under URL scopes — keying it for domain/subdomains would
    // re-buy identical fan-outs for example.com vs example.com/blog.
    scope: researchTarget?.scope ?? null,
    path:
      researchTarget?.scope === "exact_url" ||
      researchTarget?.scope === "subfolder"
        ? researchTarget.path
        : "",
  });

  const cached = brandLookupResultSchema.safeParse(await getCached(cacheKey));
  if (cached.success) {
    return {
      ...cached.data,
      query: input.query,
      resolvedTarget: researchTarget?.display ?? detected.value,
    };
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  await assertPaidOperationsEnabled([
    "dataforseo:fetchLlmAggregatedMetrics",
    "dataforseo:fetchLlmTopPages",
    "dataforseo:fetchLlmMentionsSearch",
    ...(competitorGroups.length > 0
      ? ["dataforseo:fetchLlmCrossAggregatedMetrics"]
      : []),
  ]);
  const prepared = await prepareBrandLookupBatch({
    detected,
    includeSubdomains,
    input,
    competitorGroups,
    dataforseo,
  });

  let settled: Array<PromiseSettledResult<PlatformBundle>>;
  let crossOutcomes: CrossOutcome[];
  try {
    settled = [];
    for (const platform of PLATFORMS) {
      settled.push(
        await settle(() =>
          fetchPreparedPlatformData(prepared.platforms[platform]),
        ),
      );
    }
    rethrowIfBlockingAiSearchError(settled);
    crossOutcomes =
      prepared.cross === null
        ? []
        : await fetchPreparedCrossAggregated(prepared.cross);
  } catch (error) {
    await Promise.allSettled(
      prepared.all.map((call) =>
        call.release("brand lookup stopped before dispatch"),
      ),
    );
    throw error;
  }

  const platformBundles: PlatformOutcome[] = settled.map((settledResult, i) => {
    const platform = PLATFORMS[i];
    if (settledResult.status === "fulfilled") {
      return { platform, status: "success", bundle: settledResult.value };
    }
    console.error(
      `ai-search.brand-lookup.${platform}.error:`,
      settledResult.reason,
    );
    return { platform, status: "error", bundle: null };
  });

  const result = shapeResult({
    query: input.query,
    detected,
    researchTarget,
    platformBundles,
    crossOutcomes,
    competitorKeys: competitorGroups.map((g) => g.label),
    userLocationCode: input.locationCode,
    userLanguageCode: input.languageCode,
  });

  // Only cache when every call succeeded — a platform bundle that swallowed a
  // failed sub-call into empty fallback data is renderable but must not be
  // frozen for 24h with no way to retry; same for a partial SoV miss when
  // competitors were requested.
  const allSucceeded =
    platformBundles.every(
      (b) => b.status === "success" && b.bundle?.complete,
    ) && crossOutcomes.every((c) => c.status === "success");
  if (allSucceeded && result.hasData) {
    waitUntil(
      setCached(cacheKey, result, BRAND_LOOKUP_TTL_SECONDS).catch((err) => {
        console.error("ai-search.brand-lookup.cache-write failed:", err);
      }),
    );
  }

  return result;
}

/**
 * Scopes only apply to domain/URL queries — a brand keyword has no URL to
 * narrow. A domain the parser rejects (fake TLD) keeps today's unscoped
 * behavior and fails downstream with the provider's own validation error.
 */
function resolveResearchTarget(
  input: BrandLookupInput,
  detected: ReturnType<typeof detectTarget>,
): ResearchTarget | null {
  if (detected.type !== "domain") return null;
  const parsed = parseResearchTarget(input.query, input.scope);
  if (!parsed.ok) {
    // An explicit scope that doesn't fit the input (Subfolder without a path)
    // must error, not silently run an unscoped lookup.
    if (input.scope) throw new AppError("VALIDATION_ERROR", parsed.message);
    return null;
  }
  return parsed.target;
}

async function settle<T>(
  execute: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await execute() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

type PlatformFetchInput = Pick<
  BrandLookupInput,
  "locationCode" | "languageCode"
>;

type PreparedPlatformCalls = {
  aggregated: PreparedDataforseoCall<PlatformBundle["aggregated"]>;
  topPages: PreparedDataforseoCall<PlatformBundle["topPages"]>;
  mentions: PreparedDataforseoCall<PlatformBundle["mentions"]>;
  platform: LlmPlatform;
};

async function fetchPreparedPlatformData(
  calls: PreparedPlatformCalls,
): Promise<PlatformBundle> {
  const { platform } = calls;
  // Settle sub-calls independently so one failure doesn't discard the others we
  // already paid for, but keep them sequenced for hosted billing checks.
  const aggregated = await settle(() => calls.aggregated.execute());
  const topPages = await settle(() => calls.topPages.execute());
  const mentions = await settle(() => calls.mentions.execute());

  rethrowIfBlockingAiSearchError([aggregated, topPages, mentions]);

  // If every sub-call failed we have nothing to render for this platform —
  // reject so the outer `allSucceeded` gate refuses to cache a blank result.
  const allRejected =
    aggregated.status === "rejected" &&
    topPages.status === "rejected" &&
    mentions.status === "rejected";
  if (allRejected) throw aggregated.reason;

  return {
    aggregated: fulfilledOr(aggregated, () => ({}), platform, "aggregated"),
    topPages: fulfilledOr(topPages, () => [], platform, "topPages"),
    mentions: fulfilledOr(mentions, () => [], platform, "mentions"),
    complete:
      aggregated.status === "fulfilled" &&
      topPages.status === "fulfilled" &&
      mentions.status === "fulfilled",
  };
}

/**
 * One cross_aggregated_metrics call per platform (ChatGPT forced to US/en),
 * each comparing the target against the competitors. Settled per-platform so a
 * single failure doesn't discard the other — matching the per-platform
 * fan-out in {@link getBrandLookup}. The target's aggregation_key is the
 * resolved target value so SoV can flag the target row.
 *
 * Share of Voice always compares domain against domain — the provider has no
 * URL-level targeting — so every group (target and competitors) uses the same
 * subdomain rule and the UI labels the section domain-level under URL scopes.
 */
type PreparedCrossCalls = Record<
  LlmPlatform,
  PreparedDataforseoCall<LlmCrossAggregatedItem[]>
>;

async function fetchPreparedCrossAggregated(
  calls: PreparedCrossCalls,
): Promise<CrossOutcome[]> {
  const settled: Array<PromiseSettledResult<LlmCrossAggregatedItem[]>> = [];
  for (const platform of PLATFORMS) {
    settled.push(await settle(() => calls[platform].execute()));
  }

  rethrowIfBlockingAiSearchError(settled);

  return settled.map((result, i) => {
    const platform = PLATFORMS[i];
    if (result.status === "fulfilled") {
      return { platform, status: "success" as const, items: result.value };
    }
    console.error(
      `ai-search.brand-lookup.${platform}.cross-aggregated.error:`,
      result.reason,
    );
    return { platform, status: "error" as const, items: [] };
  });
}

function platformMarket(platform: LlmPlatform, input: PlatformFetchInput) {
  return {
    locationCode:
      platform === "chat_gpt" ? CHATGPT_LOCATION_CODE : input.locationCode,
    languageCode:
      platform === "chat_gpt" ? CHATGPT_LANGUAGE_CODE : input.languageCode,
  };
}

async function prepareBrandLookupBatch(args: {
  detected: ReturnType<typeof detectTarget>;
  includeSubdomains: boolean;
  input: PlatformFetchInput;
  competitorGroups: CompetitorGroup[];
  dataforseo: ReturnType<typeof createDataforseoClient>;
}): Promise<{
  platforms: Record<LlmPlatform, PreparedPlatformCalls>;
  cross: PreparedCrossCalls | null;
  all: PreparedDataforseoCall<unknown>[];
}> {
  const target = buildLlmTarget({
    type: args.detected.type,
    value: args.detected.value,
    includeSubdomains: args.includeSubdomains,
  });
  const factories: Array<() => Promise<PreparedDataforseoCall<unknown>>> = [];
  for (const platform of PLATFORMS) {
    const market = platformMarket(platform, args.input);
    factories.push(
      () =>
        args.dataforseo.aiSearch.aggregatedMetrics.prepare({
          target,
          platform,
          ...market,
          internalListLimit: 20,
        }),
      () =>
        args.dataforseo.aiSearch.topPages.prepare({
          target,
          platform,
          ...market,
          itemsListLimit: TOP_SOURCES_PER_PLATFORM,
        }),
      () =>
        args.dataforseo.aiSearch.mentionsSearch.prepare({
          target,
          platform,
          ...market,
          limit: MENTIONS_PER_PLATFORM,
        }),
    );
  }
  const groups = [
    { key: args.detected.value, target },
    ...args.competitorGroups.map((competitor) => ({
      key: competitor.label,
      target: buildLlmTarget({
        type: competitor.detected.type,
        value: competitor.detected.value,
        includeSubdomains: args.includeSubdomains,
      }),
    })),
  ];
  if (args.competitorGroups.length > 0) {
    for (const platform of PLATFORMS) {
      factories.push(() =>
        args.dataforseo.aiSearch.crossAggregatedMetrics.prepare({
          groups,
          platform,
          ...platformMarket(platform, args.input),
        }),
      );
    }
  }
  const all = await prepareDataforseoBatch(factories);
  const at = <T>(index: number): PreparedDataforseoCall<T> => {
    const call = all[index];
    if (!call) throw new AppError("INTERNAL_ERROR", "Paid batch is incomplete");
    return call as PreparedDataforseoCall<T>;
  };
  return {
    platforms: {
      chat_gpt: {
        platform: "chat_gpt",
        aggregated: at<PlatformBundle["aggregated"]>(0),
        topPages: at<PlatformBundle["topPages"]>(1),
        mentions: at<PlatformBundle["mentions"]>(2),
      },
      google: {
        platform: "google",
        aggregated: at<PlatformBundle["aggregated"]>(3),
        topPages: at<PlatformBundle["topPages"]>(4),
        mentions: at<PlatformBundle["mentions"]>(5),
      },
    },
    cross:
      args.competitorGroups.length > 0
        ? {
            chat_gpt: at<LlmCrossAggregatedItem[]>(6),
            google: at<LlmCrossAggregatedItem[]>(7),
          }
        : null,
    all,
  };
}

function rethrowIfBlockingAiSearchError(
  results: Array<PromiseSettledResult<unknown>>,
): void {
  for (const result of results) {
    if (
      result.status === "rejected" &&
      result.reason instanceof AppError &&
      (result.reason.code === "INSUFFICIENT_CREDITS" ||
        result.reason.code === "AI_SEARCH_BILLING_ISSUE")
    ) {
      throw result.reason;
    }
  }
}

function fulfilledOr<T>(
  result: PromiseSettledResult<T>,
  fallback: () => T,
  platform: LlmPlatform,
  label: string,
): T {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `ai-search.brand-lookup.${platform}.${label}.error:`,
    result.reason,
  );
  return fallback();
}
