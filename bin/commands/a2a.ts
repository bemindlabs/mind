/**
 * `mind a2a` — talk with other agents over A2A 1.0.0 (E8, D-063).
 *
 *   peers                 who is allowed, both ways
 *   allow <name>          add one — typed at a terminal, never by a flag
 *   remove <name>         take one away
 *   serve                 listen (loopback) and put what allowed peers send in the inbox
 *   send --to <name>      send one message, screened like a turn
 *   inbox                 what has arrived
 *
 * Nothing that arrives is run. Every message in or out is in the ledger first.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isatty } from "node:tty";
import { join } from "node:path";
import { agentCard } from "../../src/a2a/card.ts";
import { messageEntry, sendToPeer } from "../../src/a2a/message.ts";
import { a2aDirFor, allowPhrase, findPeer, newToken, peerProblem, readPeers, writePeers } from "../../src/a2a/peers.ts";
import { startA2A } from "../../src/a2a/server.ts";
import { announceEgress } from "../../src/exec/egress.ts";
import { describeFindings, judgeOf, judgeWarning, JUDGE_TIMEOUT_MS, loadLexicon, recordBlocked, resolveJudgeMode, screenOutbound } from "../../src/egress/index.ts";
import { personalDir } from "../../src/guard/personal.ts";
import { identityDirFor } from "../../src/identity/dir.ts";
import { readAgentKey } from "../../src/identity/key.ts";
import { append } from "../../src/ledger/store.ts";
import { chosenLanguage } from "../../src/lang.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { dialEnv, whoIsSetting } from "../dial.ts";
import { bold, dim, ledgerEnv, parseArgs, readPhrase, report, usageError } from "../shared.ts";

const USAGE =
  "usage: mind a2a peers --subject <id>\n" +
  "       mind a2a allow <name> --endpoint <url> --subject <id> [--send-token-file <path>]\n" +
  "       mind a2a remove <name> --subject <id>\n" +
  "       mind a2a serve <dir> --subject <id> [--port <n>] [--host <addr>]\n" +
  "       mind a2a send <dir> --subject <id> --to <name> --text <message>\n" +
  "       mind a2a inbox --subject <id>";

/** The key of the bearer scheme in the card's `securitySchemes`: a client may key on it. Nothing in the engine reads a card back. */
export const BEARER_SCHEME = "mindBearer";

const A2A_PORT = 30700;
const INBOX = join("a2a", "inbox.jsonl");

