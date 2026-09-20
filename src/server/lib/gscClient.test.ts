import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  env: {} as Record<string, string | undefined>,
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: mocks.getAccessToken } }),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: (name: string) => Promise.resolve(mocks.env[name]),
}));

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function bytesToPem(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  const base64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

async function generatePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return bytesToPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtPayload(assertion: string): Record<string, unknown> {
  const payload = assertion.split(".")[1];
  if (!payload) throw new Error("JWT payload missing");
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const parsed: unknown = JSON.parse(atob(padded));
  if (!isRecord(parsed)) {
    throw new Error("JWT payload is not an object");
  }
  return parsed;
}

describe("gscClient", () => {
  beforeEach(() => {
    mocks.env = {};
    mocks.getAccessToken.mockReset();
    mocks.getAccessToken.mockResolvedValue({ accessToken: "tok_123" });
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists sites with a bearer token", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({
        siteEntry: [{ siteUrl: "https://x/", permissionLevel: "siteOwner" }],
      }),
    );
    const { createGscClient } = await import("./gscClient");
    const sites = await createGscClient({ userId: "u1" }).listSites();

    expect(sites).toHaveLength(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/webmasters/v3/sites");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok_123" });
  });

  it("targets the selected Better Auth grant by Google sub", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ siteEntry: [] }));
    const { createGscClient } = await import("./gscClient");

    await createGscClient({
      userId: "u1",
      gscAccountId: "google-sub-a",
    }).listSites();

    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      body: {
        providerId: "google-search-console",
        userId: "u1",
        accountId: "google-sub-a",
      },
    });
  });

  it("omits accountId for the legacy null-account fallback", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ siteEntry: [] }));
    const { createGscClient } = await import("./gscClient");

    await createGscClient({ userId: "u1" }).listSites();

    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      body: { providerId: "google-search-console", userId: "u1" },
    });
  });

  it("fetches the Google account email from userinfo", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ email: "client@example.com" }),
    );
    const { createGscClient } = await import("./gscClient");

    const email = await createGscClient({
      userId: "u1",
      gscAccountId: "google-sub-a",
    }).getUserInfoEmail();

    expect(email).toBe("client@example.com");
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok_123" });
  });

  it("encodes the siteUrl in the searchAnalytics path (both property forms)", async () => {
    mocks.fetch.mockImplementation(async () => jsonResponse({ rows: [] }));
    const { createGscClient } = await import("./gscClient");
    const client = createGscClient({ userId: "u1" });

    await client.querySearchAnalytics("sc-domain:example.com", {
      startDate: "2026-01-01",
      endDate: "2026-01-28",
    });
    expect(mocks.fetch.mock.calls[0][0]).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    );

    await client.querySearchAnalytics("https://example.com/", {
      startDate: "2026-01-01",
      endDate: "2026-01-28",
    });
    expect(mocks.fetch.mock.calls[1][0]).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query",
    );
  });

  it("posts to the URL Inspection endpoint and returns the result", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({
        inspectionResult: {
          indexStatusResult: { verdict: "PASS", coverageState: "Indexed" },
        },
      }),
    );
    const { createGscClient } = await import("./gscClient");
    const result = await createGscClient({ userId: "u1" }).inspectUrl(
      "sc-domain:example.com",
      "https://example.com/post",
      "en-US",
    );

    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe(
      "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok_123" });
    const body = init?.body;
    const payload =
      typeof body === "string" ? (JSON.parse(body) as unknown) : null;
    expect(payload).toEqual({
      siteUrl: "sc-domain:example.com",
      inspectionUrl: "https://example.com/post",
      languageCode: "en-US",
    });
    expect(result?.indexStatusResult?.verdict).toBe("PASS");
  });

  it("maps 403 to a no-access GscApiError", async () => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse({ error: "forbidden" }, 403),
    );
    const { createGscClient, GscApiError } = await import("./gscClient");
    await expect(
      createGscClient({ userId: "u1" }).listSites(),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createGscClient({ userId: "u1" }).listSites(),
    ).rejects.toBeInstanceOf(GscApiError);
  });

  it("maps 429 to a rate-limit GscApiError", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ error: "slow down" }, 429));
    const { createGscClient } = await import("./gscClient");
    await expect(
      createGscClient({ userId: "u1" }).listSites(),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("throws GscTokenError when no access token can be minted", async () => {
    mocks.getAccessToken.mockRejectedValue(new Error("revoked"));
    const { createGscClient, GscTokenError } = await import("./gscClient");
    await expect(
      createGscClient({ userId: "u1" }).listSites(),
    ).rejects.toBeInstanceOf(GscTokenError);
  });

  it("leaves OAuth as the only source when no service mapping exists", async () => {
    const { getGscServiceAccountProjectConfig } = await import("./gscClient");

    await expect(
      getGscServiceAccountProjectConfig("11111111-1111-4111-8111-111111111111"),
    ).resolves.toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on malformed mapped credentials before network access", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    mocks.env.GSC_SERVICE_ACCOUNT_PROJECTS_JSON = JSON.stringify({
      [projectId]: "sc-domain:example.com",
    });
    mocks.env.GSC_SERVICE_ACCOUNT_JSON = "{not-json";
    const { getGscServiceAccountProjectConfig, GscServiceAccountError } =
      await import("./gscClient");

    await expect(
      getGscServiceAccountProjectConfig(projectId),
    ).rejects.toBeInstanceOf(GscServiceAccountError);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("mints a service token with only the Search Console read-only scope", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    mocks.env.GSC_SERVICE_ACCOUNT_PROJECTS_JSON = JSON.stringify({
      [projectId]: "sc-domain:example.com",
    });
    mocks.env.GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: "service_account",
      client_email: "seo-reader@example.iam.gserviceaccount.com",
      private_key: await generatePrivateKeyPem(),
      token_uri: "https://oauth2.googleapis.com/token",
    });
    mocks.fetch
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "service-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          siteEntry: [
            { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          ],
        }),
      );
    const {
      createGscServiceAccountClient,
      getGscServiceAccountProjectConfig,
      GSC_SERVICE_ACCOUNT_SCOPE,
    } = await import("./gscClient");
    const config = await getGscServiceAccountProjectConfig(projectId);
    if (!config) throw new Error("service account config missing");

    await expect(
      createGscServiceAccountClient(config).listSites(),
    ).resolves.toHaveLength(1);

    const [tokenUrl, tokenInit] = mocks.fetch.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    const tokenBody = tokenInit?.body;
    if (!(tokenBody instanceof URLSearchParams)) {
      throw new Error("token body is not URLSearchParams");
    }
    const assertion = tokenBody.get("assertion");
    if (!assertion) throw new Error("service assertion missing");
    expect(decodeJwtPayload(assertion)).toMatchObject({
      iss: "seo-reader@example.iam.gserviceaccount.com",
      scope: GSC_SERVICE_ACCOUNT_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(decodeJwtPayload(assertion).scope).not.toContain("userinfo");
    const [, sitesInit] = mocks.fetch.mock.calls[1];
    expect(sitesInit?.headers).toMatchObject({
      Authorization: "Bearer service-token",
    });
  });
});
