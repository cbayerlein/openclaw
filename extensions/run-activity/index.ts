import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginAgentEventSubscriptionRegistration } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

type AgentEventPayload = Parameters<PluginAgentEventSubscriptionRegistration["handle"]>[0];

type RunActivityStatus = "running" | "done" | "failed" | "aborted" | "unknown";

type RunActivityEventKind =
  | "run_started"
  | "run_finished"
  | "run_failed"
  | "run_state"
  | "thinking"
  | "plan"
  | "item_started"
  | "item_updated"
  | "item_finished"
  | "item_failed"
  | "tool_started"
  | "tool_updated"
  | "tool_finished"
  | "tool_failed"
  | "approval_requested"
  | "approval_resolved"
  | "command_output"
  | "patch"
  | "compaction"
  | "guardrail"
  | "error"
  | "warning";

export type RunActivityEvent = {
  idx: number;
  runId: string;
  seq: number;
  ts: number;
  stream: string;
  kind: RunActivityEventKind;
  sessionKey?: string;
  agentId?: string;
  data: Record<string, unknown>;
};

export type RunActivitySummary = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  runRole?: "conversation" | "technical" | "child";
  parentRunId?: string;
  displayKind?: string;
  visibleInChat?: boolean;
  status: RunActivityStatus;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  provider?: string;
  model?: string;
  eventCount: number;
  toolCount: number;
  lastEventKind?: RunActivityEventKind;
};

type RunActivityPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
};

const ROOT_DIRNAME = "run-activity";
const RUNS_DIRNAME = "runs";
const EVENTS_DIRNAME = "events";
const MAX_PAGE_LIMIT = 500;
const RETENTION_DAYS = 14;
const MAX_RUNS = 5000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const writeQueueByRun = new Map<string, Promise<void>>();
const seenEventKeys: string[] = [];
const seenEventKeySet = new Set<string>();
let runtimeUnsubscribe: (() => void) | undefined;
let prunePromise: Promise<void> | null = null;
let lastPruneAtMs = 0;

function normalizeRunId(runId: string): string {
  return encodeURIComponent(runId.trim());
}

function inferRunDisplayKind(runId: string): string {
  if (runId.includes("image_generate")) {
    return "image_generation";
  }
  if (runId.includes(":subagent:")) {
    return "subagent";
  }
  if (runId.startsWith("announce:v1:")) {
    return "announcement";
  }
  return "run";
}

function looksConversationAnnouncementRunId(runId: string): boolean {
  return (
    runId.startsWith("announce:v1:") &&
    !runId.includes(":image_generate:") &&
    /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)
  );
}

function classifyRunSummary(summary: RunActivitySummary): RunActivitySummary {
  const displayKind = summary.displayKind ?? inferRunDisplayKind(summary.runId);
  const isImageGeneration =
    summary.runId.startsWith("image_generate:") || summary.runId.includes(":image_generate:");
  const visibleInChat =
    summary.visibleInChat ??
    (looksConversationAnnouncementRunId(summary.runId) ||
      (!isImageGeneration && summary.runRole === "conversation"));
  const runRole: RunActivitySummary["runRole"] = visibleInChat
    ? "conversation"
    : isImageGeneration || summary.parentRunId || summary.runId.includes(":subagent:")
      ? "child"
      : (summary.runRole ?? "technical");
  return {
    ...summary,
    runRole,
    displayKind,
    visibleInChat: runRole === "conversation",
  };
}

function resolveRootDir(): string {
  return path.join(resolveStateDir(), ROOT_DIRNAME);
}

function resolveRunsDir(): string {
  return path.join(resolveRootDir(), RUNS_DIRNAME);
}

function resolveEventsDir(): string {
  return path.join(resolveRootDir(), EVENTS_DIRNAME);
}

function resolveSummaryPath(runId: string): string {
  return path.join(resolveRunsDir(), `${normalizeRunId(runId)}.json`);
}

function resolveLegacySummaryPath(runId: string): string {
  return path.join(resolveStateDir(), "run-observability", "runs", `${normalizeRunId(runId)}.json`);
}

function resolveEventsPath(runId: string): string {
  return path.join(resolveEventsDir(), `${normalizeRunId(runId)}.jsonl`);
}

function resolveLegacyEventsPath(runId: string): string {
  return path.join(
    resolveStateDir(),
    "run-observability",
    "events",
    `${normalizeRunId(runId)}.jsonl`,
  );
}

