import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type RunsApiPluginConfig = {
  enabled?: boolean;
};

type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

type RunEventsMeta = {
  count: number;
  oldestEventId: string | null;
  newestEventId: string | null;
  retention: {
    kind: "ring";
    maxEvents: number;
  };
};

type RunRecord = {
  runId: string;
  sessionKey?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { message: string };

  // MVP: expose event buffer bounds so clients can reason about cursors/retention.
  events?: RunEventsMeta;
};

type RunEventLevel = "default" | "verbose";

type RunEvent = {
  id: string; // monotonically increasing per run (evt_1, evt_2, ...)
  runId: string;
  ts: string;
  type:
    | "run.started"
    | "phase.changed"
    | "tool.started"
    | "tool.finished"
    | "run.completed"
    | "run.failed";
  level: RunEventLevel;
  data: Record<string, unknown>;
};

function sanitizeForEvents(
  input: unknown,
  opts?: { maxDepth?: number; maxString?: number; maxKeys?: number },
): unknown {
  const maxDepth = opts?.maxDepth ?? 4;
  const maxString = opts?.maxString ?? 400;
  const maxKeys = opts?.maxKeys ?? 50;

  const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|bearer|cookie)/i;
  const SECRET_VALUE_RE =
    /(Bearer\s+[A-Za-z0-9._\-]+|sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})/;

  const seen = new WeakSet<object>();

  function clipString(s: string): string {
    if (s.length <= maxString) return s;
    return s.slice(0, maxString) + "…";
  }

  function walk(v: unknown, depth: number, keyHint?: string): unknown {
    if (v === null || v === undefined) return v;
    if (typeof v === "string") {
      if ((keyHint && SECRET_KEY_RE.test(keyHint)) || SECRET_VALUE_RE.test(v)) return "[REDACTED]";
      return clipString(v);
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "function") return "[Function]";

    if (depth >= maxDepth) return "[Truncated]";

    if (Array.isArray(v)) {
      return v.slice(0, 50).map((x) => walk(x, depth + 1));
    }
    if (typeof v === "object") {
      if (seen.has(v as object)) return "[Circular]";
      seen.add(v as object);
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const keys = Object.keys(obj);
      for (const k of keys.slice(0, maxKeys)) {
        if (SECRET_KEY_RE.test(k)) {
          out[k] = "[REDACTED]";
        } else {
          out[k] = walk(obj[k], depth + 1, k);
        }
      }
      if (keys.length > maxKeys) out["…"] = `[Truncated keys: ${keys.length - maxKeys} more]`;
      return out;
    }

    return String(v);
  }

  return walk(input, 0);
}

function nowIso(): string {
  return new Date().toISOString();
}

function statePath(...parts: string[]): string {
  // Keep all plugin state under the canonical OpenClaw state dir.
  return path.join("/var/lib/openclaw/state", "runs-api", ...parts);
}

function ensureStateDir() {
  const dir = statePath();
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath: string, obj: unknown) {
  ensureStateDir();
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
}

function readJsonFileIfExists(filePath: string): any | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (e: any) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return undefined;
    throw e;
  }
}

function json(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(body);
}

function extractGatewayToken(req: IncomingMessage): string | undefined {
  const auth =
    typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const headerToken =
    typeof req.headers["x-openclaw-token"] === "string"
      ? req.headers["x-openclaw-token"].trim()
      : "";
  if (headerToken) return headerToken;
  return undefined;
}

