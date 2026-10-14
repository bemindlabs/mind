/**
 * Consent per bot (S9 AC5, p5 step 4): a bot is served only when the owner has typed that bot's own phrase.
 *
 * As a person is let in by a phrase typed at a terminal (D-066) and a peer likewise (D-063), a bot is let in by
 * `serve bot <botId> at <origin>` — its id **and** the address it talks to. Two things follow, and the tests hold
 * both: approving one bot says nothing about another, and a bot whose address has changed since the approval is not
 * approved any more, because the owner approved a conversation with *that* address.
 *
 * Granting is a pure function of what was typed: the caller shows the phrase, reads a line, and hands it here. The
 * file is the owner's record, not a switch an agent can flip on its own — nothing in `src/` calls {@link grantBot}
 * except a command that has read the phrase from a person. A file that cannot be read or does not parse means nobody
 * is approved; the safe failure is silence.
 *
 * {@link servableBots} is what a serve command asks: of the registered bots, which may be started, and for each of
 * the others why not. It starts nothing and calls no bot.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "../env.ts";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import type { BotAdapter, BotRegistry } from "./bot.ts";
import { botServeProblem } from "./bot-guard.ts";

export const BOTS_DIR = "bots";

export interface BotApproval {
  readonly botId: string;
  /** The address that was approved. A different address is not this approval. */
  readonly endpointOrigin: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface BotConsent {
  readonly approvals: readonly BotApproval[];
}

const NOBODY: BotConsent = { approvals: [] };

/** This subject's bot state. `erase` is to remove the directory whole (p5 step 6). */
export function botsDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(stateRoot(env.home, env.env), BOTS_DIR, subject);
}

export function botConsentPath(botsDir: string): string {
  return join(botsDir, "consent.json");
}

/** The phrase the owner types to let one bot be served at one address. */
export function botConsentPhrase(botId: string, endpointOrigin: string): string {
  return `serve bot ${botId} at ${endpointOrigin}`;
}

export async function readBotConsent(botsDir: string): Promise<BotConsent> {
  try {
    const raw = JSON.parse(await readFile(botConsentPath(botsDir), "utf8")) as { approvals?: unknown };
    if (!Array.isArray(raw.approvals)) return NOBODY;
    const approvals = (raw.approvals as Partial<BotApproval>[]).filter(
      (a): a is BotApproval =>
        typeof a?.botId === "string" && typeof a.endpointOrigin === "string" && typeof a.approvedBy === "string" && typeof a.approvedAt === "string",
    );
    return { approvals };
  } catch {
    return NOBODY;
  }
}

export async function writeBotConsent(botsDir: string, consent: BotConsent): Promise<void> {
  await mkdir(botsDir, { recursive: true, mode: 0o700 });
  const path = botConsentPath(botsDir);
  const temp = `${path}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(consent, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** Is this bot, at the address it has now, approved? Only an exact id and an exact origin count. */
export function isBotApproved(consent: BotConsent, adapter: Pick<BotAdapter, "botId" | "endpointOrigin">): boolean {
  return consent.approvals.some((a) => a.botId === adapter.botId && a.endpointOrigin === adapter.endpointOrigin);
}

export type Grant = { readonly ok: true; readonly consent: BotConsent } | { readonly ok: false; readonly reason: string };

/**
 * The owner's typed text against the bot's phrase. Exact match, after trimming the line's ends and nothing more: a
 * near miss, another bot's phrase, or the phrase for another address grants nothing. An earlier approval of the same
 * bot at another address is replaced, so a bot has at most one approval.
 */
export function grantBot(consent: BotConsent, adapter: Pick<BotAdapter, "botId" | "endpointOrigin">, typed: string, approvedBy: string, now: Date): Grant {
  const phrase = botConsentPhrase(adapter.botId, adapter.endpointOrigin);
  if (typed.trim() !== phrase) return { ok: false, reason: `not approved: to serve ${adapter.botId} type exactly: ${phrase}` };
  const others = consent.approvals.filter((a) => a.botId !== adapter.botId);
  return {
    ok: true,
    consent: { approvals: [...others, { botId: adapter.botId, endpointOrigin: adapter.endpointOrigin, approvedBy, approvedAt: now.toISOString() }] },
  };
}

/** Takes one bot's approval away; the others are untouched. */
export function revokeBot(consent: BotConsent, botId: string): BotConsent {
  return { approvals: consent.approvals.filter((a) => a.botId !== botId) };
}

export interface Servable {
  /** Registered, approved at its current address, and the local judge is set: these may be started. */
  readonly serve: readonly BotAdapter[];
  /** Registered bots that may not be started, with why. */
  readonly refused: readonly { readonly botId: string; readonly reason: string }[];
}

export function servableBots(registry: BotRegistry, consent: BotConsent, env: Env): Servable {
  const serve: BotAdapter[] = [];
  const refused: { botId: string; reason: string }[] = [];
  const judge = botServeProblem(env);
  for (const id of registry.ids()) {
    const adapter = registry.get(id)!;
    if (!isBotApproved(consent, adapter)) {
      const was = consent.approvals.find((a) => a.botId === id);
      refused.push({
        botId: id,
        reason: was === undefined ? `not approved: ${botConsentPhrase(id, adapter.endpointOrigin)}` : `its address changed since it was approved (${was.endpointOrigin}); it needs a new approval`,
      });
    } else if (judge !== undefined) {
      refused.push({ botId: id, reason: judge });
    } else {
      serve.push(adapter);
    }
  }
  return { serve, refused };
}
