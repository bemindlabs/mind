/**
 * The bot bridge (S9, p4/p5) — one interface for talking to another assistant's bot as if it were a chat platform.
 *
 * A bot is a `ChatConnector` (`platform`, `poll`, `send`) that also says, up front, where it talks to, where its
 * token is kept and what it may do. Everything that decides — who is answered, what must be said, what may leave —
 * is `handleMessage` and the shared guard (`bot-guard.ts`), once, for every bot. A new bot is a new file that
 * implements `BotAdapter` and is handed to {@link BotRegistry.register}; the core does not change (S9.1 AC4).
 *
 * ## What the registry will not take
 *
 * An adapter that fails {@link checkBotAdapter} is not registered, and what it is checked on is all static, so
 * registering never calls the bot:
 * - an id and a platform that are the same, in a plain alphabet (the ledger names a chat by its platform);
 * - an endpoint that is an origin and nothing more — `https`, or `http` on a loopback address (a fake in a test);
 *   no credentials, no path, no query;
 * - an absolute token-file path — the token itself is never part of an adapter's description;
 * - `initiates: false` — a bot only answers, it never opens a conversation (the guard enforces it on every send);
 * - a positive text limit.
 *
 * Behavior (never throws, errors become an empty poll or a failed send, nothing but screened text and a chat id on
 * the wire) is held by `test/support/bot-conformance.ts`, run once per adapter against the fake bot server; a test
 * fails when a registered adapter has no such run.
 *
 * Off by default (S9 AC5): a registry holds adapters and starts nothing. Turning one on is the owner's, per bot,
 * with its own typed phrase — not here.
 */

import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import type { ChatConnector } from "./chat.ts";

export interface BotCapabilities {
  /** A bot only answers. It is `false` for every adapter; the type says so and the guard holds it. */
  readonly initiates: false;
  /** The longest text one `send` may carry, in UTF-8 bytes. */
  readonly maxTextBytes: number;
}

export interface BotAdapter extends ChatConnector {
  /** Lowercase letters, digits and `-`; the same string as {@link ChatConnector.platform}. */
  readonly botId: string;
  /** Scheme, host and port only: `https://…`, or `http://127.0.0.1:<port>` for a fake. */
  readonly endpointOrigin: string;
  /** Absolute path of the file holding the token, mode 600. Never the token. */
  readonly tokenFile: string;
  readonly capabilities: BotCapabilities;
}

const BOT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];

/** Why `origin` may not be talked to, or `undefined`. https anywhere; http only on loopback; nothing after the port. */
export function originProblem(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return `endpointOrigin is not a URL: ${JSON.stringify(origin)}`;
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return `endpointOrigin must be https, or http on a loopback address: ${url.origin}`;
  }
  if (url.username !== "" || url.password !== "") return "endpointOrigin must not carry credentials";
  if (url.origin !== origin) return `endpointOrigin must be an origin only (${url.origin}), with no path, query or trailing slash`;
  return undefined;
}

/** Everything wrong with an adapter that can be seen without calling it. Empty means it may be registered. */
export function checkBotAdapter(adapter: BotAdapter): readonly string[] {
  const problems: string[] = [];
  if (!BOT_ID.test(adapter.botId)) problems.push(`botId must match ${BOT_ID}: ${JSON.stringify(adapter.botId)}`);
  if (adapter.platform !== adapter.botId) problems.push(`platform (${JSON.stringify(adapter.platform)}) must be the botId`);
  const origin = originProblem(adapter.endpointOrigin);
  if (origin !== undefined) problems.push(origin);
  if (!isAbsolute(adapter.tokenFile)) problems.push("tokenFile must be an absolute path");
  if ((adapter.capabilities as { initiates: unknown }).initiates !== false) problems.push("capabilities.initiates must be false: a bot never starts a conversation");
  const max = adapter.capabilities.maxTextBytes;
  if (!Number.isInteger(max) || max <= 0) problems.push("capabilities.maxTextBytes must be a positive integer");
  if (typeof adapter.poll !== "function" || typeof adapter.send !== "function") problems.push("poll and send must be functions");
  return problems;
}

export type Registration = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/** The adapters that passed {@link checkBotAdapter}. Holding one starts nothing and calls nothing. */
export class BotRegistry {
  private readonly adapters = new Map<string, BotAdapter>();

  register(adapter: BotAdapter): Registration {
    const problems = [...checkBotAdapter(adapter)];
    if (this.adapters.has(adapter.botId)) problems.push(`a bot with the id ${JSON.stringify(adapter.botId)} is already registered`);
    if (problems.length > 0) return { ok: false, problems };
    this.adapters.set(adapter.botId, adapter);
    return { ok: true };
  }

  get(botId: string): BotAdapter | undefined {
    return this.adapters.get(botId);
  }

  /** Registered ids, in the order they were registered. */
  ids(): readonly string[] {
    return [...this.adapters.keys()];
  }
}

/** Why the token file may not be read, or `undefined`: it must exist, be a regular file, and be private to its owner. */
export async function tokenFileProblem(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return `the token file ${path} cannot be read`;
  }
  if (!info.isFile()) return `the token file ${path} is not a regular file`;
  if ((info.mode & 0o077) !== 0) return `the token file ${path} must be mode 600 (it is ${(info.mode & 0o777).toString(8)})`;
  return undefined;
}
