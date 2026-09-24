import { AppError } from "@/server/lib/errors";

export function assertPaidInteger(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
}

export function assertPaidArrayLength(
  name: string,
  value: readonly unknown[],
  min: number,
  max: number,
): void {
  assertPaidInteger(`${name} length`, value.length, min, max);
}

export function assertPaidStringLength(
  name: string,
  value: string,
  min: number,
  max: number,
): void {
  assertPaidInteger(`${name} length`, value.length, min, max);
}
