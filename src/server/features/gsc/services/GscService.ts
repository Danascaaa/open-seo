import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { account } from "@/db/schema";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { AppError } from "@/server/lib/errors";
import {
  createGscClient,
  createGscServiceAccountClient,
  getGscServiceAccountProjectConfig,
  type GscClient,
  type GscSite,
  type UrlInspectionResult,
} from "@/server/lib/gscClient";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
export { GscNotConnectedError } from "@/server/lib/gscErrors";
import {
  buildSearchAnalyticsRequest,
  type GscPerformanceInput,
} from "@/server/features/gsc/searchAnalytics";
import {
  GscConnectionRepository,
  type GscConnection,
} from "@/server/features/gsc/repositories/GscConnectionRepository";
import type {
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";

const SITE_UNVERIFIED_PERMISSION = "siteUnverifiedUser";

type GscPerformanceResult = {
  siteUrl: string;
  connectedBy: string | null;
  request: GscSearchAnalyticsRequest;
  rows: GscSearchAnalyticsRow[];
};

type GscSiteListResult = {
  accounts: Array<{
    accountId: string;
    email: string | null;
    requiresReconnect: boolean;
    propertiesUnavailable: boolean;
    sites: GscSite[];
  }>;
};

export type ResolvedGscConnection = Pick<
  GscConnection,
  "siteUrl" | "connectedByUserId" | "gscAccountId" | "connectedAccountEmail"
> & {
  source: "oauth" | "service_account";
  createdAt: GscConnection["createdAt"] | null;
};

async function assertServiceAccountProperty(
  client: GscClient,
  siteUrl: string,
): Promise<void> {
  const sites = await client.listSites();
  const match = sites.find((site) => site.siteUrl === siteUrl);
  if (!match) {
    throw new AppError(
      "FORBIDDEN",
      "The server-managed Search Console property is not available to the configured service account.",
    );
  }
  if (match.permissionLevel === SITE_UNVERIFIED_PERMISSION) {
    throw new AppError(
      "FORBIDDEN",
      "The configured service account does not have verified access to this Search Console property.",
    );
  }
}

async function resolveConnection(projectId: string): Promise<{
  connection: ResolvedGscConnection;
  client: GscClient;
} | null> {
  const serviceConfig = await getGscServiceAccountProjectConfig(projectId);
  if (serviceConfig) {
    const client = createGscServiceAccountClient(serviceConfig);
    await assertServiceAccountProperty(client, serviceConfig.siteUrl);
    return {
      connection: {
        source: "service_account",
        siteUrl: serviceConfig.siteUrl,
        connectedByUserId: "server-managed",
        gscAccountId: null,
        connectedAccountEmail: null,
        createdAt: null,
      },
      client,
    };
  }

  const connection = await GscConnectionRepository.getByProjectId(projectId);
  if (!connection) return null;
  return {
    connection: { ...connection, source: "oauth" },
    client: createGscClient({
      userId: connection.connectedByUserId,
      gscAccountId: connection.gscAccountId ?? undefined,
    }),
  };
}

/** Resolve and validate the effective property. Server mappings take
 * precedence, while removing a mapping reveals the untouched OAuth row. */
async function getConnection(
  projectId: string,
): Promise<ResolvedGscConnection | null> {
  return (await resolveConnection(projectId))?.connection ?? null;
}

/** Whether this user has linked a google-search-console grant (regardless of
 *  whether they've picked a property yet). Drives the connect-vs-pick UI. */
async function userHasGrant(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GSC_OAUTH_PROVIDER_ID),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function listGrantsForUser(userId: string) {
  return db
    .select({ id: account.id, accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GSC_OAUTH_PROVIDER_ID),
      ),
    );
}

/** Expected ways a stored grant fails to reach Search Console: no token could be
 *  minted (refresh token revoked or expired), or Google rejected the call
 *  (401/403). These surface a reconnect prompt without fault logging. */
export function isExpectedGrantFailure(error: unknown): boolean {
  if (error instanceof GscTokenError) return true;
  return (
    error instanceof GscApiError &&
    (error.status === 401 || error.status === 403)
  );
}

