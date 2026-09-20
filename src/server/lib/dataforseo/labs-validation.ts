import { AppError } from "@/server/lib/errors";

export function assertPositiveIntegerAtMost(
  value: number,
  maximum: number,
  field: string,
): void {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${field} must be a positive integer no greater than ${maximum}`,
    );
  }
}

export function assertRelatedKeywordsDepth(depth: number): void {
  if (
    !Number.isFinite(depth) ||
    !Number.isInteger(depth) ||
    depth < 0 ||
    depth > 3
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "depth must be an integer between 0 and 3",
    );
  }
}

export function assertKeywordOverviewKeywords(keywords: string[]): void {
  if (
    !Array.isArray(keywords) ||
    keywords.length === 0 ||
    keywords.length > 700
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "keywords must contain between 1 and 700 entries",
    );
  }
}