function resolveAgentSessionStorePath(agentId: string): string {
  return path.join(resolveStateDir(), "agents", agentId, "sessions", "sessions.json");
}

function clampLimit(limit: unknown): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : 100;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, value));
}

async function ensureStoreDirs(): Promise<void> {
  await fs.mkdir(resolveRunsDir(), { recursive: true });
  await fs.mkdir(resolveEventsDir(), { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rememberEvent(evt: AgentEventPayload): boolean {
  const key = `${evt.runId}:${evt.seq}:${evt.stream}:${JSON.stringify(evt.data ?? {})}`;
  if (seenEventKeySet.has(key)) {
    return false;
  }
  seenEventKeySet.add(key);
  seenEventKeys.push(key);
  while (seenEventKeys.length > 10_000) {
    const oldest = seenEventKeys.shift();
    if (oldest) {
      seenEventKeySet.delete(oldest);
    }
  }
  return true;
}

function deriveAgentId(sessionKey?: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey ?? "");
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function pickProvider(data: Record<string, unknown>): string | undefined {
  return (
    readString(data.activeProvider) ??
    readString(data.selectedProvider) ??
    readString(data.provider)
  );
}

function pickModel(data: Record<string, unknown>): string | undefined {
  return readString(data.activeModel) ?? readString(data.selectedModel) ?? readString(data.model);
}

function normalizeLifecycleKind(data: Record<string, unknown>): RunActivityEventKind | null {
  const phase = readString(data.phase) ?? "";
  if (phase === "start") {
    return "run_started";
  }
  if (phase === "end") {
    return "run_finished";
  }
  if (phase === "error") {
    return "run_failed";
  }
  return phase ? "run_state" : null;
}

function normalizeToolKind(data: Record<string, unknown>): RunActivityEventKind {
  const phase = readString(data.phase) ?? "";
  if (phase === "start") {
    return "tool_started";
  }
  if (phase === "update") {
    return "tool_updated";
  }
  return data.isError === true ? "tool_failed" : "tool_finished";
}

function normalizeItemKind(data: Record<string, unknown>): RunActivityEventKind {
  const phase = readString(data.phase) ?? "";
  const status = readString(data.status) ?? "";
  if (phase === "start") {
    return "item_started";
  }
  if (phase === "update") {
    return "item_updated";
  }
  return status === "failed" ? "item_failed" : "item_finished";
}

function normalizeEventKind(evt: AgentEventPayload): RunActivityEventKind | null {
  const data = evt.data ?? {};
  if (evt.stream === "assistant") {
    return null;
  }
  if (evt.stream === "lifecycle") {
    return normalizeLifecycleKind(data);
  }
  if (evt.stream === "thinking") {
    return "thinking";
  }
  if (evt.stream === "plan") {
    return "plan";
  }
  if (evt.stream === "item") {
    return normalizeItemKind(data);
  }
  if (evt.stream === "tool") {
    return normalizeToolKind(data);
  }
  if (evt.stream === "approval") {
    return readString(data.phase) === "requested" ? "approval_requested" : "approval_resolved";
  }
  if (evt.stream === "command_output") {
    return "command_output";
  }
  if (evt.stream === "patch") {
    return "patch";
  }
  if (evt.stream === "compaction") {
    return "compaction";
  }
  if (evt.stream === "guardrail") {
    return "guardrail";
  }
  if (evt.stream === "error") {
    return "error";
  }
  return "warning";
}

function normalizeEvent(
  evt: AgentEventPayload,
  idx: number,
  summary: RunActivitySummary | null,
): RunActivityEvent | null {
  const kind = normalizeEventKind(evt);
  if (!kind || !evt.runId.trim()) {
    return null;
  }
  const sessionKey = readString(evt.sessionKey) ?? summary?.sessionKey;
  const agentId = deriveAgentId(sessionKey) ?? summary?.agentId;
  return {
    idx,
    runId: evt.runId,
    seq: evt.seq,
    ts: evt.ts,
    stream: evt.stream,
    kind,
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
    data: evt.data ?? {},
  };
}

function statusFromLifecycle(evt: RunActivityEvent): RunActivityStatus {
  const phase = readString(evt.data.phase) ?? "";
  if (phase === "start") {
    return "running";
  }
  if (phase === "error") {
    return "failed";
  }
  if (phase === "end") {
    return readString(evt.data.stopReason) === "aborted" ? "aborted" : "done";
  }
  return "unknown";
}

function buildNextSummary(params: {
  previous: RunActivitySummary | null;
  event: RunActivityEvent;
}): RunActivitySummary {
  const previous = params.previous;
  const evt = params.event;
  const next: RunActivitySummary = previous
    ? { ...previous }
    : {
        runId: evt.runId,
        status: "unknown",
        updatedAt: evt.ts,
        eventCount: 0,
        toolCount: 0,
      };

  next.updatedAt = evt.ts;
  next.eventCount = evt.idx;
  next.lastEventKind = evt.kind;
  if (evt.sessionKey) {
    next.sessionKey = evt.sessionKey;
  }
  if (evt.agentId) {
    next.agentId = evt.agentId;
  }
  const provider = pickProvider(evt.data);
  const model = pickModel(evt.data);
  if (provider) {
    next.provider = provider;
  }
  if (model) {
    next.model = model;
  }
  if (evt.stream === "lifecycle") {
    const status = statusFromLifecycle(evt);
    if (status !== "unknown") {
      next.status = status;
    }
    const startedAt = readNumber(evt.data.startedAt);
    const endedAt = readNumber(evt.data.endedAt);
    if (evt.kind === "run_started") {
      next.startedAt = startedAt ?? previous?.startedAt ?? evt.ts;
      next.endedAt = undefined;
    }
    if (endedAt !== undefined) {
      next.endedAt = endedAt;
    } else if (evt.kind === "run_finished" || evt.kind === "run_failed") {
      next.endedAt = evt.ts;
    }
  } else if (!next.startedAt) {
    next.startedAt = evt.ts;
    next.status = next.status === "unknown" ? "running" : next.status;
  }
  if (evt.kind === "tool_started" || evt.kind === "item_started") {
    next.toolCount += 1;
  }
  return next;
}

async function persistRunActivityEventNow(evt: AgentEventPayload): Promise<void> {
  const summaryPath = resolveSummaryPath(evt.runId);
  const previous = await readJsonFile<RunActivitySummary>(summaryPath);
  const normalized = normalizeEvent(evt, (previous?.eventCount ?? 0) + 1, previous);
  if (!normalized) {
    return;
  }
  await ensureStoreDirs();
  await fs.appendFile(resolveEventsPath(evt.runId), `${JSON.stringify(normalized)}\n`, "utf8");
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(buildNextSummary({ previous, event: normalized }), null, 2)}\n`,
    "utf8",
  );
  void maybePruneStore();
}

export function persistRunActivityEvent(evt: AgentEventPayload): Promise<void> {
  const runId = evt.runId.trim();
  if (!runId) {
    return Promise.resolve();
  }
  if (!rememberEvent(evt)) {
    return Promise.resolve();
  }
  const previous = writeQueueByRun.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => persistRunActivityEventNow(evt))
    .finally(() => {
      if (writeQueueByRun.get(runId) === next) {
        writeQueueByRun.delete(runId);
      }
    });
  writeQueueByRun.set(runId, next);
  return next;
}

async function readRunEvents(runId: string): Promise<RunActivityEvent[]> {
  try {
    const text = await fs.readFile(resolveEventsPath(runId), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunActivityEvent);
  } catch {
    return [];
  }
}

async function readLegacyRunEvents(runId: string): Promise<RunActivityEvent[]> {
  try {
    const text = await fs.readFile(resolveLegacyEventsPath(runId), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const event = JSON.parse(line) as Partial<RunActivityEvent>;
        const stream = readString(event.stream) ?? "legacy";
        const data =
          event.data && typeof event.data === "object" && !Array.isArray(event.data)
            ? (event.data as Record<string, unknown>)
            : {};
        const normalizedKind =
          normalizeEventKind({
            runId,
            seq: readNumber(event.seq) ?? readNumber(event.idx) ?? index + 1,
            ts: readNumber(event.ts) ?? Date.now(),
            stream,
            data,
          }) ??
          (readString(event.kind) as RunActivityEventKind | undefined) ??
          "warning";
        return {
          idx: index + 1,
          runId,
          seq: readNumber(event.seq) ?? readNumber(event.idx) ?? index + 1,
          ts: readNumber(event.ts) ?? Date.now(),
          stream,
          kind: normalizedKind,
          ...(readString(event.sessionKey) ? { sessionKey: readString(event.sessionKey) } : {}),
          ...(readString(event.agentId) ? { agentId: readString(event.agentId) } : {}),
          data,
        };
      });
  } catch {
    return [];
  }
}

function collectThinkingText(value: unknown): string[] {
  const found: string[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") {
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "thinking") {
      const text = readString(record.thinking) ?? readString(record.text);
      if (text) {
        found.push(text);
      }
      return;
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(value);
  return found;
}

async function resolveSessionFileForKey(sessionKey: string): Promise<string | undefined> {
  const agentId = deriveAgentId(sessionKey);
  if (!agentId) {
    return undefined;
  }
  const store = await readJsonFile<Record<string, { sessionFile?: unknown }>>(
    resolveAgentSessionStorePath(agentId),
  );
  const direct = store?.[sessionKey]?.sessionFile;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const lowerSessionKey = sessionKey.toLowerCase();
  const fallback = Object.entries(store ?? {}).find(
    ([key]) => key.toLowerCase() === lowerSessionKey,
  );
  const fallbackFile = fallback?.[1]?.sessionFile;
  return typeof fallbackFile === "string" && fallbackFile.trim() ? fallbackFile.trim() : undefined;
}

async function readSessionThinkingEvents(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  startedAt?: number;
  endedAt?: number;
}): Promise<RunActivityEvent[]> {
  if (!params.sessionKey) {
    return [];
  }
  const sessionFile = await resolveSessionFileForKey(params.sessionKey);
  if (!sessionFile) {
    return [];
  }
  let text = "";
  try {
    text = await fs.readFile(sessionFile, "utf8");
  } catch {
    return [];
  }
  const start = params.startedAt ?? 0;
  const end = params.endedAt ?? Date.now() + 60_000;
  const seen = new Set<string>();
  const events: RunActivityEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = readTimestamp(record.timestamp) ?? readTimestamp(record.ts);
    if (ts === undefined || ts < start || ts > end) {
      continue;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (message?.role !== "assistant") {
      continue;
    }
    for (const thinking of collectThinkingText(message.content)) {
      const key = `${ts}:${thinking}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      events.push({
        idx: 0,
        runId: params.runId,
        seq: 0,
        ts,
        stream: "thinking",
        kind: "thinking",
        sessionKey: params.sessionKey,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        data: {
          text: thinking,
          source: "session",
        },
      });
    }
  }
  return events;
}

