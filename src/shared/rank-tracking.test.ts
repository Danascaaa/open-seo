import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeNextCheckAt,
  estimateRankCheckCredits,
  scheduleLabel,
} from "./rank-tracking";

describe("rank tracking cost estimates", () => {
  it.each([
    {
      method: "live" as const,
      keywordCount: 4,
      devices: "desktop" as const,
      depth: 10,
      costUsd: 0.01024,
      costCredits: 12,
    },
    {
      method: "live" as const,
      keywordCount: 1000,
      devices: "both" as const,
      depth: 40,
      costUsd: 20.48,
      costCredits: 22_000,
    },
    {
      method: "queued" as const,
      keywordCount: 104,
      devices: "desktop" as const,
      depth: 10,
      costUsd: 0.07987,
      costCredits: 81,
    },
    {
      method: "queued" as const,
      keywordCount: 1000,
      devices: "both" as const,
      depth: 40,
      costUsd: 6.144,
      costCredits: 6_160,
    },
  ])(
    "matches per-call billing for $method checks",
    ({ keywordCount, devices, depth, method, costUsd, costCredits }) => {
      expect(
        estimateRankCheckCredits(keywordCount, devices, depth, method),
      ).toEqual({ costUsd, costCredits });
    },
  );
});

describe("rank tracking SERP pages", () => {
  it.each([
    { depth: 1, pages: 1 },
    { depth: 10, pages: 1 },
    { depth: 11, pages: 2 },
    { depth: 100, pages: 10 },
    { depth: 101, pages: 10 },
  ])("clamps depth $depth to $pages billable pages", ({ depth, pages }) => {
    expect(
      estimateRankCheckCredits(1, "desktop", depth, "queued").costUsd,
    ).toBeCloseTo(pages * 0.0006 * 1.28);
    expect(
      estimateRankCheckCredits(1, "desktop", depth, "live").costUsd,
    ).toBeCloseTo(pages * 0.002 * 1.28);
  });
});

describe("rank tracking schedules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels monthly schedules", () => {
    expect(scheduleLabel("monthly")).toBe("Monthly");
  });

  it("schedules new monthly configs for the end of the current month", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0);

    expect(computeNextCheckAt("monthly")).toBe("2026-01-31T04:00:00.000Z");
  });

  it("moves new monthly configs to next month when this month's run time has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T10:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0);

    expect(computeNextCheckAt("monthly")).toBe("2026-02-28T04:00:00.000Z");
  });

  it("advances monthly schedules on month end across shorter months", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    expect(computeNextCheckAt("monthly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-02-28T05:30:00.000Z",
    );
  });

  it("keeps advancing monthly schedules until the next check is in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    expect(computeNextCheckAt("monthly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-03-31T05:30:00.000Z",
    );
  });

  it("preserves the time-of-day anchor for heavily overdue daily schedules", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));

    expect(computeNextCheckAt("daily", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-03-11T05:30:00.000Z",
    );
  });

  it("preserves the weekday and time anchor for heavily overdue weekly schedules", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));

    // 2026-01-31 is a Saturday; every advance lands on a Saturday.
    expect(computeNextCheckAt("weekly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-03-14T05:30:00.000Z",
    );
  });
});
