import { describe, expect, it, vi } from "vitest";
import {
  type BudgetDependencies,
  runBudgetedCompaction,
  SamStepBudget,
} from "@/server/features/sam/samProviderBudget";
import type { BudgetReservation } from "@/server/budget/ledger";

function reservation(id: string): BudgetReservation {
  return {
    reservationId: id,
    operationId: `operation-${id}`,
    status: "reserved" as const,
    reservedCents: 100,
  };
}

describe("SAM provider budget", () => {
  it("reserves and settles two model steps plus one compaction separately", async () => {
    const events: string[] = [];
    let reservationIndex = 0;
    const dependencies: BudgetDependencies = {
      reserve: vi.fn<BudgetDependencies["reserve"]>(async ({ tool }) => {
        events.push(`reserve:${tool}`);
        reservationIndex += 1;
        return reservation(`r-${reservationIndex}`);
      }),
      commit: vi.fn<BudgetDependencies["commit"]>(async (entry, cents) => {
        events.push(`commit:${entry.reservationId}:${cents}`);
      }),
      uncertain: vi.fn<BudgetDependencies["uncertain"]>(async () => {}),
    };
    const steps = new SamStepBudget("project-1", dependencies);

    await steps.reserveBeforeStep([{ role: "user", content: "first" }]);
    events.push("network:step-1");
    await steps.settleCompletedStep(0.011);
    await steps.reserveBeforeStep([{ role: "assistant", content: "second" }]);
    events.push("network:step-2");
    await steps.settleCompletedStep(0.022);
    await runBudgetedCompaction({
      projectId: "project-1",
      prompt: "compact this transcript",
      execute: async () => {
        events.push("network:compaction");
        return { costUsd: 0.033 };
      },
      costUsd: (result) => result.costUsd,
      dependencies,
    });

    expect(events).toEqual([
      "reserve:openrouter:sam-step",
      "network:step-1",
      "commit:r-1:2",
      "reserve:openrouter:sam-step",
      "network:step-2",
      "commit:r-2:3",
      "reserve:openrouter:sam-compaction",
      "network:compaction",
      "commit:r-3:4",
    ]);
  });

  it("marks a timed-out compaction uncertain without a second generation", async () => {
    const execute = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const uncertain = vi.fn<BudgetDependencies["uncertain"]>(async () => {});
    const dependencies: BudgetDependencies = {
      reserve: vi.fn<BudgetDependencies["reserve"]>(async () =>
        reservation("r-timeout"),
      ),
      commit: vi.fn<BudgetDependencies["commit"]>(async () => {}),
      uncertain,
    };

    await expect(
      runBudgetedCompaction({
        projectId: "project-1",
        prompt: "compact",
        execute,
        costUsd: () => 0,
        dependencies,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(execute).toHaveBeenCalledOnce();
    expect(uncertain).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "r-timeout" }),
      "TimeoutError",
    );
  });

  it("keeps a timed-out model step reserved as uncertain", async () => {
    const uncertain = vi.fn<BudgetDependencies["uncertain"]>(async () => {});
    const dependencies: BudgetDependencies = {
      reserve: vi.fn<BudgetDependencies["reserve"]>(async () =>
        reservation("r-step-timeout"),
      ),
      commit: vi.fn<BudgetDependencies["commit"]>(async () => {}),
      uncertain,
    };
    const steps = new SamStepBudget("project-1", dependencies);

    await steps.reserveBeforeStep([{ role: "user", content: "work" }]);
    await steps.markActiveUncertain("TimeoutError");

    expect(uncertain).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "r-step-timeout" }),
      "TimeoutError",
    );
    expect(steps.hasActiveReservation).toBe(false);
  });

  it("stops before the next model call when its reservation is denied", async () => {
    const reserve = vi
      .fn<BudgetDependencies["reserve"]>()
      .mockResolvedValueOnce(reservation("r-1"))
      .mockRejectedValueOnce(new Error("budget denied"));
    const dependencies: BudgetDependencies = {
      reserve,
      commit: vi.fn<BudgetDependencies["commit"]>(async () => {}),
      uncertain: vi.fn<BudgetDependencies["uncertain"]>(async () => {}),
    };
    const steps = new SamStepBudget("project-1", dependencies);
    const secondNetworkCall = vi.fn();

    await steps.reserveBeforeStep([]);
    await steps.settleCompletedStep(0.01);
    await expect(steps.reserveBeforeStep([])).rejects.toThrow("budget denied");
    expect(secondNetworkCall).not.toHaveBeenCalled();
  });
});