async function mergeSessionThinkingEvents(
  runId: string,
  items: RunActivityEvent[],
): Promise<RunActivityEvent[]> {
  const sessionKey = items.find((item) => item.sessionKey)?.sessionKey;
  const agentId = items.find((item) => item.agentId)?.agentId ?? deriveAgentId(sessionKey);
  const startedAt =
    items.find((item) => item.kind === "run_started")?.ts ??
    Math.min(...items.map((item) => item.ts).filter(Number.isFinite));
  const endedAt = items.find(
    (item) => item.kind === "run_finished" || item.kind === "run_failed",
  )?.ts;
  const thinkingEvents = await readSessionThinkingEvents({
    runId,
    sessionKey,
    agentId,
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    endedAt,
  });
  if (thinkingEvents.length === 0) {
    return items;
  }
  const existingThinking = new Set(
    items
      .filter((item) => item.kind === "thinking")
      .map((item) => `${item.ts}:${readString(item.data.text) ?? ""}`),
  );
  const merged = [
    ...items,
    ...thinkingEvents.filter(
      (item) => !existingThinking.has(`${item.ts}:${readString(item.data.text) ?? ""}`),
    ),
  ].sort((a, b) => a.ts - b.ts || a.idx - b.idx || a.kind.localeCompare(b.kind));
  return merged.map((item, index) => ({
    ...item,
    idx: index + 1,
    seq: item.seq || index + 1,
  }));
}

