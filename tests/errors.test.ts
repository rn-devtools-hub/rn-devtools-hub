import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module, no types
import { declaredError, errorEnvelope } from "../server/errors.mjs";

describe("tool error envelopes", () => {
  it("maps common failures to stable codes and actionable hints", () => {
    const error = errorEnvelope("No device available");
    expect(error.code).toBe("no-device");
    expect(error.hint).toMatch(/session_start|list_devices/);
    expect(error.details).toEqual({});
  });

  it("keeps declared refusal details while adding the common contract", () => {
    const error = declaredError({ ok: false, reason: "ambiguous", candidates: [{ index: 0 }] });
    expect(error).toMatchObject({ ok: false, code: "ambiguous", candidates: [{ index: 0 }] });
    expect(error.details.candidates).toEqual([{ index: 0 }]);
  });
});
