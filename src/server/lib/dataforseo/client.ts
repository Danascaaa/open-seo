import {
  type CreditFeature,
  mapDataforseoPathToCreditFeature,
} from "@/shared/billing-credit-features";
import {
  assertUsageCreditsAvailable,
  getOrCreateOrganizationCustomer,
  trackUsageCreditSpend,
} from "@/server/billing/subscription";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import {
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from "@/server/lib/dataforseo/business";
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from "@/server/lib/dataforseo/backlinks";
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
} from "@/server/lib/dataforseo/labs";
import {
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from "@/server/lib/dataforseo/google-ads";
import {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from "@/server/lib/dataforseo/ai";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";
import {
  commitSeoBudget,
  markSeoBudgetUncertain,
  providerUsdToCents,
  releaseSeoBudget,
  reserveSeoBudget,
} from "@/server/budget/ledger";

export { mapDataforseoPathToCreditFeature };

/**
 * Wraps a section fetcher with billing metering. Each entry on the client is
 * `meter(customer, fetchX, defaultFeature?)`, which returns a function with
 * the fetcher's own input type and resolves to its unwrapped `.data`.
 *
 * `defaultFeature` is the fallback credit feature; a caller can override it per
 * call by passing `creditFeature` in the input (e.g. an MCP tool attributing
 * spend to its own feature). The extra field is ignored by the fetchers, which
 * read named fields rather than spreading the input.
 */
export type PreparedDataforseoCall<T> = {
  execute: () => Promise<T>;
  release: (reason: string) => Promise<void>;
};

export type MeteredDataforseoCall<I, T> = {
  (input: I & { creditFeature?: CreditFeature }): Promise<T>;
  prepare: (
    input: I & { creditFeature?: CreditFeature },
  ) => Promise<PreparedDataforseoCall<T>>;
};

function meter<I, T>(
  customer: BillingCustomerContext,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  defaultFeature?: CreditFeature,
): MeteredDataforseoCall<I, T> {
  const prepare = (input: I & { creditFeature?: CreditFeature }) =>
    prepareDataforseoCall(
      customer,
      () => fetcher(input),
      input.creditFeature ?? defaultFeature,
      `dataforseo:${fetcher.name || "unknown"}`,
    );
  return Object.assign(
    async (input: I & { creditFeature?: CreditFeature }) =>
      (await prepare(input)).execute(),
    { prepare },
  );
}

type PreparedFactory<T> = () => Promise<PreparedDataforseoCall<T>>;
type PreparedFactories = readonly PreparedFactory<unknown>[];

/**
 * Reserves every paid call before any provider request can start. If one
 * reservation fails, prior reservations are released and no execute closure
 * is invoked.
 */
export async function prepareDataforseoBatch<const T extends PreparedFactories>(
  factories: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const prepared: PreparedDataforseoCall<unknown>[] = [];
  try {
    for (const factory of factories) prepared.push(await factory());
  } catch (error) {
    await Promise.allSettled(
      prepared.map((call) =>
        call.release("batch reservation failed before provider dispatch"),
      ),
    );
    throw error;
  }
  return prepared as unknown as {
    [K in keyof T]: Awaited<ReturnType<T[K]>>;
  };
}

export function createDataforseoClient(customer: BillingCustomerContext) {
  return {
    business: {
      businessListings: meter(
        customer,
        fetchBusinessListingsSearch,
        "local_seo",
      ),
      questionsAnswers: meter(customer, fetchQuestionsAnswers, "local_seo"),
      myBusinessInfo: meter(customer, fetchMyBusinessInfo, "local_seo"),
      // task_post is where DataForSEO charges; collection runs unmetered
      // through fetchBusinessDataTaskResult (see index.ts).
      reviewsTaskPost: meter(customer, postGoogleReviewsTask, "local_seo"),
      updatesTaskPost: meter(customer, postMyBusinessUpdatesTask, "local_seo"),
    },
    backlinks: {
      summary: meter(customer, fetchBacklinksSummary),
      rows: meter(customer, fetchBacklinksRows),
      referringDomains: meter(customer, fetchReferringDomains),
      domainPages: meter(customer, fetchDomainPagesSummary),
      history: meter(customer, fetchBacklinksHistory),
    },
    keywords: {
      related: meter(customer, fetchRelatedKeywords),
      suggestions: meter(customer, fetchKeywordSuggestions),
      ideas: meter(customer, fetchKeywordIdeas),
      // Google Ads endpoints for countries Labs doesn't support.
      adsIdeas: meter(customer, fetchAdsKeywordIdeas),
      adsSearchVolume: meter(customer, fetchAdsSearchVolume),
    },
    domain: {
      rankOverview: meter(customer, fetchDomainRankOverview),
      rankedKeywords: meter(customer, fetchRankedKeywords),
      relevantPages: meter(customer, fetchRelevantPages),
    },
    serp: {
      live: meter(customer, fetchLiveSerp),
      rankCheck: meter(customer, fetchRankCheckSerp, "rank_tracking"),
      // Posts up to 100 queued rank check tasks; one metered charge covers the
      // whole batch (DataForSEO bills task_post at post time, collection is
      // free).
      rankCheckTaskPost: meter(customer, postRankCheckTasks, "rank_tracking"),
      local: meter(customer, fetchLocalSerp, "local_seo"),
    },
    labs: {
      // Callers (e.g. the keyword-metrics MCP tool) can attribute the spend to
      // their own feature by passing `creditFeature` in the input; defaults to
      // rank_tracking when omitted.
      keywordOverview: meter(customer, fetchKeywordOverview, "rank_tracking"),
      serpCompetitors: meter(customer, fetchSerpCompetitors),
    },
    lighthouse: {
      live: meter(customer, fetchLighthouseResult),
    },
    aiSearch: {
      mentionsSearch: meter(customer, fetchLlmMentionsSearch),
      aggregatedMetrics: meter(customer, fetchLlmAggregatedMetrics),
      topPages: meter(customer, fetchLlmTopPages),
      crossAggregatedMetrics: meter(customer, fetchLlmCrossAggregatedMetrics),
      llmResponse: meter(customer, fetchLlmResponse),
    },
  } as const;
}

async function prepareDataforseoCall<T>(
  customer: BillingCustomerContext,
  execute: () => Promise<DataforseoApiResponse<T>>,
  creditFeature?: CreditFeature,
  budgetTool = "dataforseo:unknown",
): Promise<PreparedDataforseoCall<T>> {
  const reservation = await reserveSeoBudget({
    projectId: customer.projectId,
    tool: budgetTool,
    provider: "dataforseo",
    category: "research",
  });
  if (reservation.status !== "reserved") {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `SEO budget reservation is not dispatchable (${reservation.status})`,
    );
  }
  let state: "prepared" | "executing" | "finished" | "released" = "prepared";
  return {
    execute: async () => {
      if (state !== "prepared") {
        throw new AppError(
          "INTERNAL_ERROR",
          `Prepared paid operation cannot execute from state ${state}`,
        );
      }
      state = "executing";
      try {
        return await executeReservedDataforseoCall(
          customer,
          execute,
          reservation,
          creditFeature,
        );
      } finally {
        state = "finished";
      }
    },
    release: async (reason) => {
      if (state !== "prepared") return;
      state = "released";
      await releaseSeoBudget(reservation, reason);
    },
  };
}

async function executeReservedDataforseoCall<T>(
  customer: BillingCustomerContext,
  execute: () => Promise<DataforseoApiResponse<T>>,
  reservation: Awaited<ReturnType<typeof reserveSeoBudget>>,
  creditFeature?: CreditFeature,
): Promise<T> {
  const isHostedMode = await isHostedServerAuthMode();

  if (!isHostedMode) {
    try {
      const result = await execute();
      await commitAfterPaidCall(reservation, result.billing.costUsd);
      return result.data;
    } catch (error) {
      await settleDataforseoFailure(reservation, error);
      throw error;
    }
  }

  let billingCustomer: { id: string };
  let monthlyRemaining: number;
  try {
    billingCustomer = await getOrCreateOrganizationCustomer(customer);
    ({ monthlyRemaining } = await assertUsageCreditsAvailable(
      billingCustomer.id,
    ));
  } catch (error) {
    await releaseSeoBudget(reservation, "hosted credit gate refused call");
    throw error;
  }

  let result: DataforseoApiResponse<T>;
  try {
    result = await execute();
  } catch (error) {
    if (error instanceof DataforseoChargedTaskError) {
      // A malformed request (DataForSEO "Invalid Field: ...") that DataForSEO
      // did not bill returns no value to the customer, so don't charge — surface
      // it as a non-reportable VALIDATION_ERROR. If DataForSEO still billed us
      // (costUsd > 0), fall through to the normal charge + capture path so the
      // spend stays metered and visible instead of silently eaten.
      if (error.isInvalidField && error.billing.costUsd <= 0) {
        await releaseSeoBudget(reservation, "provider rejected unbilled input");
        throw new AppError("VALIDATION_ERROR", error.message);
      }
      await trackDataforseoCost({
        customer,
        customerId: billingCustomer.id,
        billing: error.billing,
        monthlyRemaining,
        creditFeature,
      });
      await commitAfterPaidCall(reservation, error.billing.costUsd);
    } else {
      await settleDataforseoFailure(reservation, error);
    }
    throw error;
  }

  await trackDataforseoCost({
    customer,
    customerId: billingCustomer.id,
    billing: result.billing,
    monthlyRemaining,
    creditFeature,
  });
  await commitAfterPaidCall(reservation, result.billing.costUsd);

  return result.data;
}

async function commitAfterPaidCall(
  reservation: Awaited<ReturnType<typeof reserveSeoBudget>>,
  costUsd: number,
): Promise<void> {
  try {
    await commitSeoBudget(reservation, providerUsdToCents(costUsd));
  } catch (error) {
    // The full category remains reserved when settlement is unavailable, so
    // returning the provider result cannot open room for another paid call.
    console.error("seo-budget.settlement-failed", {
      operationId: reservation.operationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function settleDataforseoFailure(
  reservation: Awaited<ReturnType<typeof reserveSeoBudget>>,
  error: unknown,
): Promise<void> {
  try {
    if (
      error instanceof DataforseoChargedTaskError &&
      error.billing.costUsd <= 0
    ) {
      await releaseSeoBudget(reservation, "provider confirmed zero cost");
      return;
    }
    // A network/timeout/HTTP failure after dispatch does not prove the vendor
    // skipped billing. Preserve the reservation and require reconciliation;
    // never replay the provider request from here.
    await markSeoBudgetUncertain(
      reservation,
      error instanceof Error ? error.name : "unknown provider failure",
    );
  } catch (settlementError) {
    console.error("seo-budget.uncertain-settlement-failed", {
      operationId: reservation.operationId,
      error:
        settlementError instanceof Error
          ? settlementError.message
          : String(settlementError),
    });
  }
}

async function trackDataforseoCost(args: {
  customer: BillingCustomerContext;
  customerId: string;
  billing: DataforseoApiCallCost;
  monthlyRemaining: number;
  creditFeature?: CreditFeature;
}) {
  await trackUsageCreditSpend({
    customer: args.customer,
    customerId: args.customerId,
    creditFeature:
      args.creditFeature ?? mapDataforseoPathToCreditFeature(args.billing.path),
    costUsd: args.billing.costUsd,
    monthlyRemaining: args.monthlyRemaining,
    properties: {
      provider: "dataforseo",
      paths: [args.billing.path.join("/")],
      fromCache: false,
    },
  });
}
