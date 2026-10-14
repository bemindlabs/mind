/**
 * `mind chat` — the agent in a chat app, answering people the owner allowed (E9, D-066).
 *
 *   users                          who is answered
 *   allow <platform> <user-id>     add one — typed at a terminal, never by a flag
 *   remove <platform> <user-id>    take one away
 *   serve <dir> --token-file <f>   read the platform and answer (off until run; Ctrl-C stops)
 *
 * Every answer is a turn held at level 1, screened by the egress filter *and*
 * the local judge before it is sent; either one finding anything keeps it in,
 * with no approval that lets it out (S9.2 AC3). Anyone not on the list gets no
 * answer at all (AC2). The first answer to each person says it is an AI (AC1).
 */

import { readMind } from "../../src/env.ts";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isatty } from "node:tty";
import { chatEntry, chatPrompt, handleMessage, type ChatConnector } from "../../src/connectors/chat.ts";
import { TelegramConnector, telegramBase } from "../../src/connectors/telegram.ts";
import {
  allowUserPhrase,
  chatDirFor,
  contactKey,
  isAllowed,
  readChatState,
  userProblem,
  writeChatState,
} from "../../src/connectors/users.ts";
import { AUTONOMY_MAX_ENV } from "../../src/decide/effective.ts";
import { triggeredCeiling } from "../../src/decide/triggers.ts";
import { announceEgress } from "../../src/exec/egress.ts";
import { PHASE_A_BACKENDS, routeModels } from "../../src/exec/index.ts";
import { describeFindings, judgeEgress, judgeOf, JUDGE_ENV, loadLexicon, recordBlocked, resolveJudgeMode, screen, verdictFindings } from "../../src/egress/index.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import { append } from "../../src/ledger/store.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { runGuarded } from "../../src/spawn.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { dialEnv, whoIsSetting } from "../dial.ts";
import { bold, dim, ledgerEnv, parseArgs, readPhrase, report, usageError } from "../shared.ts";

const USAGE =
  "usage: mind chat users --subject <id>\n" +
  "       mind chat allow <platform> <user-id> --subject <id> [--label <name>]\n" +
  "       mind chat remove <platform> <user-id> --subject <id>\n" +
  "       mind chat serve <dir> --subject <id> --platform telegram --token-file <path> [--once] [--backend <b>] [--model <m> | --model <backend>=<m>,…]";

/** Where a test points the connector instead of api.telegram.org — https or loopback only. */
const TELEGRAM_URL_ENV = "MIND_TELEGRAM_URL";