async function readRunSummaryFiles(): Promise<RunActivitySummary[]> {
  try {
    const entries = await fs.readdir(resolveRunsDir(), { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readJsonFile<RunActivitySummary>(path.join(resolveRunsDir(), entry.name))),
    );
    return items.filter((item): item is RunActivitySummary => Boolean(item));
  } catch {
    return [];
  }
}

async function readLegacyRunSummaryFiles(): Promise<RunActivitySummary[]> {
  try {
    const dir = path.join(resolveStateDir(), "run-observability", "runs");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    const items = await Promise.all(
      files.map((entry) => readJsonFile<RunActivitySummary>(path.join(dir, entry.name))),
    );
    return items.filter((item): item is RunActivitySummary => Boolean(item));
  } catch {
    return [];
  }
}

function decodeIdx(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function decodeCursor(cursor: string | undefined): { updatedAt: number; runId: string } | null {
  const raw = cursor?.trim();
  if (!raw) {
    return null;
  }
  const sep = raw.indexOf(":");
  if (sep <= 0) {
    return null;
  }
  const updatedAt = Number.parseInt(raw.slice(0, sep), 10);
  const runId = raw.slice(sep + 1);
  if (!Number.isFinite(updatedAt) || !runId) {
    return null;
  }
  return { updatedAt, runId };
}

function encodeCursor(summary: RunActivitySummary): string {
  return `${summary.updatedAt}:${summary.runId}`;
}

export async function listRunActivityEvents(params: {
  runId: string;
  stream?: string;
  kind?: RunActivityEventKind;
  limit?: number;
  cursor?: string;
  afterIdx?: number;
}): Promise<RunActivityPage<RunActivityEvent>> {
  const limit = clampLimit(params.limit);
  let items = await readRunEvents(params.runId);
  if (items.length === 0) {
    items = await readLegacyRunEvents(params.runId);
  }
  items = await mergeSessionThinkingEvents(params.runId, items);
  if (params.stream?.trim()) {
    items = items.filter((item) => item.stream === params.stream?.trim());
  }
  if (params.kind) {
    items = items.filter((item) => item.kind === params.kind);
  }
  const afterIdx = decodeIdx(params.afterIdx);
  if (afterIdx !== null) {
    items = items.filter((item) => item.idx > afterIdx);
    const page = items.slice(0, limit);
    return {
      items: page,
      hasMore: items.length > page.length,
      ...(items.length > page.length && page.length > 0
        ? { nextCursor: String(page.at(-1)!.idx) }
        : {}),
    };
  }
  const cursorIdx = decodeIdx(params.cursor);
  if (cursorIdx !== null) {
    items = items.filter((item) => item.idx < cursorIdx);
  }
  const page = items.slice(Math.max(0, items.length - limit));
  return {
    items: page,
    hasMore: items.length > page.length,
    ...(items.length > page.length && page.length > 0 ? { nextCursor: String(page[0].idx) } : {}),
  };
}

export async function listRunActivitySummaries(params: {
  sessionKey?: string;
  agentId?: string;
  status?: RunActivityStatus;
  sinceTs?: number;
  untilTs?: number;
  limit?: number;
  cursor?: string;
}): Promise<RunActivityPage<RunActivitySummary>> {
  const limit = clampLimit(params.limit);
  const current = await readRunSummaryFiles();
  const currentIds = new Set(current.map((item) => item.runId));
  let items = [
    ...current,
    ...(await readLegacyRunSummaryFiles()).filter((item) => !currentIds.has(item.runId)),
  ];
  if (params.sessionKey?.trim()) {
    items = items.filter((item) => item.sessionKey === params.sessionKey?.trim());
  }
  if (params.agentId?.trim()) {
    items = items.filter((item) => item.agentId === params.agentId?.trim());
  }
  if (params.status) {
    items = items.filter((item) => item.status === params.status);
  }
  if (typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs)) {
    items = items.filter((item) => item.updatedAt >= params.sinceTs!);
  }
  if (typeof params.untilTs === "number" && Number.isFinite(params.untilTs)) {
    items = items.filter((item) => item.updatedAt <= params.untilTs!);
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId));
  const cursor = decodeCursor(params.cursor);
  if (cursor) {
    items = items.filter(
      (item) =>
        item.updatedAt < cursor.updatedAt ||
        (item.updatedAt === cursor.updatedAt && item.runId > cursor.runId),
    );
  }
  const page = items.slice(0, limit);
  return {
    items: page.map(classifyRunSummary),
    hasMore: items.length > page.length,
    ...(items.length > page.length && page.length > 0
      ? { nextCursor: encodeCursor(page.at(-1)!) }
      : {}),
  };
}

