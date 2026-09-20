import { MCP_SCOPE } from "@/lib/oauth-resource";
import { getAuthMode } from "@/lib/auth-mode";
import { resolveSharedWorkspaceContext } from "@/middleware/ensure-user/delegated";
import { getEnvValueSync } from "@/server/lib/runtime-env";
import { verifyCloudflareAccessPayload } from "@/middleware/ensure-user/cloudflareAccess";
import { createWorkersOAuthMcpProps, MCP_ROUTE } from "@/server/mcp/context";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import { handlePinnedOpenSeoMcpRequest } from "@/server/mcp/transport";

const SERVICE_USER_ID = "btpscale-seo-automation";

const digestToken = async (value: string) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );

function csv(value: string | undefined): string[] {
  return [
    ...new Set((value ?? "").split(",").map((item) => item.trim())),
  ].filter(Boolean);
}

async function tokensEqual(
  candidate: string,
  expected: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    digestToken(candidate),
    digestToken(expected),
  ]);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function handleMcpServiceRequest(
  request: Request,
  env: object,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== MCP_ROUTE) return null;
  const expected =
    getEnvValueSync(env, "OPENSEO_SERVICE_TOKEN_V3") ??
    getEnvValueSync(env, "OPENSEO_SERVICE_TOKEN_V2") ??
    getEnvValueSync(env, "OPENSEO_SERVICE_TOKEN");
  const dedicatedToken = request.headers.get("x-openseo-service-token");
  const servicePolicyAud = getEnvValueSync(env, "SERVICE_POLICY_AUD");
  const authMode = getAuthMode(getEnvValueSync(env, "AUTH_MODE"));

  if (authMode === "cloudflare_access") {
    // No service-intent header: leave the request to the normal human MCP
    // authentication path. Bearer alone can never select service auth here.
    if (!dedicatedToken) return null;
    if (!expected || !servicePolicyAud) {
      return new Response("Service authentication is not configured", {
        status: 503,
      });
    }
    if (!(await tokensEqual(dedicatedToken, expected))) {
      return new Response("Invalid service credential", { status: 401 });
    }
    try {
      const payload = await verifyCloudflareAccessPayload(
        request.headers,
        servicePolicyAud,
      );
      if (typeof payload.common_name !== "string" || !payload.common_name) {
        return new Response("Service identity required", { status: 403 });
      }
    } catch {
      return new Response("Service authentication failed", { status: 403 });
    }
  } else {
    // Outside Access, preserve the explicit Bearer compatibility path. An
    // unrelated OAuth/API-key bearer falls through to its normal handler.
    const bearer = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /i, "");
    const candidate = dedicatedToken ?? bearer;
    if (!candidate) return null;
    if (!expected) {
      return dedicatedToken
        ? new Response("Service authentication is not configured", {
            status: 503,
          })
        : null;
    }
    if (!(await tokensEqual(candidate, expected))) {
      return dedicatedToken
        ? new Response("Invalid service credential", { status: 401 })
        : null;
    }
  }

  const email = getEnvValueSync(env, "OPENSEO_SERVICE_EMAIL");
  const allowedProjectIds = csv(
    getEnvValueSync(env, "OPENSEO_SERVICE_PROJECT_IDS"),
  );
  const allowedTools = csv(getEnvValueSync(env, "OPENSEO_SERVICE_TOOLS"));
  if (!email || allowedProjectIds.length === 0 || allowedTools.length === 0) {
    return new Response("Service authorization is incomplete", { status: 503 });
  }

  const identity = await resolveSharedWorkspaceContext(SERVICE_USER_ID, email);
  const props = createWorkersOAuthMcpProps({
    userId: identity.userId,
    userEmail: identity.userEmail,
    organizationId: identity.organizationId,
    role: "owner",
    orgScope: "pinned",
    baseUrl: getPublicOrigin(request),
    scopes: [MCP_SCOPE],
    clientId: "btpscale-seo-service",
    servicePolicy: { allowedProjectIds, allowedTools },
  });
  return handlePinnedOpenSeoMcpRequest(request, props, env, ctx);
}
