import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GSC_SERVICE_ACCOUNT_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_SKEW_MS = 60_000;

export class GscServiceAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GscServiceAccountError";
  }
}

function safeFetchFailureKind(error: unknown): string {
  if (!(error instanceof Error)) return "network error";
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return "timeout";
  }
  const message = error.message.toLowerCase();
  if (message.includes("redirect")) return "redirect blocked";
  if (message.includes("signal")) return "invalid abort signal";
  return error instanceof TypeError ? "fetch type error" : "network error";
}

type ServiceAccountCredentials = {
  clientEmail: string;
  privateKey: string;
};

export type GscServiceAccountProjectConfig = {
  siteUrl: string;
  credentials: ServiceAccountCredentials;
};

const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().email(),
  private_key: z.string().min(1),
  token_uri: z.literal(GOOGLE_TOKEN_URL),
});

const siteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isGscPropertyUrl, "Invalid Search Console property URL");
const projectMapSchema = z.record(z.string().uuid(), siteUrlSchema);

function isGscPropertyUrl(value: string): boolean {
  if (/^sc-domain:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new GscServiceAccountError(`${label} is not valid JSON.`);
  }
}

/** Resolve a server-managed project without affecting OAuth-only projects. */
export async function getGscServiceAccountProjectConfig(
  projectId: string,
): Promise<GscServiceAccountProjectConfig | null> {
  const rawProjectMap = await getOptionalEnvValue(
    "GSC_SERVICE_ACCOUNT_PROJECTS_JSON",
  );
  if (!rawProjectMap) return null;

  const parsedProjectMap = projectMapSchema.safeParse(
    parseJson(rawProjectMap, "GSC_SERVICE_ACCOUNT_PROJECTS_JSON"),
  );
  if (!parsedProjectMap.success) {
    throw new GscServiceAccountError(
      "GSC_SERVICE_ACCOUNT_PROJECTS_JSON has an invalid project-to-property mapping.",
    );
  }
  const siteUrl = parsedProjectMap.data[projectId];
  if (!siteUrl) return null;

  const rawCredentials = await getOptionalEnvValue("GSC_SERVICE_ACCOUNT_JSON");
  if (!rawCredentials) {
    throw new GscServiceAccountError(
      "GSC_SERVICE_ACCOUNT_JSON is required for a mapped Search Console project.",
    );
  }
  const parsedCredentials = serviceAccountSchema.safeParse(
    parseJson(rawCredentials, "GSC_SERVICE_ACCOUNT_JSON"),
  );
  if (!parsedCredentials.success) {
    throw new GscServiceAccountError(
      "GSC_SERVICE_ACCOUNT_JSON is not a valid Google service-account credential.",
    );
  }
  return {
    siteUrl,
    credentials: {
      clientEmail: parsedCredentials.data.client_email,
      privateKey: parsedCredentials.data.private_key,
    },
  };
}

/** Invalid service config counts as configured so callers reach its fail-closed
 * error instead of silently suggesting or using OAuth. */
export async function hasGscServiceAccountProjectConfig(
  projectId: string,
): Promise<boolean> {
  try {
    return (await getGscServiceAccountProjectConfig(projectId)) !== null;
  } catch {
    return true;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function privateKeyBytes(pem: string): ArrayBuffer {
  const match =
    /^-----BEGIN PRIVATE KEY-----\s+([\s\S]+?)\s+-----END PRIVATE KEY-----$/.exec(
      pem.trim(),
    );
  if (!match?.[1]) {
    throw new GscServiceAccountError(
      "GSC service-account private_key must be a PKCS#8 PEM value.",
    );
  }
  try {
    const binary = atob(match[1].replaceAll(/\s/g, ""));
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return buffer;
  } catch {
    throw new GscServiceAccountError(
      "GSC service-account private_key contains invalid base64.",
    );
  }
}

async function createAssertion(
  credentials: ServiceAccountCredentials,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signingInput = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(
    {
      iss: credentials.clientEmail,
      scope: GSC_SERVICE_ACCOUNT_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    },
  )}`;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes(credentials.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
  } catch (error) {
    if (error instanceof GscServiceAccountError) throw error;
    throw new GscServiceAccountError(
      "GSC service-account private_key could not sign an assertion.",
    );
  }
}

export function createServiceAccountTokenProvider(
  credentials: ServiceAccountCredentials,
): () => Promise<string> {
  let cached: { accessToken: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }

    const assertion = await createAssertion(credentials);
    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        // Cloudflare Workers rejects redirect:"error" before dispatch. Manual
        // preserves the same security boundary: never follow a response that
        // could forward the signed assertion to another origin.
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
    } catch (error) {
      throw new GscServiceAccountError(
        `Google service-account token exchange is unavailable (${safeFetchFailureKind(error)}).`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new GscServiceAccountError(
        "Google service-account token exchange refused a redirect.",
      );
    }
    if (!response.ok) {
      throw new GscServiceAccountError(
        `Google rejected the service-account token exchange (${response.status}).`,
      );
    }

    let tokenPayload: unknown;
    try {
      tokenPayload = await response.json();
    } catch {
      throw new GscServiceAccountError(
        "Google returned an invalid service-account token response.",
      );
    }
    const parsed = z
      .object({
        access_token: z.string().min(1),
        expires_in: z.number().positive().optional(),
      })
      .safeParse(tokenPayload);
    if (!parsed.success) {
      throw new GscServiceAccountError(
        "Google returned an invalid service-account token response.",
      );
    }
    cached = {
      accessToken: parsed.data.access_token,
      expiresAt: Date.now() + (parsed.data.expires_in ?? 3600) * 1000,
    };
    return cached.accessToken;
  };
}
