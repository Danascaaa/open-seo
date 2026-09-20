import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { GscApiError, GscTokenError } from "./gscErrors";
import {
  createServiceAccountTokenProvider,
  type GscServiceAccountProjectConfig,
} from "./gscServiceAccount";

export { GscApiError, GscTokenError } from "./gscErrors";
export {
  GSC_SERVICE_ACCOUNT_SCOPE,
  GscServiceAccountError,
  getGscServiceAccountProjectConfig,
  hasGscServiceAccountProjectConfig,
} from "./gscServiceAccount";

const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export type GscSite = {
  siteUrl: string;
  permissionLevel: string;
};

export type GscSearchAnalyticsRow = {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscDimensionFilter = {
  dimension: string;
  operator: string;
  expression: string;
};

export type GscSearchAnalyticsRequest = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  dimensionFilterGroups?: Array<{
    groupType: "and" | "or";
    filters: GscDimensionFilter[];
  }>;
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dataState?: string;
  aggregationType?: string;
};

export type UrlInspectionResult = {
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  mobileUsabilityResult?: { verdict?: string };
  richResultsResult?: { verdict?: string };
  inspectionResultLink?: string;
};

function messageForStatus(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "Search Console denied access to this property (no verified permission, or the connection was revoked).";
  }
  if (status === 429)
    return "Search Console rate limit reached. Retry shortly.";
  if (status === 404) {
    return "Search Console property not found. It may have been removed in Search Console.";
  }
  return `Search Console API error (${status}): ${body.slice(0, 300)}`;
}

function createGscApiClient(
  getToken: () => Promise<string>,
  getEmail: () => Promise<string | null>,
) {
  async function request<T>(
    url: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const token = await getToken();
    const hasBody = init?.body !== undefined;
    let response: Response;
    try {
      response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        body: hasBody ? JSON.stringify(init?.body) : undefined,
      });
    } catch (error) {
      throw new GscApiError(
        503,
        "Search Console is temporarily unavailable.",
        error instanceof Error ? error.message : undefined,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GscApiError(
        response.status,
        messageForStatus(response.status, body),
        body,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new GscApiError(
        502,
        "Search Console returned an invalid response.",
      );
    }
  }

  return {
    getUserInfoEmail: getEmail,
    async listSites(): Promise<GscSite[]> {
      const data = await request<{ siteEntry?: GscSite[] }>(
        `${GSC_API_BASE}/sites`,
      );
      return data.siteEntry ?? [];
    },
    async querySearchAnalytics(
      siteUrl: string,
      body: GscSearchAnalyticsRequest,
    ): Promise<GscSearchAnalyticsRow[]> {
      const data = await request<{ rows?: GscSearchAnalyticsRow[] }>(
        `${GSC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        { method: "POST", body },
      );
      return data.rows ?? [];
    },
    async inspectUrl(
      siteUrl: string,
      inspectionUrl: string,
      languageCode?: string,
    ): Promise<UrlInspectionResult | null> {
      const data = await request<{ inspectionResult?: UrlInspectionResult }>(
        "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
        {
          method: "POST",
          body: {
            siteUrl,
            inspectionUrl,
            ...(languageCode ? { languageCode } : {}),
          },
        },
      );
      return data.inspectionResult ?? null;
    },
  };
}

export type GscClient = ReturnType<typeof createGscApiClient>;

export function createGscClient(opts: {
  userId: string;
  gscAccountId?: string;
}): GscClient {
  async function getToken(): Promise<string> {
    let result: { accessToken?: string } | undefined;
    try {
      result = await getAuth().api.getAccessToken({
        body: {
          providerId: GSC_OAUTH_PROVIDER_ID,
          userId: opts.userId,
          ...(opts.gscAccountId ? { accountId: opts.gscAccountId } : {}),
        },
      });
    } catch (error) {
      throw new GscTokenError(
        "Could not mint a Search Console access token (grant revoked or expired).",
        error,
      );
    }
    if (!result?.accessToken) {
      throw new GscTokenError(
        "Search Console returned no access token (grant revoked or expired).",
      );
    }
    return result.accessToken;
  }

  return createGscApiClient(getToken, async () => {
    const token = await getToken();
    let response: Response;
    try {
      response = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      throw new GscApiError(
        503,
        "Google user info is temporarily unavailable.",
        error instanceof Error ? error.message : undefined,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new GscApiError(
        response.status,
        messageForStatus(response.status, body),
        body,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GscApiError(
        502,
        "Google user info returned an invalid response.",
      );
    }
    const parsed = z
      .object({ email: z.string().optional() })
      .safeParse(payload);
    return parsed.success ? (parsed.data.email ?? null) : null;
  });
}

/** Server-only client. Its JWT assertion has only webmasters.readonly. */
export function createGscServiceAccountClient(
  config: GscServiceAccountProjectConfig,
): GscClient {
  return createGscApiClient(
    createServiceAccountTokenProvider(config.credentials),
    async () => config.credentials.clientEmail,
  );
}
