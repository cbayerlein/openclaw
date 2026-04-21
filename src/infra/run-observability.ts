import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { AgentEventPayload } from "./agent-events.js";

export type RunObservabilityStatus = "running" | "done" | "failed" | "aborted" | "unknown";

export type RunObservabilityEventKind =
  | "run_started"
  | "run_finished"
  | "run_failed"
  | "run_state"
  | "tool_started"
  | "tool_updated"
  | "tool_finished"
  | "tool_failed"
  | "guardrail"
  | "error"
  | "warning";

export type RunObservabilityEvent = {
  idx: number;
  runId: string;
  ts: number;
  stream: string;
  kind: RunObservabilityEventKind;
  sessionKey?: string;
  agentId?: string;
  data: Record<string, unknown>;
};

export type RunObservabilitySummary = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  status: RunObservabilityStatus;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  provider?: string;
  model?: string;
  eventCount: number;
  toolCount: number;
  lastEventKind?: RunObservabilityEventKind;
};

export type RunObservabilityListParams = {
  sessionKey?: string;
  agentId?: string;
  status?: RunObservabilityStatus;
  sinceTs?: number;
  untilTs?: number;
  limit?: number;
  cursor?: string;
};

export type RunObservabilityEventsParams = {
  runId: string;
  stream?: string;
  kind?: RunObservabilityEventKind;
  limit?: number;
  cursor?: string;
};

export type RunObservabilityPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
};

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_RUNS = 5000;
const MAX_PAGE_LIMIT = 500;
const ROOT_DIRNAME = "run-observability";
const RUNS_DIRNAME = "runs";
const EVENTS_DIRNAME = "events";
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let prunePromise: Promise<void> | null = null;
let lastPruneAtMs = 0;

function normalizeRunId(runId: string): string {
  return encodeURIComponent(runId.trim());
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

function resolveEventsPath(runId: string): string {
  return path.join(resolveEventsDir(), `${normalizeRunId(runId)}.jsonl`);
}

function clampLimit(limit: number | undefined): number {
  const value = Number.isFinite(limit) ? Math.floor(limit as number) : 100;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, value));
}

