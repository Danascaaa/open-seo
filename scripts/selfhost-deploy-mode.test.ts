import { describe, expect, it } from "vitest";
import { validatePaidProviderDeployMode } from "./selfhost-deploy-mode.mjs";

describe("self-host disabled-paid bootstrap mode", () => {
  it("allows an absent DataForSEO key only with an explicit empty tariff registry", () => {
    expect(
      validatePaidProviderDeployMode({
        OPENSEO_BOOTSTRAP_DISABLED_PAID: "1",
        SEO_PAID_OPERATION_LIMITS_JSON: "{}",
      }),
    ).toEqual([]);
  });

  it("fails closed when the key is absent outside bootstrap mode", () => {
    expect(validatePaidProviderDeployMode({})).toContainEqual(
      expect.stringContaining("DATAFORSEO_API_KEY is required"),
    );
  });

  it("rejects a fake key or an enabled paid operation in bootstrap mode", () => {
    const errors = validatePaidProviderDeployMode({
      OPENSEO_BOOTSTRAP_DISABLED_PAID: "1",
      DATAFORSEO_API_KEY: "not-a-real-key",
      SEO_PAID_OPERATION_LIMITS_JSON: JSON.stringify({
        "dataforseo:fetchLiveSerp": 10,
      }),
    });

    expect(errors).toHaveLength(2);
    expect(errors.join(" ")).toContain("must stay unset");
    expect(errors.join(" ")).toContain("empty JSON object");
  });
});
