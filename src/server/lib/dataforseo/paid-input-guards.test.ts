import { beforeEach, describe, expect, it, vi } from "vitest";

const { dataforseoPost, dataforseoPostResponse } = vi.hoisted(() => ({
  dataforseoPost: vi.fn(),
  dataforseoPostResponse: vi.fn(),
}));

vi.mock("@/server/lib/dataforseo/core", () => ({
  dataforseoGet: vi.fn(),
  dataforseoPost,
  dataforseoPostResponse,
}));

vi.mock("@/server/lib/dataforseoBillingClassification", () => ({
  createDataforseoBillingClassifier: () => vi.fn(),
}));

import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from "@/server/lib/dataforseo/backlinks";
import {
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from "@/server/lib/dataforseo/business";
import {
  fetchRelevantPages,
  fetchSerpCompetitors,
} from "@/server/lib/dataforseo/labs";
import {
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from "@/server/lib/dataforseo/google-ads";
import { fetchLiveSerp, fetchLocalSerp } from "@/server/lib/dataforseo/serp";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmTopPages,
} from "@/server/lib/dataforseo/ai";
import { buildLlmTarget } from "@/server/lib/dataforseo/shared";

const market = { locationCode: 2250, languageCode: "fr" };
const coordinate = "48.8566,2.3522,5000";
const target = buildLlmTarget({ type: "domain", value: "example.com" });

const guardedCalls: Array<{ name: string; run: () => Promise<unknown> }> = [
  {
    name: "backlinks rows limit",
    run: () => fetchBacklinksRows({ target: "example.com", limit: 201 }),
  },
  {
    name: "referring domains limit",
    run: () => fetchReferringDomains({ target: "example.com", limit: 201 }),
  },
  {
    name: "domain pages limit",
    run: () => fetchDomainPagesSummary({ target: "example.com", limit: 201 }),
  },
  {
    name: "backlinks history date range",
    run: () =>
      fetchBacklinksHistory({
        target: "example.com",
        dateFrom: "2024-01-01",
        dateTo: "2025-01-01",
      }),
  },
  {
    name: "relevant pages limit",
    run: () =>
      fetchRelevantPages({ target: "example.com", ...market, limit: 201 }),
  },
  {
    name: "SERP competitors keywords",
    run: () =>
      fetchSerpCompetitors({
        keywords: Array.from({ length: 101 }, (_, index) => `term-${index}`),
        ...market,
        limit: 100,
      }),
  },
  {
    name: "live SERP depth",
    run: () => fetchLiveSerp({ keyword: "test", ...market, depth: 101 }),
  },
  {
    name: "local SERP depth",
    run: () =>
      fetchLocalSerp({
        keyword: "test",
        languageCode: "fr",
        searchType: "maps",
        device: "mobile",
        depth: 101,
      }),
  },
  {
    name: "Ads keyword ideas retained rows",
    run: () => fetchAdsKeywordIdeas({ keyword: "test", ...market, limit: 501 }),
  },
  {
    name: "Ads search volume keyword batch",
    run: () =>
      fetchAdsSearchVolume({
        keywords: Array.from({ length: 701 }, (_, index) => `term-${index}`),
        ...market,
      }),
  },
  {
    name: "business listings limit",
    run: () =>
      fetchBusinessListingsSearch({
        locationCoordinate: coordinate,
        limit: 101,
      }),
  },
  {
    name: "questions and answers depth",
    run: () =>
      fetchQuestionsAnswers({
        keyword: "Example",
        locationCoordinate: coordinate,
        languageCode: "fr",
        depth: 101,
      }),
  },
  {
    name: "business profile identifier",
    run: () => fetchMyBusinessInfo({ keyword: " ", ...market }),
  },
  {
    name: "reviews depth",
    run: () =>
      postGoogleReviewsTask({
        keyword: "Example",
        ...market,
        depth: 201,
        includeOtherSources: false,
      }),
  },
  {
    name: "business updates depth",
    run: () =>
      postMyBusinessUpdatesTask({ keyword: "Example", ...market, depth: 101 }),
  },
  {
    name: "Lighthouse URL",
    run: () =>
      fetchLighthouseResult({ url: "file:///tmp/test", strategy: "mobile" }),
  },
  {
    name: "LLM mentions search limit",
    run: () =>
      fetchLlmMentionsSearch({
        target,
        platform: "google",
        ...market,
        limit: 1001,
      }),
  },
  {
    name: "LLM aggregate internal rows",
    run: () =>
      fetchLlmAggregatedMetrics({
        target,
        platform: "google",
        ...market,
        internalListLimit: 21,
      }),
  },
  {
    name: "LLM top pages rows",
    run: () =>
      fetchLlmTopPages({
        target,
        platform: "google",
        ...market,
        itemsListLimit: 11,
      }),
  },
  {
    name: "LLM cross target groups",
    run: () =>
      fetchLlmCrossAggregatedMetrics({
        groups: [{ key: "one", target }],
        platform: "google",
        ...market,
      }),
  },
];

describe("paid DataForSEO input ceilings", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(guardedCalls)(
    "refuses $name before provider transport",
    async ({ run }) => {
      await expect(run()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(dataforseoPost).not.toHaveBeenCalled();
      expect(dataforseoPostResponse).not.toHaveBeenCalled();
    },
  );
});