function requireTokenAuth(
  api: OpenClawPluginApi,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const mode = api.config.gateway?.auth?.mode;
  if (mode !== "token") return true; // other modes: let core handle overall exposure
  const expected = api.config.gateway?.auth?.token;
  const got = extractGatewayToken(req);
  if (!expected || got !== expected) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function getPathname(req: IncomingMessage): string {
  // req.url is path + query; host is irrelevant for routing
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.pathname;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 256_000): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function genRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const MAX_EVENTS_PER_RUN = 500;

const runsApiPlugin = {
  id: "runs-api",
  name: "Runs API (MVP)",
  description: "MVP scaffolding for an official /v1/runs API.",
  kind: "gateway",
  // Config validation kept minimal (Slice 0/1 safety): only allow { enabled?: boolean }
  configSchema: {
    safeParse(value: unknown) {
      if (value === undefined) return { success: true as const, data: undefined };
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false as const,
          error: { issues: [{ path: [], message: "expected config object" }] },
        };
      }
      const obj = value as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (k !== "enabled") {
          return {
            success: false as const,
            error: { issues: [{ path: [k], message: "unknown field" }] },
          };
        }
      }
      if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
        return {
          success: false as const,
          error: {
            issues: [{ path: ["enabled"], message: "expected boolean" }],
          },
        };
      }
      return { success: true as const, data: obj as RunsApiPluginConfig };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as RunsApiPluginConfig;
    if (!cfg.enabled) {
      api.logger.info("runs-api: disabled (no routes registered)");
      return;
    }

    // Slice 2/3: in-memory run registry + event buffer (resets on gateway restart).
    const runs = new Map<string, RunRecord>();
    const runEvents = new Map<string, RunEvent[]>();
    const runEventSeq = new Map<string, number>();

    // Slice 3.5: live tailing — keep track of open SSE subscribers per run.
    type SseSubscriber = {
      res: ServerResponse;
      level: RunEventLevel;
      typeSet: Set<string>; // empty => all
    };
    const subscribers = new Map<string, Set<SseSubscriber>>();

    // Slice 4 (4B start): associate live OpenClaw tool hooks with a runId.
    // IMPORTANT: this mapping must be visible to BOTH the HTTP handlers and the hook callbacks.
    // We therefore persist it to a small JSON file in /var/lib/openclaw/state/runs-api/.
    const sessionToRunId = new Map<string, string>();
    const sessionMapFile = statePath("session-to-run.json");
    let sessionMapMtimeMs: number | null = null;
    let sessionMapLastLoadMs = 0;

    function loadSessionMapFromDisk(force = false) {
      // Cheap mtime-based cache; also protects hooks from reading on every call.
      const now = Date.now();
      if (!force && now - sessionMapLastLoadMs < 500) return;
      sessionMapLastLoadMs = now;
      try {
        const st = fs.statSync(sessionMapFile);
        if (!force && sessionMapMtimeMs !== null && st.mtimeMs === sessionMapMtimeMs) return;
        const data = readJsonFileIfExists(sessionMapFile) ?? {};
        sessionToRunId.clear();
        for (const [k, v] of Object.entries(data)) {
          if (typeof k === "string" && typeof v === "string" && k && v) sessionToRunId.set(k, v);
        }
        sessionMapMtimeMs = st.mtimeMs;
      } catch (e: any) {
        if (e && e.code === "ENOENT") {
          sessionToRunId.clear();
          sessionMapMtimeMs = null;
          return;
        }
        throw e;
      }
    }

    function persistSessionMapToDisk() {
      const obj: Record<string, string> = {};
      for (const [k, v] of sessionToRunId.entries()) obj[k] = v;
      atomicWriteJson(sessionMapFile, obj);
      try {
        sessionMapMtimeMs = fs.statSync(sessionMapFile).mtimeMs;
      } catch {
        // ignore
      }
    }
    const pendingToolCalls = new Map<
      string,
      {
        runId: string;
        toolName?: string;
        startedAtMs: number;
        startedEventId?: string;
      }
    >();

    // Last-resort correlation when after_tool_call doesn't provide sessionKey or a stable call id.
    // We keep a short FIFO per toolName and match the most recent pending call.
    // This is best-effort and should be replaced once core hook contexts expose a stable invocation id.
    const pendingByToolName = new Map<
      string,
      Array<{
        runId: string;
        toolName: string;
        startedAtMs: number;
        startedEventId: string;
      }>
    >();

    function nextEventId(runId: string): string {
      const n = (runEventSeq.get(runId) ?? 0) + 1;
      runEventSeq.set(runId, n);
      return `evt_${n}`;
    }

    function emit(
      runId: string,
      evt: Omit<RunEvent, "id" | "runId" | "ts"> & { ts?: string },
    ): RunEvent {
      const e: RunEvent = {
        id: nextEventId(runId),
        runId,
        ts: evt.ts ?? nowIso(),
        type: evt.type,
        level: evt.level,
        data: evt.data ?? {},
      };
      const buf = runEvents.get(runId) ?? [];
      buf.push(e);
      // MVP retention guardrails (keep it simple/safe): keep last N events.
      if (buf.length > MAX_EVENTS_PER_RUN) buf.splice(0, buf.length - MAX_EVENTS_PER_RUN);
      runEvents.set(runId, buf);

      // Live tailing: push newly emitted events to any open SSE subscribers for this run.
      const subs = subscribers.get(runId);
      if (subs && subs.size > 0) {
        for (const sub of Array.from(subs)) {
          try {
            if (sub.level === "default" && e.level !== "default") continue;
            if (sub.typeSet.size > 0 && !sub.typeSet.has(e.type)) continue;
            sseSend(sub.res, e);
          } catch {
            // If the socket is gone, drop subscriber.
            subs.delete(sub);
          }
        }
        if (subs.size === 0) subscribers.delete(runId);
      }

      return e;
    }

    function getEventsMeta(runId: string): RunEventsMeta {
      const all = runEvents.get(runId) ?? [];
      return {
        count: all.length,
        oldestEventId: all.length ? all[0].id : null,
        newestEventId: all.length ? all[all.length - 1].id : null,
        retention: { kind: "ring", maxEvents: MAX_EVENTS_PER_RUN },
      };
    }

    function sseSend(res: ServerResponse, event: RunEvent) {
      // SSE data must be single-line or split; JSON stringify is fine as a single line.
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const RUNS_API_DEBUG = process.env.RUNS_API_DEBUG === "1";

    function getToolCallKey(event: any, ctx: any): string | undefined {
      // Try the most likely stable identifiers first.
      const candidates = [
        ctx?.toolCallId,
        ctx?.callId,
        ctx?.invocationId,
        event?.toolCallId,
        event?.callId,
        event?.invocationId,
        event?.spanId,
        event?.span?.id,
        event?.id,
        ctx?.id,
      ].filter((v) => typeof v === "string" && v.length > 0) as string[];
      return candidates[0];
    }

    api.logger.info(
      `runs-api: enabled (registering HTTP handlers)${RUNS_API_DEBUG ? " [RUNS_API_DEBUG=1]" : ""}`,
    );

    // Slice 4: emit tool.started/tool.finished for runs that were created with { sessionKey }.
    // Debugging note: we intentionally avoid adding extra config fields here because the core
    // gateway config schema is strict and rejects unknown properties.

    // Fallback correlation map: ctx object identity -> pending tool call
    const pendingToolCallsByCtx = new WeakMap<
      object,
      {
        runId: string;
        toolName: string;
        startedAtMs: number;
        startedEventId: string;
      }
    >();

    api.on("before_tool_call", (event, ctx) => {
      const sk = ctx.sessionKey;
      const toolName = ctx.toolName ?? event.toolName;
      const callKey = getToolCallKey(event, ctx);

      if (RUNS_API_DEBUG) {
        const keys = Object.keys(event ?? {}).slice(0, 40);
        api.logger.info(
          `runs-api hook(before_tool_call): sessionKey=${sk ?? "(none)"} tool=${toolName ?? "(unknown)"} callKey=${
            callKey ?? "(none)"
          } eventKeys=${keys.join(",")}`,
        );
      }

      if (!sk) return;
      loadSessionMapFromDisk();
      const runId = sessionToRunId.get(sk);
      if (RUNS_API_DEBUG) {
        api.logger.info(
          `runs-api hook(before_tool_call): mapped runId=${runId ?? "(none)"} (knownRuns=${runs.size})`,
        );
      }
      if (!runId) return;
      if (!runs.has(runId)) return;

      if (RUNS_API_DEBUG) {
        // A tiny marker event that lets us see that hooks fire and mapping works, without leaking params.
        emit(runId, {
          type: "phase.changed",
          level: "verbose",
          data: { phase: "hook.before_tool_call" },
        });
      }

      const started = emit(runId, {
        type: "tool.started",
        level: "verbose",
        data: {
          toolName,
          params: sanitizeForEvents(event.params),
        },
      });

      // Record a correlation so we can emit tool.finished even if after_tool_call lacks ctx.sessionKey.
      // 1) callKey (preferred, if the hook provides one)
      // 2) ctx object identity (fallback; OpenClaw hooks currently don't expose a stable call id)
      const pendingRec = {
        runId,
        toolName: toolName ?? "(unknown)",
        startedAtMs: Date.now(),
        startedEventId: started.id,
      };
      if (callKey) pendingToolCalls.set(callKey, pendingRec);
      if (ctx && typeof ctx === "object") pendingToolCallsByCtx.set(ctx as object, pendingRec);

      const tn = pendingRec.toolName;
      const fifo = pendingByToolName.get(tn) ?? [];
      fifo.push({
        runId,
        toolName: tn,
        startedAtMs: pendingRec.startedAtMs,
        startedEventId: started.id,
      });
      // keep it short to avoid unbounded growth
      if (fifo.length > 50) fifo.splice(0, fifo.length - 50);
      pendingByToolName.set(tn, fifo);
    });

    api.on("after_tool_call", (event, ctx) => {
      const sk = ctx.sessionKey;
      const toolName = ctx.toolName ?? event.toolName;
      const callKey = getToolCallKey(event, ctx);

      if (RUNS_API_DEBUG) {
        api.logger.info(
          `runs-api hook(after_tool_call): sessionKey=${sk ?? "(none)"} tool=${toolName ?? "(unknown)"} callKey=${
            callKey ?? "(none)"
          } ok=${!event.error}`,
        );
      }

      // Prefer mapping by sessionKey when available.
      let runId: string | undefined;
      if (sk) {
        loadSessionMapFromDisk();
        runId = sessionToRunId.get(sk);
      }

      // Fallback: correlate without sessionKey.
      // 1) by tool-call key when available
      // 2) by ctx identity when callKey is missing
      let pending:
        | {
            runId: string;
            toolName?: string;
            startedAtMs: number;
            startedEventId?: string;
          }
        | undefined;
      if (!runId && callKey) {
        pending = pendingToolCalls.get(callKey);
        runId = pending?.runId;
      }
      if (!runId && !pending && ctx && typeof ctx === "object") {
        pending = pendingToolCallsByCtx.get(ctx as object);
        runId = pending?.runId;
      }

      // Last resort: match most recent pending call by toolName (best-effort).
      if (!runId) {
        const tn = toolName ?? "(unknown)";
        const fifo = pendingByToolName.get(tn);
        if (fifo && fifo.length) {
          const rec = fifo.pop();
          if (rec) {
            pending = rec;
            runId = rec.runId;
          }
        }
      }

      if (!runId) return;
      if (!runs.has(runId)) return;

      const durationMs =
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
          ? event.durationMs
          : pending
            ? Date.now() - pending.startedAtMs
            : undefined;

      emit(runId, {
        type: "tool.finished",
        level: "verbose",
        data: {
          toolName: toolName ?? pending?.toolName,
          ok: !event.error,
          error: RUNS_API_DEBUG ? sanitizeForEvents(event.error) : undefined,
          durationMs,
          startedEventId: pending?.startedEventId,
        },
      });

      if (callKey) pendingToolCalls.delete(callKey);
    });

    api.registerHttpRoute({
      path: "/v1/runs",
      auth: "gateway",
      match: "prefix",
      handler: async (req, res) => {
        const pathname = getPathname(req);
        const method = (req.method ?? "GET").toUpperCase();

        // POST /v1/runs — create a minimal run record (MVP convenience for testing Slice 2).
        if (method === "POST" && pathname === "/v1/runs") {
          if (!requireTokenAuth(api, req, res)) return true;

          try {
            const body = await readJsonBody(req);
            const sessionKey =
              typeof body?.sessionKey === "string" ? body.sessionKey.trim() : undefined;
            const runId = genRunId();
            const ts = nowIso();
            const status: RunStatus = (body?.status as RunStatus) ?? "running";

            const rec: RunRecord = {
              runId,
              sessionKey,
              status,
              createdAt: ts,
              updatedAt: ts,
              startedAt: ts,
            };
            runs.set(runId, rec);
            runEvents.set(runId, []);
            runEventSeq.set(runId, 0);

            if (sessionKey) {
              loadSessionMapFromDisk(true);
              sessionToRunId.set(sessionKey, runId);
              persistSessionMapToDisk();
            }

            emit(runId, {
              type: "run.started",
              level: "default",
              data: { status },
            });
            emit(runId, {
              type: "phase.changed",
              level: "default",
              data: { phase: "exec" },
            });

            json(res, 201, { ...rec, events: getEventsMeta(runId) });
            return true;
          } catch (e: any) {
            if (String(e?.message ?? e) === "body_too_large") {
              json(res, 413, { error: "body_too_large" });
              return true;
            }
            json(res, 400, { error: "invalid_json" });
            return true;
          }
        }

        // GET /v1/runs/{runId}/events (Slice 3: SSE stream)
        const evm = pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
        if (method === "GET" && evm) {
          if (!requireTokenAuth(api, req, res)) return true;
          const runId = evm[1];
          if (!runs.has(runId)) {
            json(res, 404, {
              error: "not_found",
              message: "Run not found",
              runId,
            });
            return true;
          }

          const url = new URL(req.url ?? "/", "http://localhost");
          const since = url.searchParams.get("since");
          const level = (url.searchParams.get("level") as RunEventLevel | null) ?? "verbose";

          // Optional filter: ?types=tool.started,tool.finished (comma-separated; may repeat).
          const allowedTypes: RunEvent["type"][] = [
            "run.started",
            "phase.changed",
            "tool.started",
            "tool.finished",
            "run.completed",
            "run.failed",
          ];
          const typeParams = url.searchParams.getAll("types");
          const typeTokens = typeParams
            .flatMap((v) => v.split(","))
            .map((s) => s.trim())
            .filter(Boolean);
          const typeSet = new Set<string>(typeTokens);
          if (typeTokens.length > 0) {
            for (const t of typeTokens) {
              if (!allowedTypes.includes(t as any)) {
                json(res, 400, {
                  error: "invalid_types",
                  message: `Unknown event type '${t}'.`,
                  allowedTypes,
                });
                return true;
              }
            }
          }

          const all = runEvents.get(runId) ?? [];
          let startIdx = 0;
          if (since) {
            const idx = all.findIndex((e) => e.id === since);
            if (idx >= 0) {
              startIdx = idx + 1;
            } else if (all.length > 0) {
              // Cursor is unknown and we do have buffered events: treat this as "cursor too old".
              // (MVP: we only keep a bounded in-memory buffer per run.)
              json(res, 410, {
                error: "cursor_gone",
                message:
                  "The provided cursor is not available anymore (events retention exceeded).",
                runId,
                since,
                oldestAvailable: all[0].id,
                newestAvailable: all[all.length - 1].id,
              });
              return true;
            }
          }

          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream; charset=utf-8");
          res.setHeader("cache-control", "no-cache, no-transform");
          res.setHeader("connection", "keep-alive");
          // helpful for reverse proxies
          res.setHeader("x-accel-buffering", "no");

          for (let i = startIdx; i < all.length; i++) {
            const e = all[i];
            if (level === "default" && e.level !== "default") continue;
            if (typeSet.size > 0 && !typeSet.has(e.type)) continue;
            sseSend(res, e);
          }

          // Keep the stream open and send a heartbeat comment every 25s.
          const heartbeat = setInterval(() => {
            res.write(`: heartbeat ${Date.now()}\n\n`);
          }, 25_000);

          // Register for live tailing.
          const sub: SseSubscriber = { res, level, typeSet };
          const set = subscribers.get(runId) ?? new Set<SseSubscriber>();
          set.add(sub);
          subscribers.set(runId, set);

          req.on("close", () => {
            clearInterval(heartbeat);
            const s = subscribers.get(runId);
            if (s) {
              s.delete(sub);
              if (s.size === 0) subscribers.delete(runId);
            }
            try {
              res.end();
            } catch {
              // ignore
            }
          });

          return true;
        }

        // POST /v1/runs/{runId}/bind — bind a sessionKey to an existing run (useful if you created the run first).
        const bindm = pathname.match(/^\/v1\/runs\/([^/]+)\/bind$/);
        if (method === "POST" && bindm) {
          if (!requireTokenAuth(api, req, res)) return true;
          const runId = bindm[1];
          const rec = runs.get(runId);
          if (!rec) {
            json(res, 404, {
              error: "not_found",
              message: "Run not found",
              runId,
            });
            return true;
          }
          try {
            const body = await readJsonBody(req);
            const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
            if (!sessionKey) {
              json(res, 400, {
                error: "invalid_request",
                message: "sessionKey is required",
              });
              return true;
            }
            rec.sessionKey = sessionKey;
            rec.updatedAt = nowIso();
            loadSessionMapFromDisk(true);
            sessionToRunId.set(sessionKey, runId);
            persistSessionMapToDisk();
            json(res, 200, { ok: true, runId, sessionKey });
            return true;
          } catch {
            json(res, 400, { error: "invalid_json" });
            return true;
          }
        }

        // GET /v1/runs/{runId}
        const m = pathname.match(/^\/v1\/runs\/([^/]+)$/);
        if (method === "GET" && m) {
          if (!requireTokenAuth(api, req, res)) return true;
          const runId = m[1];
          const rec = runs.get(runId);
          if (!rec) {
            json(res, 404, {
              error: "not_found",
              message: "Run not found (Slice 2: in-memory registry; create via POST /v1/runs).",
              runId,
            });
            return true;
          }
          json(res, 200, { ...rec, events: getEventsMeta(runId) });
          return true;
        }

        return false;
      },
    });
  },
};

export default runsApiPlugin;
