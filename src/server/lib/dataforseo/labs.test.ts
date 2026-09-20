import { describe, expect, it, vi } from "vitest";

const { dataforseoPost } = vi.hoisted(() => ({
  dataforseoPost: vi.fn(),
}));

vi.mock("@/server/lib/dataforseo/core", () => ({ dataforseoPost }));

import {
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
} from "./labs";

const market = { locationCode: 2250, languageCode: "fr" };

describe("DataForSEO Labs request limits", () => {
  it("rejects an over-limit related-keywords request before transport", async () => {
    await expect(
      fetchRelatedKeywords({ ...market, keyword: "renovation", limit: 501 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dataforseoPost).not.toHaveBeenCalled();
  });

  it("rejects an invalid related-keywords depth before transport", async () => {
    await expect(
      fetchRelatedKeywords({
        ...market,
        keyword: "renovation",
        limit: 500,
        depth: 4,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dataforseoPost).not.toHaveBeenCalled();
  });

  it("rejects a non-finite suggestions limit before transport", async () => {
    await expect(
      fetchKeywordSuggestions({
        ...market,
        keyword: "renovation",
        limit: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dataforseoPost).not.toHaveBeenCalled();
  });

  it("rejects a non-integer ideas limit before transport", async () => {
    await expect(
      fetchKeywordIdeas({ ...market, keyword: "renovation", limit: 1.5 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dataforseoPost).not.toHaveBeenCalled();
  });

  it("rejects an over-limit ranked-keywords request before transport", async () => {
    await expect(
      fetchRankedKeywords({ ...market, target: "example.com", limit: 201 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dataforseoPost).not.toHaveBeenCalled();
  });

  it("rejects an empty keyword-overview array before transport", async () => {
    await expect(
      fetchKeywordOverview({ ...market, keywords: [] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(dataforseoPost).not.toHaveBeenCalled();
  });

  it("rejects a keyword-overview array over 700 entries before transport", async () => {
    await expect(
      fetchKeywordOverview({
        ...market,
        keywords: Array.from({ length: 701 }, (_, index) => `keyword-${index}`),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(dataforseoPost).not.toHaveBeenCalled();
  });
});
