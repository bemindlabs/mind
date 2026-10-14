/**
 * The Telegram adapter (S9.1, D-066) — Bot API long polling and sendMessage,
 * and nothing that decides anything (that is `chat.ts`).
 *
 * Its own bot: Telegram hands a bot's updates to one poller, so sharing a token
 * with another program would take messages away from it.
 */

import type { ChatConnector, ChatMessage, SendResult } from "./chat.ts";

export const TELEGRAM_API = "https://api.telegram.org";
/** Telegram's own cap on one message. */
export const TELEGRAM_MAX_TEXT = 4096;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The API base to use: Telegram's, or an override that is https or loopback (a stub in a test). */
export function telegramBase(raw: string | undefined): string {
  if (raw === undefined || raw === "") return TELEGRAM_API;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return raw.replace(/\/+$/, "");
  } catch {
    // Not a URL: the real API, never wherever it pointed.
  }
  return TELEGRAM_API;
}

/** Updates → messages. Only private text messages from a user; everything else is skipped. */
export function toMessages(body: unknown): { readonly messages: readonly ChatMessage[]; readonly next: number | undefined } {
  const result = (body as { ok?: unknown; result?: unknown } | null)?.result;
  if (!Array.isArray(result)) return { messages: [], next: undefined };
  const messages: ChatMessage[] = [];
  let next: number | undefined;
  for (const update of result as Record<string, unknown>[]) {
    const id = update["update_id"];
    if (typeof id === "number") next = Math.max(next ?? 0, id + 1);
    const m = update["message"] as Record<string, unknown> | undefined;
    const from = m?.["from"] as Record<string, unknown> | undefined;
    const chat = m?.["chat"] as Record<string, unknown> | undefined;
    if (typeof m?.["text"] !== "string" || typeof from?.["id"] !== "number" || typeof chat?.["id"] !== "number") continue;
    if (from["is_bot"] === true || chat["type"] !== "private") continue;
    messages.push({ platform: "telegram", chatId: String(chat["id"]), userId: String(from["id"]), messageId: String(m["message_id"]), text: m["text"] as string });
  }
  return { messages, next };
}

export class TelegramConnector implements ChatConnector {
  readonly platform = "telegram";
  private offset: number | undefined;

  constructor(
    private readonly token: string,
    private readonly options: { readonly base?: string; readonly fetch?: Fetch; readonly pollSeconds?: number; readonly offset?: number | undefined; readonly onOffset?: (offset: number) => void } = {},
  ) {
    this.offset = options.offset;
  }

  private url(method: string): string {
    return `${this.options.base ?? TELEGRAM_API}/bot${this.token}/${method}`;
  }

  async poll(): Promise<{ readonly messages: readonly ChatMessage[]; readonly error?: string }> {
    const params = new URLSearchParams({ timeout: String(this.options.pollSeconds ?? 25), allowed_updates: JSON.stringify(["message"]) });
    if (this.offset !== undefined) params.set("offset", String(this.offset));
    try {
      const res = await (this.options.fetch ?? fetch)(`${this.url("getUpdates")}?${params}`, { signal: AbortSignal.timeout(((this.options.pollSeconds ?? 25) + 10) * 1000) });
      if (!res.ok) return { messages: [], error: `Telegram answered ${res.status}` };
      const read = toMessages(await res.json());
      if (read.next !== undefined) {
        this.offset = read.next;
        this.options.onOffset?.(read.next);
      }
      return { messages: read.messages };
    } catch (error) {
      return { messages: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async send(chatId: string, text: string): Promise<SendResult> {
    try {
      const res = await (this.options.fetch ?? fetch)(this.url("sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, TELEGRAM_MAX_TEXT) }),
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok ? { ok: true } : { ok: false, reason: `Telegram answered ${res.status}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