async function listSitesForUserWithGrantStatus(
  userId: string,
): Promise<GscSiteListResult> {
  const grants = await listGrantsForUser(userId);
  const accounts = await Promise.all(
    grants.map(async (grant) => {
      const client = createGscClient({
        userId,
        gscAccountId: grant.accountId,
      });

      try {
        const sites = await client.listSites();
        let email: string | null = null;
        try {
          email = await client.getUserInfoEmail();
        } catch {
          email = null;
        }
        return {
          accountId: grant.accountId,
          email,
          requiresReconnect: false,
          propertiesUnavailable: false,
          sites,
        };
      } catch (error) {
        if (!isExpectedGrantFailure(error)) {
          console.error(
            "Failed to list Search Console sites for account",
            grant.accountId,
            error,
          );
        }
        return {
          accountId: grant.accountId,
          email: null,
          requiresReconnect: isExpectedGrantFailure(error),
          propertiesUnavailable: !isExpectedGrantFailure(error),
          sites: [],
        };
      }
    }),
  );
  return { accounts };
}

/** Map a verified property to a project. Rejects unverified properties and
 *  properties not present on the connector's grant. */
async function setSite(input: {
  projectId: string;
  organizationId: string;
  siteUrl: string;
  accountId: string;
  userId: string;
}): Promise<GscConnection> {
  if (await getGscServiceAccountProjectConfig(input.projectId)) {
    throw new AppError(
      "FORBIDDEN",
      "This project's Search Console property is managed by server configuration.",
    );
  }
  const grants = await listGrantsForUser(input.userId);
  if (!grants.some((grant) => grant.accountId === input.accountId)) {
    throw new AppError(
      "NOT_FOUND",
      "That Google account isn't connected to your OpenSEO account.",
    );
  }

  const client = createGscClient({
    userId: input.userId,
    gscAccountId: input.accountId,
  });
  const sites = await client.listSites();
  const match = sites.find((s) => s.siteUrl === input.siteUrl);
  if (!match) {
    throw new AppError(
      "NOT_FOUND",
      "That Search Console property isn't available on your connected Google account.",
    );
  }
  if (match.permissionLevel === SITE_UNVERIFIED_PERMISSION) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have verified access to that Search Console property.",
    );
  }
  let connectedAccountEmail: string | null = null;
  try {
    connectedAccountEmail = await client.getUserInfoEmail();
  } catch {
    connectedAccountEmail = null;
  }
  return GscConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    siteUrl: input.siteUrl,
    connectedByUserId: input.userId,
    gscAccountId: input.accountId,
    connectedAccountEmail,
  });
}

async function disconnect(input: { projectId: string }): Promise<void> {
  if (await getGscServiceAccountProjectConfig(input.projectId)) {
    throw new AppError(
      "FORBIDDEN",
      "This project's Search Console property is managed by server configuration.",
    );
  }
  await GscConnectionRepository.deleteByProjectId(input.projectId);
}

/** Pass-through of GSC `searchAnalytics.query` for a project's connected property. */
async function getPerformance(
  input: GscPerformanceInput,
): Promise<GscPerformanceResult> {
  const resolved = await resolveConnection(input.projectId);
  if (!resolved) {
    throw new GscNotConnectedError(input.projectId);
  }
  const { connection, client } = resolved;
  const request = buildSearchAnalyticsRequest(input);
  const rows = await client.querySearchAnalytics(connection.siteUrl, request);
  return {
    siteUrl: connection.siteUrl,
    connectedBy: connection.connectedAccountEmail,
    request,
    rows,
  };
}

type GscUrlInspection = {
  url: string;
  result: UrlInspectionResult | null;
  error?: string;
};

type GscInspectUrlsResult = {
  siteUrl: string;
  connectedBy: string | null;
  results: GscUrlInspection[];
};

/** Inspect 1–N URLs against a project's connected property. Resolves the
 *  connection once, then inspects each URL; per-URL failures are captured
 *  inline so one bad URL doesn't fail the batch. Token/grant failures
 *  propagate so the caller can prompt a reconnect. */
async function inspectUrls(input: {
  projectId: string;
  urls: string[];
  languageCode?: string;
}): Promise<GscInspectUrlsResult> {
  const resolved = await resolveConnection(input.projectId);
  if (!resolved) {
    throw new GscNotConnectedError(input.projectId);
  }
  const { connection, client } = resolved;
  const results: GscUrlInspection[] = [];
  for (const url of input.urls) {
    try {
      const result = await client.inspectUrl(
        connection.siteUrl,
        url,
        input.languageCode,
      );
      results.push({ url, result });
    } catch (error) {
      if (error instanceof GscTokenError) throw error;
      results.push({
        url,
        result: null,
        error: error instanceof Error ? error.message : "Inspection failed",
      });
    }
  }
  return {
    siteUrl: connection.siteUrl,
    connectedBy: connection.connectedAccountEmail,
    results,
  };
}

export const GscService = {
  getConnection,
  userHasGrant,
  listSitesForUserWithGrantStatus,
  setSite,
  disconnect,
  getPerformance,
  inspectUrls,
};
