import { AppError } from "@/server/lib/errors";
import {
  type BudgetReservation,
  commitSeoBudget,
  markSeoBudgetUncertain,
  providerUsdToCents,
  reserveSeoBudget,
} from "@/server/budget/ledger";

export const SAM_STEP_MESSAGES_MAX_BYTES = 128_000;
export const SAM_COMPACTION_INPUT_MAX_BYTES = 128_000;
export const SAM_COMPACTION_MAX_OUTPUT_TOKENS = 4_000;

export type BudgetDependencies = {
  reserve: typeof reserveSeoBudget;
  commit: typeof commitSeoBudget;
  uncertain: typeof markSeoBudgetUncertain;
};

const defaultBudgetDependencies: BudgetDependencies = {
  reserve: reserveSeoBudget,
  commit: commitSeoBudget,
  uncertain: markSeoBudgetUncertain,
};

function utf8Bytes(payload: unknown): number {
  const serialized =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  if (typeof serialized !== "string") {
    throw new AppError("VALIDATION_ERROR", "Model input is not serializable");
  }
  return new TextEncoder().encode(serialized).byteLength;
}

export function assertModelInputBound(
  payload: unknown,
  maximumBytes: number,
  operation: string,
): void {
  const bytes = utf8Bytes(payload);
  if (bytes > maximumBytes) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${operation} input is ${bytes} UTF-8 bytes, above the ${maximumBytes}-byte paid-operation limit`,
    );
  }
}

export class SamStepBudget {
  private activeReservation: BudgetReservation | null = null;

  constructor(
    private readonly projectId: string,
    private readonly dependencies: BudgetDependencies = defaultBudgetDependencies,
  ) {}

  get hasActiveReservation(): boolean {
    return this.activeReservation !== null;
  }

  async reserveBeforeStep(messages: unknown): Promise<void> {
    assertModelInputBound(
      messages,
      SAM_STEP_MESSAGES_MAX_BYTES,
      "SAM model step",
    );
    if (this.activeReservation) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Previous SAM model step budget is not settled",
      );
    }
    this.activeReservation = await this.dependencies.reserve({
      projectId: this.projectId,
      tool: "openrouter:sam-step",
      provider: "openrouter",
      category: "writing",
    });
  }

  async settleCompletedStep(costUsd: number): Promise<void> {
    const reservation = this.activeReservation;
    if (!reservation) {
      throw new AppError(
        "INTERNAL_ERROR",
        "SAM model step completed without a budget reservation",
      );
    }
    // The provider finished. Clear local state before settlement so a timeout
    // is not followed by a conflicting uncertain mutation. The ledger keeps
    // the reservation held or has already committed it; either state blocks
    // blind replay until reconciliation.
    this.activeReservation = null;
    await this.dependencies.commit(reservation, providerUsdToCents(costUsd));
  }

  async markActiveUncertain(reason: string): Promise<void> {
    const reservation = this.activeReservation;
    if (!reservation) return;
    await this.dependencies.uncertain(reservation, reason);
    this.activeReservation = null;
  }
}

export async function runBudgetedCompaction<T>(args: {
  projectId: string;
  prompt: string;
  execute: () => Promise<T>;
  costUsd: (result: T) => number;
  dependencies?: BudgetDependencies;
}): Promise<{ result: T; costUsd: number }> {
  assertModelInputBound(
    args.prompt,
    SAM_COMPACTION_INPUT_MAX_BYTES,
    "SAM compaction",
  );
  const dependencies = args.dependencies ?? defaultBudgetDependencies;
  const reservation = await dependencies.reserve({
    projectId: args.projectId,
    tool: "openrouter:sam-compaction",
    provider: "openrouter",
    category: "writing",
  });
  let costKnown = false;
  try {
    // Exactly one generation belongs to this reservation.
    const result = await args.execute();
    const costUsd = args.costUsd(result);
    costKnown = true;
    await dependencies.commit(reservation, providerUsdToCents(costUsd));
    return { result, costUsd };
  } catch (error) {
    if (!costKnown) {
      await dependencies
        .uncertain(
          reservation,
          error instanceof Error ? error.name : "compaction provider failure",
        )
        .catch(() => {
          // Keep the original provider error. A failed uncertain write leaves
          // the reservation held and still prevents another paid operation.
        });
    }
    throw error;
  }
}
