import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

const reservationSchema = z.object({
  reservationId: z.string().min(1),
  status: z.enum(["reserved", "settled", "uncertain", "released"]),
  reservedCents: z.number().int().nonnegative(),
  actualCents: z.number().int().nonnegative().nullable().optional(),
  remainingCents: z.number().int().optional(),
  replayed: z.boolean(),
});

const paidOperationLimitsSchema = z.record(
  z.string().min(1),
  z.number().int().positive(),
);

export type SeoBudgetCategory =
  | "research"
  | "writing"
  | "infrastructure"
  | "reserve";

export type BudgetReservation = z.infer<typeof reservationSchema> & {
  operationId: string;
};

const LEDGER_TIMEOUT_MS = 5_000;

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function config(): Promise<{
  baseUrl: string;
  token: string;
  paidOperationLimits: Record<string, number>;
}> {
  const [baseUrl, tokenV2, tokenV1, limitsJson] = await Promise.all([
    getOptionalEnvValue("SEO_LEDGER_BASE_URL"),
    getOptionalEnvValue("SEO_LEDGER_TOKEN_V2"),
    getOptionalEnvValue("SEO_LEDGER_TOKEN"),
    getOptionalEnvValue("SEO_PAID_OPERATION_LIMITS_JSON"),
  ]);
  const token = tokenV2 ?? tokenV1;
  const parsedLimits = paidOperationLimitsSchema.safeParse(
    parseJson(limitsJson ?? "{}"),
  );
  if (!baseUrl || !token || !parsedLimits.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "SEO budget ledger or paid-operation limits are not configured; paid operation refused",
    );
  }
  return { baseUrl, token, paidOperationLimits: parsedLimits.data };
}

export async function assertPaidOperationsEnabled(
  tools: readonly string[],
): Promise<void> {
  const { paidOperationLimits } = await config();
  const missing = tools.find((tool) => paidOperationLimits[tool] === undefined);
  if (missing) {
    throw new AppError(
      "FORBIDDEN",
      `Opération payante indisponible : aucun plafond vérifié pour ${missing}`,
    );
  }
}

async function ledgerFetch(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
  });
}

async function readReservation(
  response: Response,
  operationId: string,
): Promise<BudgetReservation> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AppError(
      response.status === 409 || response.status === 402
        ? "INSUFFICIENT_CREDITS"
        : "UPSTREAM_UNAVAILABLE",
      `SEO budget ledger refused operation (${response.status})`,
    );
  }
  const parsed = reservationSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "SEO budget ledger returned an invalid response",
    );
  }
  return { ...parsed.data, operationId };
}

function requireDispatchableReservation(
  reservation: BudgetReservation,
  expectReconciledReplay: boolean,
): BudgetReservation {
  if (
    reservation.status !== "reserved" ||
    reservation.replayed !== expectReconciledReplay
  ) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `SEO budget reservation is not dispatchable (${reservation.status}${reservation.replayed ? ", replayed" : ""})`,
    );
  }
  return reservation;
}

async function reconcileReservation(
  baseUrl: string,
  token: string,
  operationId: string,
): Promise<BudgetReservation> {
  const response = await ledgerFetch(
    endpoint(
      baseUrl,
      `/api/internal/seo/reservations/by-operation/${encodeURIComponent(operationId)}`,
    ),
    token,
  );
  return readReservation(response, operationId);
}

export async function reserveSeoBudget(args: {
  projectId: string | undefined;
  tool: string;
  provider: string;
  category: SeoBudgetCategory;
  operationId?: string;
}): Promise<BudgetReservation> {
  if (!args.projectId) {
    throw new AppError(
      "FORBIDDEN",
      "Paid SEO operations require an explicitly authorized project",
    );
  }
  const { baseUrl, token, paidOperationLimits } = await config();
  const estimatedCents = paidOperationLimits[args.tool];
  if (estimatedCents === undefined) {
    throw new AppError(
      "FORBIDDEN",
      `Paid operation ${args.tool} is disabled until a reviewed maximum cost is configured`,
    );
  }
  const operationId = args.operationId ?? crypto.randomUUID();
  const body = {
    operationId,
    projectId: args.projectId,
    tool: args.tool,
    category: args.category,
    estimatedCents,
    externalOperationId: `${args.provider}:${operationId}`,
  };

  try {
    const response = await ledgerFetch(
      endpoint(baseUrl, "/api/internal/seo/reservations"),
      token,
      {
        method: "POST",
        headers: { "Idempotency-Key": operationId },
        body: JSON.stringify(body),
      },
    );
    return requireDispatchableReservation(
      await readReservation(response, operationId),
      false,
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    // A timed-out POST may have committed. Never replay it: query the
    // idempotency key once, then fail before contacting the paid provider.
    try {
      return requireDispatchableReservation(
        await reconcileReservation(baseUrl, token, operationId),
        true,
      );
    } catch {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `SEO budget reservation state is unknown for operation ${operationId}`,
      );
    }
  }
}

async function settle(
  reservation: BudgetReservation,
  body:
    | { outcome: "committed" | "released"; actualCents: number }
    | { outcome: "uncertain"; reason: string },
): Promise<void> {
  const { baseUrl, token } = await config();
  const uncertain = body.outcome === "uncertain";
  const response = await ledgerFetch(
    endpoint(
      baseUrl,
      `/api/internal/seo/reservations/${encodeURIComponent(reservation.reservationId)}/${uncertain ? "uncertain" : "settle"}`,
    ),
    token,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": `${uncertain ? "uncertain" : "settle"}:${reservation.reservationId}`,
      },
      body: JSON.stringify(
        uncertain
          ? { reason: body.reason }
          : {
              actualCents: body.actualCents,
              externalOperationId:
                body.outcome === "released"
                  ? `${reservation.operationId}:released`
                  : reservation.operationId,
            },
      ),
    },
  );
  if (!response.ok) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `SEO budget settlement failed (${response.status})`,
    );
  }
}

export function commitSeoBudget(
  reservation: BudgetReservation,
  actualCents: number,
): Promise<void> {
  return settle(reservation, {
    outcome: "committed",
    actualCents: Math.max(0, Math.ceil(actualCents)),
  });
}

export function releaseSeoBudget(
  reservation: BudgetReservation,
  _reason: string,
): Promise<void> {
  return settle(reservation, { outcome: "released", actualCents: 0 });
}

export function markSeoBudgetUncertain(
  reservation: BudgetReservation,
  reason: string,
): Promise<void> {
  return settle(reservation, { outcome: "uncertain", reason });
}

// Conservatively treat USD and EUR at parity, then round upward. The central
// ledger records any actual overrun as debt and freezes the category.
export function providerUsdToCents(costUsd: number): number {
  return Math.ceil(Math.max(0, costUsd) * 100);
}
