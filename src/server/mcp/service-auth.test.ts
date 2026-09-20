import { beforeEach, describe, expect, it, vi } from "vitest";

type ServicePropsFixture = {
  openSeoAuth: {
    servicePolicy: {
      allowedProjectIds: string[];
      allowedTools: string[];
    };
  };
};

const mocks = vi.hoisted(() => ({
  resolveSharedWorkspaceContext: vi.fn(),
  handlePinnedOpenSeoMcpRequest:
    vi.fn<
      (
        request: Request,
        props: ServicePropsFixture,
        env: object,
        ctx: ExecutionContext,
      ) => Promise<Response>
    >(),
  verifyCloudflareAccessPayload: vi.fn(),
}));

vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  verifyCloudflareAccessPayload: mocks.verifyCloudflareAccessPayload,
}));

vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveSharedWorkspaceContext: mocks.resolveSharedWorkspaceContext,
}));

vi.mock("@/server/mcp/transport", () => ({
  handlePinnedOpenSeoMcpRequest: mocks.handlePinnedOpenSeoMcpRequest,
}));

import { handleMcpServiceRequest } from "@/server/mcp/service-auth";

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

const env = {
  OPENSEO_SERVICE_TOKEN: "service-secret",
  OPENSEO_SERVICE_EMAIL: "automation@example.com",
  OPENSEO_SERVICE_PROJECT_IDS: "project-1,project-2",
  OPENSEO_SERVICE_TOOLS: "whoami,research_keywords",
  SERVICE_POLICY_AUD: "service-audience",
};

describe("MCP service authentication", () => {
  beforeEach(() => {
    mocks.resolveSharedWorkspaceContext.mockResolvedValue({
      userId: "service-user",
      userEmail: "automation@example.com",
      organizationId: "shared-org",
    });
    mocks.handlePinnedOpenSeoMcpRequest.mockResolvedValue(
      Response.json({ ok: true }),
    );
    mocks.verifyCloudflareAccessPayload.mockResolvedValue({
      common_name: "service.access",
    });
  });

  it("pins the service identity to configured projects and tools", async () => {
    const response = await handleMcpServiceRequest(
      new Request("https://seo.example/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer service-secret" },
      }),
      env,
      ctx,
    );

    expect(response?.status).toBe(200);
    const props = mocks.handlePinnedOpenSeoMcpRequest.mock.calls[0]?.[1];
    expect(props?.openSeoAuth.servicePolicy).toEqual({
      allowedProjectIds: ["project-1", "project-2"],
      allowedTools: ["whoami", "research_keywords"],
    });
  });

  it("accepts the dedicated token header when an edge proxy owns Authorization", async () => {
    const response = await handleMcpServiceRequest(
      new Request("https://seo.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer edge-owned-token",
          "X-OpenSEO-Service-Token": "service-secret",
        },
      }),
      env,
      ctx,
    );

    expect(response?.status).toBe(200);
    expect(mocks.handlePinnedOpenSeoMcpRequest).toHaveBeenCalledOnce();
  });

  it("does not consume another credential's bearer token", async () => {
    const response = await handleMcpServiceRequest(
      new Request("https://seo.example/mcp", {
        headers: { Authorization: "Bearer another-token" },
      }),
      env,
      ctx,
    );

    expect(response).toBeNull();
    expect(mocks.handlePinnedOpenSeoMcpRequest).not.toHaveBeenCalled();
  });

  it("fails closed when either allowlist is empty", async () => {
    const response = await handleMcpServiceRequest(
      new Request("https://seo.example/mcp", {
        headers: { Authorization: "Bearer service-secret" },
      }),
      { ...env, OPENSEO_SERVICE_PROJECT_IDS: "" },
      ctx,
    );

    expect(response?.status).toBe(503);
    expect(mocks.handlePinnedOpenSeoMcpRequest).not.toHaveBeenCalled();
  });
});
