import { describe, expect, it } from "vitest";
import { extractToolErrorMessage, isToolResultError } from "./pi-embedded-subscribe.tools.js";

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });

  it("prefers non-zero exitCode for exec-style errors", () => {
    expect(extractToolErrorMessage({ details: { status: "completed", exitCode: 57 } })).toBe(
      "Command exited with code 57",
    );
    expect(isToolResultError({ details: { status: "completed", exitCode: 57 } })).toBe(true);
  });

  it("treats zero exitCode as non-error", () => {
    expect(isToolResultError({ details: { status: "completed", exitCode: 0 } })).toBe(false);
  });
});
