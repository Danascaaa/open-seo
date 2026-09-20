export const BOOTSTRAP_DISABLED_PAID_FLAG = "OPENSEO_BOOTSTRAP_DISABLED_PAID";

function isEmptyObjectJson(value) {
  try {
    const parsed = JSON.parse(value ?? "");
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 0
    );
  } catch {
    return false;
  }
}

export function validatePaidProviderDeployMode(env) {
  const bootstrapDisabledPaid = env[BOOTSTRAP_DISABLED_PAID_FLAG] === "1";
  if (env[BOOTSTRAP_DISABLED_PAID_FLAG] && !bootstrapDisabledPaid) {
    return [`${BOOTSTRAP_DISABLED_PAID_FLAG} must be exactly 1 when enabled.`];
  }
  if (!bootstrapDisabledPaid) {
    return env.DATAFORSEO_API_KEY
      ? []
      : [
          "DATAFORSEO_API_KEY is required unless the explicit disabled-paid bootstrap mode is enabled.",
        ];
  }

  const errors = [];
  if (env.DATAFORSEO_API_KEY) {
    errors.push(
      "DATAFORSEO_API_KEY must stay unset in disabled-paid bootstrap mode.",
    );
  }
  if (!isEmptyObjectJson(env.SEO_PAID_OPERATION_LIMITS_JSON)) {
    errors.push(
      "SEO_PAID_OPERATION_LIMITS_JSON must be exactly an empty JSON object in disabled-paid bootstrap mode.",
    );
  }
  return errors;
}
