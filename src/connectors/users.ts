/**
 * S9.2 — who the agent answers in a chat app, and who has been told it is an AI (D-066).
 *
 * An allowlist per platform, never a denylist. A person is added only by the
 * owner typing a phrase at a terminal, as a peer is (D-063): an agent acting
 * on its own cannot widen who it talks to. `contacted` is who has had the
 * first message, the one that says it is an AI (AC1); `offset` is where the
 * platform's queue was read up to, so a restart does not answer twice.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

export const CHAT_DIR = "chat";
export const CHAT_PLATFORMS: readonly string[] = ["telegram"];

export interface ChatUser {
  readonly platform: string;
  readonly userId: string;
  /** What the owner calls them; never sent anywhere. */
  readonly label: string;
  readonly addedBy: string;
  readonly addedAt: string;
}

export interface ChatState {
  readonly users: readonly ChatUser[];
  /** `platform:userId` of everyone who has been told. */
  readonly contacted: readonly string[];
  readonly offsets: Readonly<Record<string, number>>;
}

const EMPTY: ChatState = { users: [], contacted: [], offsets: {} };

/** This subject's chat state. `erase` removes the directory whole. */
export function chatDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(stateRoot(env.home, env.env), CHAT_DIR, subject);
}

export function chatStatePath(chatDir: string): string {
  return join(chatDir, "state.json");
}

/** The phrase the owner types to let one person be answered. */
export function allowUserPhrase(platform: string, userId: string): string {
  return `answer ${platform} ${userId}`;
}

/** Why this person cannot be added as given, or `undefined`. */
export function userProblem(platform: string, userId: string): string | undefined {
  if (!CHAT_PLATFORMS.includes(platform)) return `the platforms are ${CHAT_PLATFORMS.join(", ")} — not ${JSON.stringify(platform)}`;
  // Telegram's user ids are positive integers; a group's are negative, and groups are not answered.
  if (!/^[1-9]\d{0,15}$/.test(userId)) return `a ${platform} user id is a positive number — ${JSON.stringify(userId)} is not`;
  return undefined;
}

export async function readChatState(chatDir: string): Promise<ChatState> {
  try {
    const raw = JSON.parse(await readFile(chatStatePath(chatDir), "utf8")) as Partial<ChatState>;
    return {
      users: Array.isArray(raw.users) ? raw.users.filter((u) => typeof u?.platform === "string" && typeof u?.userId === "string") : [],
      contacted: Array.isArray(raw.contacted) ? raw.contacted.filter((c) => typeof c === "string") : [],
      offsets: typeof raw.offsets === "object" && raw.offsets !== null ? raw.offsets : {},
    };
  } catch {
    return EMPTY;
  }
}

export async function writeChatState(chatDir: string, state: ChatState): Promise<void> {
  await mkdir(chatDir, { recursive: true, mode: 0o700 });
  const path = chatStatePath(chatDir);
  const temp = `${path}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function isAllowed(state: ChatState, platform: string, userId: string): boolean {
  return state.users.some((u) => u.platform === platform && u.userId === userId);
}

export function contactKey(platform: string, userId: string): string {
  return `${platform}:${userId}`;
}
