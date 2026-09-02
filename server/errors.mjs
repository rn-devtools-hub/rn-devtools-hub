const RULES = [
  [/no device|no connected app|needs a connected app/i, "no-device", "Start the app in development mode, then call session_start or list_devices."],
  [/unknown command|not attached|hook unavailable|call devtools\.attach/i, "not-attached", "Call get_capabilities for the missing integration and reload the app."],
  [/ambiguous/i, "ambiguous", "Use one of the returned candidates or narrow the selector with within."],
  [/index.*out.of.range|index must/i, "index-out-of-range", "Query the UI again and use an index smaller than count."],
  [/value.unchanged/i, "value-unchanged", "Inspect the field value and its onChangeText handler before retrying."],
  [/timed out|timeout/i, "timeout", "Inspect the returned details, then retry with a longer timeout only if progress is expected."],
];

export const errorEnvelope = (value, fallback = {}) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const code = String(value.code ?? value.reason ?? fallback.code ?? "tool-error");
    const message = String(value.message ?? value.error ?? fallback.message ?? code);
    return {
      code,
      message,
      hint: String(value.hint ?? fallback.hint ?? "Call get_capabilities and inspect the error details before retrying."),
      details: value.details ?? Object.fromEntries(Object.entries(value).filter(([key]) => !["ok", "code", "reason", "message", "error", "hint", "details"].includes(key))),
    };
  }
  const message = String(value ?? fallback.message ?? "Unknown tool error");
  const match = RULES.find(([pattern]) => pattern.test(message));
  return {
    code: match?.[1] ?? fallback.code ?? "tool-error",
    message,
    hint: match?.[2] ?? fallback.hint ?? "Call get_capabilities and inspect the error details before retrying.",
    details: fallback.details ?? {},
  };
};

export const declaredError = (result) => ({
  ...result,
  ...errorEnvelope(result),
  ok: false,
});
