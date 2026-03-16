import { type Bot } from "grammy";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { markdownToTelegramHtml } from "../format.js";
import {
  buildInlineKeyboard,
  REPLY_PARAM_FALLBACK,
  THREAD_PARAM_FALLBACK,
  withTelegramSendParamFallbacks,
} from "../send.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./helpers.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const EMPTY_TEXT_ERR_RE = /message text is empty/i;
export async function sendTelegramWithThreadFallback<T>(params: {
  operation: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  requestParams: Record<string, unknown>;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
  shouldLog?: (err: unknown) => boolean;
}): Promise<T> {
  const allowThreadlessRetry = params.thread?.scope === "dm";
  const shouldSuppressFallbackErrorLog = (
    err: unknown,
    effectiveParams: Record<string, unknown> | undefined,
  ) =>
    (allowThreadlessRetry &&
      THREAD_PARAM_FALLBACK.hasFallbackParams(effectiveParams) &&
      THREAD_PARAM_FALLBACK.shouldFallback(err)) ||
    (REPLY_PARAM_FALLBACK.hasFallbackParams(effectiveParams) &&
      REPLY_PARAM_FALLBACK.shouldFallback(err));

  const mergedShouldLogForParams = (effectiveParams: Record<string, unknown> | undefined) =>
    params.shouldLog
      ? (err: unknown) =>
          params.shouldLog!(err) && !shouldSuppressFallbackErrorLog(err, effectiveParams)
      : (err: unknown) => !shouldSuppressFallbackErrorLog(err, effectiveParams);

  return await withTelegramSendParamFallbacks({
    requestParams: params.requestParams,
    label: params.operation,
    verbose: false,
    allowThreadFallback: allowThreadlessRetry,
    attempt: async (effectiveParams, effectiveLabel) =>
      await withTelegramApiErrorLogging({
        operation: effectiveLabel,
        runtime: params.runtime,
        shouldLog: mergedShouldLogForParams(effectiveParams),
        fn: () => params.send(effectiveParams ?? {}),
      }),
  });
}

export function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  thread?: TelegramThreadSpec | null;
}): Record<string, unknown> {
  const threadParams = buildTelegramThreadParams(opts?.thread);
  const params: Record<string, unknown> = {};
  if (opts?.replyToMessageId) {
    params.reply_to_message_id = opts.replyToMessageId;
  }
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }
  return params;
}

export async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: {
    replyToMessageId?: number;
    replyQuoteText?: string;
    thread?: TelegramThreadSpec | null;
    textMode?: "markdown" | "html";
    plainText?: string;
    linkPreview?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number> {
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    thread: opts?.thread,
  });
  // Add link_preview_options when link preview is disabled.
  const linkPreviewEnabled = opts?.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const textMode = opts?.textMode ?? "markdown";
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  const fallbackText = opts?.plainText ?? text;
  const hasFallbackText = fallbackText.trim().length > 0;
  const sendPlainFallback = async () => {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, fallbackText, {
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id} (plain)`);
    return res.message_id;
  };

  // Markdown can render to empty HTML for syntax-only chunks; recover with plain text.
  if (!htmlText.trim()) {
    if (!hasFallbackText) {
      throw new Error("telegram sendMessage failed: empty formatted text and empty plain fallback");
    }
    return await sendPlainFallback();
  }
  try {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      shouldLog: (err) => {
        const errText = formatErrorMessage(err);
        return !PARSE_ERR_RE.test(errText) && !EMPTY_TEXT_ERR_RE.test(errText);
      },
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, htmlText, {
          parse_mode: "HTML",
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id}`);
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (PARSE_ERR_RE.test(errText) || EMPTY_TEXT_ERR_RE.test(errText)) {
      if (!hasFallbackText) {
        throw err;
      }
      runtime.log?.(`telegram formatted send failed; retrying without formatting: ${errText}`);
      return await sendPlainFallback();
    }
    throw err;
  }
}