function resolveRetentionDays(): number {
  const raw = process.env.OPENCLAW_RUN_HISTORY_RETENTION_DAYS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

function resolveMaxRuns(): number {
  const raw = process.env.OPENCLAW_RUN_HISTORY_MAX_RUNS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RUNS;
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

function resolveStatusFromLifecyclePhase(
  phase: string,
  data: Record<string, unknown>,
): RunObservabilityStatus {
  if (phase === "start") {
    return "running";
  }
  if (phase === "error") {
    return "failed";
  }
  if (phase === "end") {
    const stopReason = typeof data.stopReason === "string" ? data.stopReason : "";
    if (stopReason === "aborted") {
      return "aborted";
    }
    return "done";
  }
  return "unknown";
}

function normalizeLifecycleEventKind(
  data: Record<string, unknown>,
): RunObservabilityEventKind | null {
  const phase = typeof data.phase === "string" ? data.phase : "";
  if (phase === "start") {
    return "run_started";
  }
  if (phase === "end") {
    return "run_finished";
  }
  if (phase === "error") {
    return "run_failed";
  }
  if (phase) {
    return "run_state";
  }
  return null;
}

function normalizeToolEventKind(data: Record<string, unknown>): RunObservabilityEventKind {
  const phase = typeof data.phase === "string" ? data.phase : "";
  if (phase === "start") {
    return "tool_started";
  }
  if (phase === "update") {
    return "tool_updated";
  }
  const isError = data.isError === true;
  if (phase === "result") {
    return isError ? "tool_failed" : "tool_finished";
  }
  return isError ? "tool_failed" : "tool_finished";
}

function normalizeEventKind(evt: AgentEventPayload): RunObservabilityEventKind | null {
  const data = evt.data ?? {};
  if (evt.stream === "assistant") {
    return null;
  }
  if (evt.stream === "lifecycle") {
    return normalizeLifecycleEventKind(data);
  }
  if (evt.stream === "tool") {
    return normalizeToolEventKind(data);
  }
  if (evt.stream === "guardrail") {
    return "guardrail";
  }
  if (evt.stream === "error") {
    return "error";
  }
  return "warning";
}

function deriveAgentId(sessionKey?: string): string | undefined {
  const parsed = sessionKey ? parseAgentSessionKey(sessionKey) : null;
  return parsed?.agentId ? parsed.agentId : undefined;
}

function pickProvider(data: Record<string, unknown>): string | undefined {
  const candidates = [data.activeProvider, data.selectedProvider, data.provider];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function pickModel(data: Record<string, unknown>): string | undefined {
  const candidates = [data.activeModel, data.selectedModel, data.model];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function normalizeEvent(
  evt: AgentEventPayload,
  idx: number,
  summary: RunObservabilitySummary | null,
): RunObservabilityEvent | null {
  const kind = normalizeEventKind(evt);
  if (!kind) {
    return null;
  }
  const sessionKey =
    typeof evt.sessionKey === "string" && evt.sessionKey.trim()
      ? evt.sessionKey.trim()
      : summary?.sessionKey;
  return {
    idx,
    runId: evt.runId,
    ts: evt.ts,
    stream: evt.stream,
    kind,
    ...(sessionKey ? { sessionKey } : {}),
    ...(deriveAgentId(sessionKey) ? { agentId: deriveAgentId(sessionKey) } : {}),
    data: evt.data ?? {},
  };
}

function buildNextSummary(params: {
  previous: RunObservabilitySummary | null;
  event: RunObservabilityEvent;
}): RunObservabilitySummary {
  const previous = params.previous;
  const evt = params.event;
  const next: RunObservabilitySummary = previous
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

  if (evt.kind === "run_started") {
    next.status = "running";
    next.startedAt =
      typeof evt.data.startedAt === "number" && Number.isFinite(evt.data.startedAt)
        ? evt.data.startedAt
        : evt.ts;
    next.endedAt = undefined;
  } else if (evt.stream === "lifecycle") {
    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
    const status = resolveStatusFromLifecyclePhase(phase, evt.data);
    if (status !== "unknown") {
      next.status = status;
    }
    if (typeof evt.data.startedAt === "number" && Number.isFinite(evt.data.startedAt)) {
      next.startedAt = evt.data.startedAt;
    }
    if (typeof evt.data.endedAt === "number" && Number.isFinite(evt.data.endedAt)) {
      next.endedAt = evt.data.endedAt;
    } else if (evt.kind === "run_finished" || evt.kind === "run_failed") {
      next.endedAt = evt.ts;
    }
  }

  if (evt.kind === "tool_started") {
    next.toolCount += 1;
  }

  return next;
}

export async function persistRunObservabilityEvent(evt: AgentEventPayload): Promise<void> {
  const summaryPath = resolveSummaryPath(evt.runId);
  const previous = await readJsonFile<RunObservabilitySummary>(summaryPath);
  const idx = (previous?.eventCount ?? 0) + 1;
  const normalized = normalizeEvent(evt, idx, previous);
  if (!normalized) {
    return;
  }
  await ensureStoreDirs();
  await fs.appendFile(resolveEventsPath(evt.runId), `${JSON.stringify(normalized)}\n`, "utf8");
  const nextSummary = buildNextSummary({ previous, event: normalized });
  await fs.writeFile(summaryPath, `${JSON.stringify(nextSummary, null, 2)}\n`, "utf8");
  void maybePruneRunObservabilityStore();
}

async function maybePruneRunObservabilityStore(): Promise<void> {
  const now = Date.now();
  if (prunePromise || now - lastPruneAtMs < PRUNE_INTERVAL_MS) {
    return;
  }
  prunePromise = pruneRunObservabilityStore().finally(() => {
    prunePromise = null;
    lastPruneAtMs = Date.now();
  });
  await prunePromise;
}

async function pruneRunObservabilityStore(): Promise<void> {
  const runs = await listRunObservabilitySummaries({});
  if (runs.items.length === 0) {
    return;
  }
  const retentionCutoff = Date.now() - resolveRetentionDays() * 24 * 60 * 60 * 1000;
  const maxRuns = resolveMaxRuns();
  const sorted = runs.items.toSorted((a, b) => a.updatedAt - b.updatedAt);
  const remove = new Set<string>();
  for (const entry of sorted) {
    if (entry.updatedAt < retentionCutoff) {
      remove.add(entry.runId);
    }
  }
  while (sorted.length - remove.size > maxRuns) {
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

async function readRunSummaryFiles(): Promise<RunObservabilitySummary[]> {
  try {
    const entries = await fs.readdir(resolveRunsDir(), { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    const items = await Promise.all(
      files.map(async (entry) =>
        readJsonFile<RunObservabilitySummary>(path.join(resolveRunsDir(), entry.name)),
      ),
    );
    return items.filter((item): item is RunObservabilitySummary => Boolean(item));
  } catch {
    return [];
  }
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

function encodeCursor(summary: RunObservabilitySummary): string {
  return `${summary.updatedAt}:${summary.runId}`;
}

export async function listRunObservabilitySummaries(
  params: RunObservabilityListParams,
): Promise<RunObservabilityPage<RunObservabilitySummary>> {
  const limit = clampLimit(params.limit);
  const cursor = decodeCursor(params.cursor);
  let items = await readRunSummaryFiles();
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
  if (cursor) {
    items = items.filter(
      (item) =>
        item.updatedAt < cursor.updatedAt ||
        (item.updatedAt === cursor.updatedAt && item.runId > cursor.runId),
    );
  }
  const page = items.slice(0, limit);
  return {
    items: page,
    hasMore: items.length > page.length,
    ...(items.length > page.length && page.length > 0
      ? { nextCursor: encodeCursor(page.at(-1)!) }
      : {}),
  };
}

export async function getRunObservabilitySummary(
  runId: string,
): Promise<RunObservabilitySummary | null> {
  if (!runId.trim()) {
    return null;
  }
  return await readJsonFile<RunObservabilitySummary>(resolveSummaryPath(runId));
}

async function readRunEvents(runId: string): Promise<RunObservabilityEvent[]> {
  try {
    const text = await fs.readFile(resolveEventsPath(runId), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunObservabilityEvent);
  } catch {
    return [];
  }
}

function decodeIdxCursor(cursor: string | undefined): number | null {
  const raw = cursor?.trim();
  if (!raw) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function listRunObservabilityEvents(
  params: RunObservabilityEventsParams,
): Promise<RunObservabilityPage<RunObservabilityEvent>> {
  const limit = clampLimit(params.limit);
  const cursorIdx = decodeIdxCursor(params.cursor);
  let items = await readRunEvents(params.runId);
  if (params.stream?.trim()) {
    items = items.filter((item) => item.stream === params.stream?.trim());
  }
  if (params.kind) {
    items = items.filter((item) => item.kind === params.kind);
  }
  if (typeof cursorIdx === "number") {
    items = items.filter((item) => item.idx < cursorIdx);
  }
  const page = items.slice(Math.max(0, items.length - limit));
  return {
    items: page,
    hasMore: items.length > page.length,
    ...(items.length > page.length && page.length > 0 ? { nextCursor: String(page[0].idx) } : {}),
  };
}
