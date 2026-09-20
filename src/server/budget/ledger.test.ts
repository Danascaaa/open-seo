import { afterEach, describe, expect, it, vi } from "vitest";
import { providerUsdToCents, reserveSeoBudget } from "@/server/budget/ledger";

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn((name: string) =>
    Promise.resolve(
      name === "SEO_LEDGER_BASE_URL"
        ? "https://control.example"
        : name === "SEO_LEDGER_TOKEN"
          ? "secret"
          : name === "SEO_PAID_OPERATION_LIMITS_JSON"
            ? JSON.stringify({
                "dataforseo:keyword_research": 500,
                "dataforseo:fetchLiveSerp": 500,
                "dataforseo:fetchKeywordIdeas": 500,
              })
            : undefined,
    ),
  ),
}));

afterEach(() => vi.unstubAllGlobals());

describe("SEO budget ledger", () => {
  it("reserves a conservative call ceiling before a paid call", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        reservationId: "r-1",
        status: "reserved",
        reservedCents: 500,
        remainingCents: 1000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const reservation = await reserveSeoBudget({
      projectId: "project-1",
      tool: "dataforseo:keyword_research",
      provider: "dataforseo",
      category: "research",
    });

    expect(reservation.reservationId).toBe("r-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      projectId: "project-1",
      estimatedCents: 500,
    });
  });

  it("can reserve a second call after the first settles cheaply", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          reservationId: "r-1",
          status: "reserved",
          reservedCents: 500,
          remainingCents: 1000,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          reservationId: "r-2",
          status: "reserved",
          reservedCents: 500,
          remainingCents: 999,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await reserveSeoBudget({
      projectId: "project-1",
      tool: "dataforseo:fetchLiveSerp",
      provider: "dataforseo",
      category: "research",
    });
    await reserveSeoBudget({
      projectId: "project-1",
      tool: "dataforseo:fetchKeywordIdeas",
      provider: "dataforseo",
      category: "research",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed before network when project scope is absent", async () => {
    await expect(
      reserveSeoBudget({
        projectId: undefined,
        tool: "dataforseo:backlinks",
        provider: "dataforseo",
        category: "research",
      }),
    ).rejects.toThrow("explicitly authorized project");
  });

  it("disables an unknown paid operation before provider dispatch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reserveSeoBudget({
        projectId: "project-1",
        tool: "dataforseo:unpriced",
        provider: "dataforseo",
        category: "research",
      }),
    ).rejects.toThrow("disabled until a reviewed maximum cost is configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rounds provider spend upward to cents", () => {
    expect(providerUsdToCents(0.0001)).toBe(1);
    expect(providerUsdToCents(1.234)).toBe(124);
  });
});