export async function getRunActivitySummary(runId: string): Promise<RunActivitySummary | null> {
  if (!runId.trim()) {
    return null;
  }
  const summary =
    (await readJsonFile<RunActivitySummary>(resolveSummaryPath(runId))) ??
    (await readJsonFile<RunActivitySummary>(resolveLegacySummaryPath(runId)));
  return summary ? classifyRunSummary(summary) : null;
}

async function maybePruneStore(): Promise<void> {
  const now = Date.now();
  if (prunePromise || now - lastPruneAtMs < PRUNE_INTERVAL_MS) {
    return;
  }
  prunePromise = pruneStore().finally(() => {
    prunePromise = null;
    lastPruneAtMs = Date.now();
  });
  await prunePromise;
}

async function pruneStore(): Promise<void> {
  const runs = await listRunActivitySummaries({ limit: MAX_RUNS + 1000 });
  if (runs.items.length === 0) {
    return;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const sorted = runs.items.toSorted((a, b) => a.updatedAt - b.updatedAt);
  const remove = new Set<string>();
  for (const entry of sorted) {
    if (entry.updatedAt < cutoff) {
      remove.add(entry.runId);
    }
  }
  while (sorted.length - remove.size > MAX_RUNS) {
    const next = sorted.find((entry) => !remove.has(entry.runId));
    if (!next) {
      break;
    }
    remove.add(next.runId);
  }
  await Promise.all(
    [...remove].flatMap((runId) => [
      fs.rm(resolveSummaryPath(runId), { force: true }),
      fs.rm(resolveEventsPath(runId), { force: true }),
    ]),
  );
}

function sendError(respond: GatewayRequestHandlerOptions["respond"], message: string): void {
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}

async function handleRunActivityEvents({
  params,
  respond,
  method,
}: GatewayRequestHandlerOptions & { method: string }): Promise<void> {
  const runId = readString(params?.runId);
  if (!runId) {
    sendError(respond, `${method} requires runId`);
    return;
  }
  respond(
    true,
    await listRunActivityEvents({
      runId,
      stream: readString(params?.stream),
      kind: readString(params?.kind) as RunActivityEventKind | undefined,
      limit: readNumber(params?.limit),
      cursor: readString(params?.cursor),
      afterIdx: readNumber(params?.afterIdx),
    }),
  );
}

async function handleRunActivityList({
  params,
  respond,
}: GatewayRequestHandlerOptions): Promise<void> {
  respond(
    true,
    await listRunActivitySummaries({
      sessionKey: readString(params?.sessionKey),
      agentId: readString(params?.agentId),
      status: readString(params?.status) as RunActivityStatus | undefined,
      sinceTs: readNumber(params?.sinceTs),
      untilTs: readNumber(params?.untilTs),
      limit: readNumber(params?.limit),
      cursor: readString(params?.cursor),
    }),
  );
}

async function handleRunActivityGet({
  params,
  respond,
}: GatewayRequestHandlerOptions): Promise<void> {
  const runId = readString(params?.runId);
  if (!runId) {
    sendError(respond, "runs.get requires runId");
    return;
  }
  const payload = await getRunActivitySummary(runId);
  if (!payload) {
    sendError(respond, `run not found: ${runId}`);
    return;
  }
  respond(true, payload);
}

export default definePluginEntry({
  id: "run-activity",
  name: "Run Activity",
  description: "Plugin-owned chronological activity timeline for agent runs",
  register(api) {
    runtimeUnsubscribe?.();
    runtimeUnsubscribe = api.runtime.events.onAgentEvent((event) => {
      void persistRunActivityEvent(event).catch((error) => {
        api.logger.warn?.(`run-activity: failed to persist runtime event: ${String(error)}`);
      });
    });

    api.registerRuntimeLifecycle({
      id: "run-activity-agent-events",
      cleanup() {
        runtimeUnsubscribe?.();
        runtimeUnsubscribe = undefined;
      },
    });

    api.registerAgentEventSubscription({
      id: "persist-run-activity",
      description: "Persist run activity timeline events",
      handle: (event) => {
        void persistRunActivityEvent(event).catch((error) => {
          api.logger.warn?.(`run-activity: failed to persist event: ${String(error)}`);
        });
      },
    });

    api.registerGatewayMethod(
      "runActivity.events",
      async (options: GatewayRequestHandlerOptions) =>
        handleRunActivityEvents({ ...options, method: "runActivity.events" }),
      { scope: "operator.read" },
    );

    api.registerGatewayMethod("runActivity.list", handleRunActivityList, {
      scope: "operator.read",
    });

    api.registerGatewayMethod("runActivity.get", handleRunActivityGet, { scope: "operator.read" });

    api.registerGatewayMethod(
      "runs.events",
      async (options: GatewayRequestHandlerOptions) =>
        handleRunActivityEvents({ ...options, method: "runs.events" }),
      { scope: "operator.read" },
    );

    api.registerGatewayMethod("runs.list", handleRunActivityList, { scope: "operator.read" });

    api.registerGatewayMethod("runs.get", handleRunActivityGet, { scope: "operator.read" });
  },
});
