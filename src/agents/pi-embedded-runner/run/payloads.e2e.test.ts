import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatBillingErrorMessage } from "../../pi-embedded-helpers.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";

describe("buildEmbeddedRunPayloads", () => {
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  const errorJsonPretty = `{
  "type": "error",
  "error": {
    "details": null,
    "type": "overloaded_error",
    "message": "Overloaded"
  },
  "request_id": "req_011CX7DwS7tSvggaNHmefwWg"
}`;
  const makeAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: 0,
    stopReason: "error",
    errorMessage: errorJson,
    content: [{ type: "text", text: errorJson }],
    ...overrides,
  });

  type BuildPayloadParams = Parameters<typeof buildEmbeddedRunPayloads>[0];
  const buildPayloadResult = (overrides: Partial<BuildPayloadParams> = {}) =>
    buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
      toolResultFormat: "plain",
      ...overrides,
    });
  const buildPayloads = (overrides: Partial<BuildPayloadParams> = {}) =>
    buildPayloadResult(overrides).payloads;
  const buildWarnings = (overrides: Partial<BuildPayloadParams> = {}) =>
    buildPayloadResult(overrides).warnings;

  it("suppresses raw API error JSON when the assistant errored", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text === errorJson)).toBe(false);
  });

  it("suppresses pretty-printed error JSON that differs from the errorMessage", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: errorJson }),
      inlineToolResultsAllowed: true,
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text === errorJsonPretty)).toBe(false);
  });

  it("suppresses raw error JSON from fallback assistant text", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({ content: [{ type: "text", text: errorJsonPretty }] }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("includes provider context for billing errors", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        errorMessage: "insufficient credits",
        content: [{ type: "text", text: "insufficient credits" }],
      }),
      provider: "Anthropic",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(formatBillingErrorMessage("Anthropic"));
    expect(payloads[0]?.isError).toBe(true);
  });

  it("suppresses raw error JSON even when errorMessage is missing", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: undefined }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("does not suppress error-shaped JSON when the assistant did not error", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(errorJsonPretty.trim());
  });

  it("emits warning events when a tool fails and no assistant output exists", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "browser", error: "tab not found" },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("Browser");
    expect(warnings[0]?.text).toContain("tab not found");
  });

  it("does not emit non-mutating warning when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["All good"],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
      lastToolError: { toolName: "browser", error: "tab not found" },
    });
    const warnings = buildWarnings({
      assistantTexts: ["All good"],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
      lastToolError: { toolName: "browser", error: "tab not found" },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("All good");
    expect(warnings).toHaveLength(0);
  });

  it("emits exec warning even when assistant output exists", () => {
    const warnings = buildWarnings({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
      lastToolError: { toolName: "exec", error: "Command exited with code 42" },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("Exec failed: Command exited with code 42");
  });

  it("emits warning when the assistant only invoked tools", () => {
    const warnings = buildWarnings({
      lastAssistant: makeAssistant({
        stopReason: "toolUse",
        errorMessage: undefined,
        content: [
          {
            type: "toolCall",
            id: "toolu_01",
            name: "exec",
            arguments: { command: "echo hi" },
          },
        ],
      }),
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toMatch(/^⚠️\s+🛠️\s+Exec/);
    expect(warnings[0]?.text).toContain("code 1");
    expect(warnings[0]?.kind).toBe("tool_error");
    expect(warnings[0]?.fingerprint).toMatch(/^[a-f0-9]{40}$/);
  });

  it("suppresses recoverable tool errors containing 'required' for non-mutating tools", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "browser", error: "url required" },
    });

    expect(warnings).toHaveLength(0);
  });

  it("suppresses recoverable tool errors containing 'missing' for non-mutating tools", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "browser", error: "url missing" },
    });

    expect(warnings).toHaveLength(0);
  });

  it("suppresses recoverable tool errors containing 'invalid' for non-mutating tools", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "browser", error: "invalid parameter: url" },
    });

    expect(warnings).toHaveLength(0);
  });

  it("suppresses non-mutating non-recoverable tool errors when messages.suppressToolErrors is enabled", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "browser", error: "connection timeout" },
      config: { messages: { suppressToolErrors: true } },
    });

    expect(warnings).toHaveLength(0);
  });

  it("still emits mutating tool warnings when messages.suppressToolErrors is enabled", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "write", error: "connection timeout" },
      config: { messages: { suppressToolErrors: true } },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("connection timeout");
  });

  it("keeps exec warning events when messages.suppressToolErrors is enabled", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      config: { messages: { suppressToolErrors: true } },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("⚠️ 🛠️ Exec failed: Command exited with code 1");
  });

  it("shows recoverable tool errors for mutating tools", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "message", meta: "reply", error: "text required" },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("required");
  });

  it("emits mutating tool warnings even when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
      lastToolError: { toolName: "write", error: "file missing" },
    });
    const warnings = buildWarnings({
      assistantTexts: ["Done."],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
      lastToolError: { toolName: "write", error: "file missing" },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Done.");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("missing");
  });

  it("does not treat session_status read failures as mutating when explicitly flagged", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Status loaded."],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
      lastToolError: {
        toolName: "session_status",
        error: "model required",
        mutatingAction: false,
      },
    });
    const warnings = buildWarnings({
      assistantTexts: ["Status loaded."],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
      lastToolError: {
        toolName: "session_status",
        error: "model required",
        mutatingAction: false,
      },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Status loaded.");
    expect(warnings).toHaveLength(0);
  });

  it("dedupes warning text already present in assistant output", () => {
    const seed = buildWarnings({
      lastToolError: {
        toolName: "write",
        error: "file missing",
        mutatingAction: true,
      },
    });
    const warningText = seed[0]?.text;
    expect(warningText).toBeTruthy();

    const warnings = buildWarnings({
      assistantTexts: [warningText ?? ""],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
      lastToolError: {
        toolName: "write",
        error: "file missing",
        mutatingAction: true,
      },
    });

    expect(warnings).toHaveLength(0);
  });

  it("emits non-recoverable tool errors as warnings", () => {
    const warnings = buildWarnings({
      lastToolError: { toolName: "browser", error: "connection timeout" },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("connection timeout");
  });
});
