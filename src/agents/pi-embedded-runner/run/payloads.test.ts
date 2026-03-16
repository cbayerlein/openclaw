import { describe, it, expect } from "vitest";
import {
  buildPayloads,
  buildWarnings,
  expectSingleToolErrorWarning,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  it("keeps exec tool errors as warnings even when verbose mode is off", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "off",
    });

    expectSingleToolErrorWarning(warnings, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "on",
    });

    expectSingleToolErrorWarning(warnings, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expectSingleToolErrorWarning(warnings, {
      title: "Write",
      detail: "permission denied",
    });
  });

  it.each([
    {
      name: "includes details for mutating tool failures when verbose is on",
      verboseLevel: "on" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
    {
      name: "includes details for mutating tool failures when verbose is full",
      verboseLevel: "full" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
  ])("$name", ({ verboseLevel, detail, absentDetail }) => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel,
    });

    expectSingleToolErrorWarning(warnings, {
      title: "Write",
      detail,
      absentDetail,
    });
  });

  it("emits sessions_send errors as warnings when no user-facing reply exists", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "sessions_send", error: "delivery timeout" },
      verboseLevel: "on",
    });

    expectSingleToolErrorWarning(warnings, {
      title: "Session Send",
      detail: "delivery timeout",
    });
  });

  it("emits sessions_send errors even when marked mutating", () => {
    const warnings = buildWarnings({
      lastToolError: {
        toolName: "sessions_send",
        error: "delivery timeout",
        mutatingAction: true,
      },
      verboseLevel: "on",
    });

    expectSingleToolErrorWarning(warnings, {
      title: "Session Send",
      detail: "delivery timeout",
    });
  });

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
    });

    expect(payloads).toHaveLength(0);
  });
});
