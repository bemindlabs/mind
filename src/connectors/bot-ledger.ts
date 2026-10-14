/**
 * A bot's messages in the ledger, and a bot's state out of it (S9.1 AC3, S7.2, p5 step 6).
 *
 * `handleMessage` already writes one ledger line for every message in and one for every answer out, and writes the
 * answer's line **before** it calls `send`; `record` throwing is what stops the send ({@link ChatDeps.record}). For a
 * bot the only new thing is whose line it is: the platform of a bot's message is the bot's id, so the line is
 * `chat:<botId>:<direction>:<sender>`, and bot A's lines are never bot B's.
 *
 * {@link botRecord} is that `record`, with the ledger's `append` handed in so a test can make it fail. It does not
 * catch: a ledger that cannot be written is a message that is not answered (and one that is not read, for the
 * incoming line), by design. {@link clearBot} is the per-bot half of erase: one approval goes, the other bots' stay.
 * The whole directory goes with `erase` (`bots` in the data map), and the ledger lines with the ledger.
 */

import { chatEntry, type ChatMessage } from "./chat.ts";
import { readBotConsent, revokeBot, writeBotConsent } from "./bot-consent.ts";
import type { LedgerEntry } from "../ledger/entry.ts";
import type { SubjectId } from "../types.ts";

export type LedgerAppend = (entry: LedgerEntry) => Promise<unknown>;

/** `ChatDeps.record` for a bot. Throws when `append` does. */
export function botRecord(
  append: LedgerAppend,
  subject: SubjectId,
  now: () => Date,
): (direction: "in" | "out", message: ChatMessage, text: string, content: "full" | "withheld") => Promise<void> {
  return async (direction, message, text, content) => {
    await append(chatEntry({ subject, direction, message, text, at: now(), content }));
  };
}

/** Takes one bot's approval out of the record on disk and leaves every other bot's. Returns whether there was one. */
export async function clearBot(botsDir: string, botId: string): Promise<boolean> {
  const before = await readBotConsent(botsDir);
  if (!before.approvals.some((a) => a.botId === botId)) return false;
  await writeBotConsent(botsDir, revokeBot(before, botId));
  return true;
}
