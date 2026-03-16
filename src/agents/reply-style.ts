import type { SessionReplyStyle } from "../config/sessions/types.js";

const TELEGRAM_GPT54_COMPACT_REPLIES_ENV = "OPENCLAW_TELEGRAM_GPT54_COMPACT_REPLIES";

export function resolveReplyStyleForRun(params: {
  env?: NodeJS.ProcessEnv;
  channel?: string | null;
  provider: string;
  model: string;
}): SessionReplyStyle | undefined {
  const channel = params.channel?.trim().toLowerCase() ?? "";
  const enabled = (params.env ?? process.env)[TELEGRAM_GPT54_COMPACT_REPLIES_ENV] === "1";
  if (
    enabled &&
    channel === "telegram" &&
    params.provider === "openai-codex" &&
    params.model === "gpt-5.4"
  ) {
    return { compact: true };
  }
  return undefined;
}
