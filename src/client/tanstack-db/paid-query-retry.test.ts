import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const paidQueryFiles = [
  ["src/client/features/ai-search/BrandLookupPage.tsx", 1],
  ["src/client/features/ai-search/PromptExplorerPage.tsx", 1],
  ["src/client/features/backlinks/useBacklinksDomainExpansion.ts", 1],
  ["src/client/features/backlinks/useBacklinksPageData.ts", 4],
  ["src/client/features/domain/hooks/useDomainKeywordsQuery.ts", 1],
  ["src/client/features/domain/hooks/useDomainOverviewQuery.ts", 1],
  ["src/client/features/domain/hooks/useDomainPagesQuery.ts", 1],
  ["src/client/features/keywords/hooks/useKeywordResearchData.ts", 1],
  ["src/client/features/keywords/hooks/useKeywordSerpAnalysis.ts", 1],
  ["src/client/features/rank-tracking/KeywordSuggestionStep.tsx", 1],
  ["src/client/features/search-tabs/SearchTabStrip.tsx", 1],
] as const;

describe("paid React Query retry policy", () => {
  it.each(paidQueryFiles)(
    "%s disables automatic retry for every paid query",
    (relativePath, expectedPaidQueries) => {
      const source = readFileSync(`${repositoryRoot}/${relativePath}`, "utf8");
      const disabledRetries = source.match(/retry:\s*false/g)?.length ?? 0;
      expect(disabledRetries).toBeGreaterThanOrEqual(expectedPaidQueries);
    },
  );
});