function subjectOf(options: ReadonlyMap<string, string>): { ok: true; id: SubjectId } | { ok: false; code: number } {
  const raw = options.get("subject");
  if (raw === undefined || raw === "") return { ok: false, code: usageError(USAGE) };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

async function inboxPath(id: SubjectId): Promise<string | undefined> {
  const dir = await personalDir(dialEnv(), id);
  return dir.ok ? join(dir.path, INBOX) : undefined;
}

async function cmdPeers(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const peers = await readPeers(a2aDirFor(dialEnv(), s.id));
  if (peers.length === 0) console.log("no peers — nobody can send to this agent, and it can send to nobody.");
  for (const p of peers) console.log(`${p.name.padEnd(20)} ${p.endpoint}  added by ${p.addedBy} at ${p.addedAt}`);
  console.log(dim("A peer is added only with `mind a2a allow`, typed at a terminal (S8.4)."));
  return 0;
}

async function cmdAllow(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const name = positional[0];
  const endpoint = options.get("endpoint");
  if (name === undefined || endpoint === undefined) return usageError(USAGE);
  const problem = peerProblem(name, endpoint);
  if (problem !== undefined) return usageError(problem);
  const dir = a2aDirFor(dialEnv(), s.id);
  const peers = await readPeers(dir);
  if (findPeer(peers, name) !== undefined) return usageError(`${name} is already a peer — remove it first to change it`);

  // AC2: an agent acting on its own cannot add a peer. The phrase is read from
  // a terminal, and there is no flag that stands in for it.
  const phrase = allowPhrase(name);
  if (!(process.stdin.isTTY === true && isatty(1))) {
    console.error(`mind: adding a peer has to be typed at a terminal, where you can type: ${phrase}`);
    return 1;
  }
  console.error(`${name} at ${endpoint} will be able to send messages to this agent, and this agent to it.`);
  console.error(`To agree, type exactly:  ${phrase}`);
  if ((await readPhrase()) !== phrase) {
    console.error(`mind: that was not ${JSON.stringify(phrase)}, so nothing was written.`);
    return 1;
  }
  const tokenFile = options.get("send-token-file");
  const outboundToken = tokenFile === undefined ? null : (await readFile(tokenFile, "utf8")).trim() || null;
  const peer = { name, endpoint, inboundToken: newToken(), outboundToken, addedBy: await whoIsSetting(process.cwd()), addedAt: new Date().toISOString() };
  await writePeers(dir, [...peers, peer]);
  console.log(bold(`${name} is allowed.`));
  console.log(`Give ${name}'s owner this token to send to you with (shown once; it is stored at ${dir}):`);
  console.log(`  ${peer.inboundToken}`);
  return 0;
}

async function cmdRemove(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const name = positional[0];
  if (name === undefined) return usageError(USAGE);
  const dir = a2aDirFor(dialEnv(), s.id);
  const peers = await readPeers(dir);
  if (findPeer(peers, name) === undefined) {
    console.error(`mind: ${name} is not a peer.`);
    return 1;
  }
  await writePeers(dir, peers.filter((p) => p.name !== name));
  console.log(`${name} removed; its token no longer opens anything.`);
  return 0;
}

async function cmdServe(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const dir = positional[0];
  if (dir === undefined) return usageError(USAGE);
  const loaded = await loadSoul(dir, s.id);
  if (!loaded.ok) return report(loaded.issues);
  const port = Number(options.get("port") ?? String(A2A_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return usageError(`${USAGE} — --port is a number`);
  const hostname = options.get("host") ?? "127.0.0.1";
  const inbox = await inboxPath(s.id);
  if (inbox === undefined) return usageError("the personal directory cannot be resolved");
  const a2aDir = a2aDirFor(dialEnv(), s.id);
  // S15.8: the card announces the key as it is now; serving it never makes one.
  const key = await readAgentKey(identityDirFor(dialEnv(), s.id));
  if (key.state === "refused") console.error(`mind: the card says there is no usable key — ${key.reason}`);
  const cardKey = key.state === "present" ? key.key : null;
  const server = startA2A(
    {
      agentName: loaded.soul.role.name,
      // The card asks for a bearer, the A2A way — so a peer (bwoc's client
      // included) presents the token it was given, and only to a card that asks.
      card: async () => ({
        ...agentCard(loaded.soul, `http://${hostname}:${port}/`, cardKey),
        securitySchemes: { [BEARER_SCHEME]: { type: "http", scheme: "bearer" } },
        security: [{ [BEARER_SCHEME]: [] }],
      }),
      peers: () => readPeers(a2aDir),
      deliver: async (peer, message) => {
        // AC5: the ledger first; if it cannot be written, nothing is delivered.
        await append(ledgerEnv(), messageEntry({ subject: s.id, direction: "in", peer: peer.name, messageId: message.messageId, text: message.text, at: new Date(), content: "full" }));
        await mkdir(join(inbox, ".."), { recursive: true, mode: 0o700 });
        await appendFile(inbox, `${JSON.stringify({ at: new Date().toISOString(), from: peer.name, messageId: message.messageId, text: message.text, nonText: message.nonText })}\n`, { mode: 0o600 });
        console.error(`mind: a message from ${peer.name} is in the inbox (${message.messageId}).`);
      },
      refused: (reason) => console.error(`mind: refused ${reason}.`),
    },
    { port, hostname },
  );
  console.log(bold(`${loaded.soul.role.name} is listening for A2A at ${server.url}`));
  console.log(dim(`Agent card: ${server.url.replace(/\/$/, "")}/.well-known/agent-card.json · only allowed peers get in · nothing that arrives is run · Ctrl-C stops (D-063).`));
  if (hostname !== "127.0.0.1" && hostname !== "localhost") console.log(dim(`Listening on ${hostname}: reachable from wherever that address is.`));
  await new Promise<void>((done) => {
    const stop = () => {
      server.stop();
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function cmdSend(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const dir = positional[0];
  const to = options.get("to");
  const text = options.get("text");
  if (dir === undefined || to === undefined || text === undefined || text.trim() === "") return usageError(USAGE);
  const loaded = await loadSoul(dir, s.id);
  if (!loaded.ok) return report(loaded.issues);
  const peer = findPeer(await readPeers(a2aDirFor(dialEnv(), s.id)), to);
  if (peer === undefined) {
    console.error(`mind: ${to} is not a peer — nothing was sent. A peer is added with \`mind a2a allow\` at a terminal (S8.4).`);
    return 1;
  }
  // S8.3: the same two layers a turn goes through; there is no local fallback
  // for a message, so kept in means not sent. D-181: the second layer is on when
  // the owner named a judge or a local model is configured.
  const { lexicon } = await loadLexicon(dialEnv(), s.id, loaded.soul.person.inherits_from);
  const judge = resolveJudgeMode("a2a-send", process.env);
  const findings = await screenOutbound(text, lexicon, judge);
  if (findings.length > 0) {
    await recordBlocked(dialEnv(), s.id, { at: new Date().toISOString(), backend: `a2a:${peer.name}`, findings }).catch(() => undefined);
    console.error(`mind: not sent to ${peer.name} — kept in: ${describeFindings(findings)} (I-6).`);
    // A message has no local fallback, so a judge that is slow or down stops the send: say that, and what to look at.
    const asked = judgeOf(judge);
    if (asked !== undefined && findings.some((f) => f.rule === "judge:unsure")) {
      console.error(
        `mind: the judge (${asked.model} at ${asked.host}) gave no clear answer: it may be down, still loading (it is given ${JUDGE_TIMEOUT_MS / 1000} s) ` +
          "or not at a loopback address. Nothing was sent, and a message has no local fallback. Once the model is up, send again; " +
          "`mind egress check <text>` tries the judge without sending anything.",
      );
    }
    return 1;
  }
  // D-181: nothing read this message for meaning. Said on every send, before the ledger line and the send, and
  // with no setting that says it once.
  if (judgeOf(judge) === undefined) console.error(judgeWarning(chosenLanguage(process.env), judge.reason));
  const messageId = crypto.randomUUID();
  await append(ledgerEnv(), messageEntry({ subject: s.id, direction: "out", peer: peer.name, messageId, text, at: new Date(), content: "full" }));
  announceEgress((line) => console.error(dim(line)), { kind: "host", id: `a2a:${peer.name}`, host: peer.endpoint });
  const sent = await sendToPeer(peer, text, messageId);
  if (!sent.ok) {
    console.error(`mind: ${peer.name} did not take it: ${sent.reason}`);
    return 1;
  }
  console.log(sent.answer === "" ? `sent to ${peer.name}` : sent.answer);
  return 0;
}

async function cmdInbox(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const path = await inboxPath(s.id);
  let lines: string[] = [];
  try {
    lines = (await readFile(path ?? "", "utf8")).split("\n").filter((l) => l.trim() !== "");
  } catch {
    // Nothing has arrived.
  }
  if (lines.length === 0) console.log("nothing has arrived.");
  for (const line of lines) {
    try {
      const m = JSON.parse(line) as { at: string; from: string; text: string };
      console.log(`${m.at}  ${m.from}: ${m.text}`);
    } catch {
      console.log(dim("(a line that does not read)"));
    }
  }
  return 0;
}

export async function cmdA2A(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "peers":
      return cmdPeers(rest);
    case "allow":
      return cmdAllow(rest);
    case "remove":
      return cmdRemove(rest);
    case "serve":
      return cmdServe(rest);
    case "send":
      return cmdSend(rest);
    case "inbox":
      return cmdInbox(rest);
    default:
      return usageError(`unknown a2a subcommand ${JSON.stringify(sub ?? "")}\n${USAGE}`);
  }
}

