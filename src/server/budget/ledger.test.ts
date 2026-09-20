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

const exactReservedApiResponse = {
  reservationId: "31e3c898-2513-4503-a673-ee05a42da18d",
  status: "reserved",
  reservedCents: 15,
  actualCents: null,
  remainingCents: 1485,
  replayed: false,
  requestId: "11111111-1111-4111-8111-111111111111",
} as const;

describe("SEO budget ledger", () => {
  it("accepts the exact SQL/API null cost before mock provider dispatch", async () => {
    const providerDispatch = vi.fn().mockResolvedValue({ rows: [] });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(exactReservedApiResponse));
    vi.stubGlobal("fetch", fetchMock);

    const reservation = await reserveSeoBudget({
      projectId: "project-1",
      tool: "dataforseo:keyword_research",
      provider: "dataforseo",
      category: "research",
    });
    await providerDispatch(reservation);

    expect(reservation).toMatchObject({
      reservationId: exactReservedApiResponse.reservationId,
      status: "reserved",
      actualCents: null,
      replayed: false,
    });
    expect(providerDispatch).toHaveBeenCalledOnce();
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
          ...exactReservedApiResponse,
          reservationId: "r-1",
          reservedCents: 500,
          remainingCents: 1000,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...exactReservedApiResponse,
          reservationId: "r-2",
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

  it("continues once after a timed-out POST reconciles as reserved", async () => {
    const providerDispatch = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(
        Response.json({
          reservationId: exactReservedApiResponse.reservationId,
          operationId: "operation-timeout",
          projectId: "project-1",
          tool: "dataforseo:keyword_research",
          category: "research",
          status: "reserved",
          reservedCents: 15,
          actualCents: null,
          replayed: true,
          requestId: "22222222-2222-4222-8222-222222222222",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const reservation = await reserveSeoBudget({
      projectId: "project-1",
      tool: "dataforseo:keyword_research",
      provider: "dataforseo",
      category: "research",
      operationId: "operation-timeout",
    });
    await providerDispatch(reservation);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://control.example/api/internal/seo/reservations/by-operation/operation-timeout",
    );
    expect(reservation).toMatchObject({
      status: "reserved",
      actualCents: null,
      replayed: true,
    });
    expect(providerDispatch).toHaveBeenCalledOnce();
  });

  it.each([
    ["reserved replay", "reserved", null, true],
    ["settled", "settled", 12, true],
    ["uncertain", "uncertain", null, true],
    ["released", "released", 0, true],
  ] as const)(
    "refuses %s before provider dispatch",
    async (_label, status, actualCents, replayed) => {
      const providerDispatch = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            reservationId: exactReservedApiResponse.reservationId,
            status,
            reservedCents: 15,
            actualCents,
            replayed,
            requestId: "33333333-3333-4333-8333-333333333333",
          }),
        ),
      );

      await expect(
        reserveSeoBudget({
          projectId: "project-1",
          tool: "dataforseo:keyword_research",
          provider: "dataforseo",
          category: "research",
          operationId: "operation-replay",
        }).then(providerDispatch),
      ).rejects.toThrow("not dispatchable");
      expect(providerDispatch).not.toHaveBeenCalled();
    },
  );

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