function subjectOf(options: ReadonlyMap<string, string>): { ok: true; id: SubjectId } | { ok: false; code: number } {
  const raw = options.get("subject");
  if (raw === undefined || raw === "") return { ok: false, code: usageError(USAGE) };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

async function cmdUsers(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const state = await readChatState(chatDirFor(dialEnv(), s.id));
  if (state.users.length === 0) console.log("nobody — the agent answers no one in any chat app.");
  for (const u of state.users) {
    const told = state.contacted.includes(contactKey(u.platform, u.userId)) ? "told it is an AI" : "not yet written to";
    console.log(`${u.platform.padEnd(10)} ${u.userId.padEnd(16)} ${u.label === "" ? "" : `${u.label}  `}added by ${u.addedBy} at ${u.addedAt} · ${told}`);
  }
  console.log(dim("A person is added only with `mind chat allow`, typed at a terminal (S9.2)."));
  return 0;
}

async function cmdAllow(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const [platform, userId] = positional;
  if (platform === undefined || userId === undefined) return usageError(USAGE);
  const problem = userProblem(platform, userId);
  if (problem !== undefined) return usageError(problem);
  const dir = chatDirFor(dialEnv(), s.id);
  const state = await readChatState(dir);
  if (isAllowed(state, platform, userId)) return usageError(`${platform} user ${userId} is already answered`);

  // As with a peer: the phrase is read from a terminal, and no flag stands in for it.
  const phrase = allowUserPhrase(platform, userId);
  if (!(process.stdin.isTTY === true && isatty(1))) {
    console.error(`mind: letting someone be answered has to be typed at a terminal, where you can type: ${phrase}`);
    return 1;
  }
  console.error(`${platform} user ${userId} will get answers from this agent — written by a model, screened, and never carrying anything marked personal.`);
  console.error(`To agree, type exactly:  ${phrase}`);
  if ((await readPhrase()) !== phrase) {
    console.error(`mind: that was not ${JSON.stringify(phrase)}, so nothing was written.`);
    return 1;
  }
  const user = { platform, userId, label: options.get("label") ?? "", addedBy: await whoIsSetting(process.cwd()), addedAt: new Date().toISOString() };
  await writeChatState(dir, { ...state, users: [...state.users, user] });
  console.log(bold(`${platform} user ${userId} will be answered.`));
  return 0;
}

async function cmdRemove(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const [platform, userId] = positional;
  if (platform === undefined || userId === undefined) return usageError(USAGE);
  const dir = chatDirFor(dialEnv(), s.id);
  const state = await readChatState(dir);
  if (!isAllowed(state, platform, userId)) {
    console.error(`mind: ${platform} user ${userId} is not on the list.`);
    return 1;
  }
  await writeChatState(dir, { ...state, users: state.users.filter((u) => !(u.platform === platform && u.userId === userId)) });
  console.log(`${platform} user ${userId} removed; the next message from them gets no answer.`);
  return 0;
}

/** The bot token, from a file only the owner can read. */
async function readToken(path: string): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) return { ok: false, reason: `${path} can be read by others (mode ${(info.mode & 0o777).toString(8)}) — chmod 600 it first` };
    const token = (await readFile(path, "utf8")).trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return { ok: false, reason: `${path} does not hold a bot token (digits, a colon, then the secret)` };
    return { ok: true, token };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function cmdServe(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["once"]);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const dir = positional[0];
  const platform = options.get("platform") ?? "telegram";
  const tokenFile = options.get("token-file");
  if (dir === undefined || tokenFile === undefined) return usageError(USAGE);
  if (platform !== "telegram") return usageError(`the platforms are telegram — not ${JSON.stringify(platform)}`);
  // D-142: a --model every answer's turn would refuse is refused once, here. A backend `turn` does not know is
  // left for `turn` to name.
  const chain = (options.get("backend") ?? "").split(",").map((b) => b.trim()).filter((b) => b !== "");
  const models = routeModels(options.get("model"), chain.length > 0 ? chain : [...PHASE_A_BACKENDS]);
  if (!models.ok) return usageError(`${USAGE}\n${models.reason}`);
  const loaded = await loadSoul(dir, s.id);
  if (!loaded.ok) return report(loaded.issues);

  // AC3: here the second layer is not optional. A person reads every answer,
  // and there is no approval to catch what the filter's patterns cannot see.
  // D-181: chat is not one of the automatic paths: the owner names the judge, or nothing starts.
  const judge = judgeOf(resolveJudgeMode("chat", process.env));
  if (judge === undefined) {
    console.error(`mind: chat needs the local judge as well as the filter — set ${JUDGE_ENV} to a model on this machine (D-061). Nothing was started.`);
    return 1;
  }
  const token = await readToken(tokenFile);
  if (!token.ok) {
    console.error(`mind: ${token.reason}`);
    return 1;
  }
  const chatDir = chatDirFor(dialEnv(), s.id);
  const initial = await readChatState(chatDir);
  if (!initial.users.some((u) => u.platform === platform)) {
    console.error(`mind: nobody on ${platform} is allowed yet, so nobody would be answered. Add someone with \`mind chat allow ${platform} <user-id> --subject ${s.id}\`.`);
  }
  const { lexicon } = await loadLexicon(dialEnv(), s.id, loaded.soul.person.inherits_from);
  const base = telegramBase(readMind(TELEGRAM_URL_ENV, process.env));
  // Written after a batch is handled, so a restart mid-batch answers it again
  // rather than never — and so it never races the `contacted` write.
  let nextOffset: number | undefined;
  const connector: ChatConnector = new TelegramConnector(token.token, {
    base,
    pollSeconds: options.has("once") ? 0 : 25,
    offset: initial.offsets[platform],
    onOffset: (offset) => {
      nextOffset = offset;
    },
  });
  const turnFlags = ["backend", "model"].flatMap((name) => {
    const value = options.get(name);
    return value === undefined || value === "" ? [] : [`--${name}`, value];
  });
  const turnEnv = { ...process.env, [AUTONOMY_MAX_ENV]: triggeredCeiling(readMind(AUTONOMY_MAX_ENV, process.env)) };
  const absolute = resolve(dir);
  const agentName = loaded.soul.role.name;
  announceEgress((line) => console.error(dim(line)), { kind: "host", id: `chat:${platform}`, host: base });

  const deps = {
    agentName,
    allowed: async (p: string, u: string) => isAllowed(await readChatState(chatDir), p, u),
    firstContact: async (p: string, u: string) => !(await readChatState(chatDir)).contacted.includes(contactKey(p, u)),
    contacted: async (p: string, u: string) => {
      const st = await readChatState(chatDir);
      await writeChatState(chatDir, { ...st, contacted: [...st.contacted, contactKey(p, u)] });
    },
    record: (direction: "in" | "out", message: Parameters<typeof chatEntry>[0]["message"], text: string, content: "full" | "withheld") =>
      append(ledgerEnv(), chatEntry({ subject: s.id, direction, message, text, at: new Date(), content })).then(() => undefined),
    turn: async (text: string) => {
      const run = await runGuarded([...engineCommand().argv, "turn", absolute, "--subject", s.id, "--prompt", text, ...turnFlags], { env: turnEnv });
      const out = new TextDecoder().decode(run.stdout).trim();
      return run.code === 0 || out !== "" ? { ok: true as const, text: out } : { ok: false as const, reason: `the turn ended ${run.code}` };
    },
    screen: async (text: string) => {
      const found = screen(text, lexicon);
      return found.length > 0 ? found : verdictFindings(await judgeEgress(text, lexicon.needles, judge));
    },
    onBlocked: async (findings: Parameters<typeof describeFindings>[0]) => {
      await recordBlocked(dialEnv(), s.id, { at: new Date().toISOString(), backend: `chat:${platform}`, findings }).catch(() => undefined);
      console.error(`mind: an answer was kept in — ${describeFindings(findings)} (S9.2 AC3); they were told it cannot be shared here.`);
    },
    send: (chatId: string, text: string) => connector.send(chatId, text),
  };

  console.log(bold(`${agentName} is answering allowed ${platform} users.`));
  console.log(dim("Anyone else gets no answer · every answer is a level-1 turn, screened by the filter and the local judge · Ctrl-C stops (D-066)."));
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  do {
    const polled = await connector.poll();
    if (polled.error !== undefined) {
      console.error(`mind: ${platform}: ${polled.error}`);
      if (!options.has("once")) await new Promise((wait) => setTimeout(wait, 5000));
    }
    for (const message of polled.messages) {
      if (stopped) break;
      try {
        const handled = await handleMessage(message, { ...deps, turn: () => deps.turn(chatPrompt(message)) });
        if (handled.kind === "ignored") console.error(dim(`mind: ${platform} user ${message.userId} is not on the list — no answer.`));
        else if (handled.kind === "failed") console.error(`mind: no answer to ${platform} user ${message.userId}: ${handled.reason}`);
        else console.error(dim(`mind: answered ${platform} user ${message.userId}${handled.kind === "withheld" ? " (kept in)" : ""}.`));
      } catch (error) {
        // The ledger could not be written: nothing was sent, and nothing more will be.
        console.error(`mind: stopped — ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    }
    if (nextOffset !== undefined) {
      const offset = nextOffset;
      const st = await readChatState(chatDir);
      await writeChatState(chatDir, { ...st, offsets: { ...st.offsets, [platform]: offset } });
      nextOffset = undefined;
    }
  } while (!options.has("once") && !stopped);
  return 0;
}

export async function cmdChat(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "users":
      return cmdUsers(rest);
    case "allow":
      return cmdAllow(rest);
    case "remove":
      return cmdRemove(rest);
    case "serve":
      return cmdServe(rest);
    default:
      return usageError(`unknown chat subcommand ${JSON.stringify(sub ?? "")}\n${USAGE}`);
  }
}
