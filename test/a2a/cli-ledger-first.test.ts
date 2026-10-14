/**
 * S8.2 AC5 and S8.3 through the binary (D-063, D-048, I-6): what `mind a2a send` and `mind a2a serve` do, in what
 * order, with a fake peer on loopback and a temporary home.
 *
 * `test/a2a/messaging.test.ts` proves the parts (the handler, the parser, `sendToPeer`). It cannot prove the order
 * the command puts them in, because that order lives in `bin/commands/a2a.ts` and the parts take it as given. So
 * the checks here run the command itself and read what it left on disk and what the peer saw:
 *
 *   send   (a) a text the egress filter stops is not sent, and leaves a line in `blocked.jsonl` and none in the ledger
 *          (b) the ledger line is on disk when the peer's request arrives — the peer reads the ledger at that instant
 *          (c) a ledger that cannot be written means nothing is sent
 *   serve  (d) the ledger line is on disk even when the inbox cannot be written, and a ledger that cannot be written
 *              leaves the inbox empty: the two together fix the order ledger, then inbox, and rule out both at once
 *
 * Each failure is made by putting something in the way (a file where a directory must be, a directory where a file
 * must be), which stops a write whoever runs the test — `chmod` would not stop root. Every one of them is paired with
 * a control that runs the same command with nothing in the way, so a pass is not "the command never worked".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { a2aDirFor, newToken, writePeers, type Peer } from "../../src/a2a/peers.ts";
import { judgeWarning, JUDGE_WARNING_PREFIX } from "../../src/egress/judge-mode.ts";
import { BLOCKED_FILE, EGRESS_DIR, NEEDLES_FILE } from "../../src/egress/store.ts";
import { personalPath } from "../../src/guard/personal.ts";
import { ledgerDir } from "../../src/ledger/store.ts";
import { subjectId } from "../../src/types.ts";
import { barePath, BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const FIXTURE_SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SUBJECT = "example";
/** Where `a2a serve` keeps what has arrived, below the subject's personal directory. */
const INBOX = join("a2a", "inbox.jsonl");

const scratch: string[] = [];
const peers: { stop: () => void }[] = [];
const children: { kill: (signal: "SIGTERM") => void; exited: Promise<number>; reading: Promise<unknown> }[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) p.stop();
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
    await child.exited;
    await child.reading;
  }
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

interface LedgerRow {
  readonly backend: string;
  readonly subject: string;
  readonly turn: string;
  readonly prompt: string | null;
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "mind-a2a-cli-"));
  scratch.push(home);
  const soul = join(home, "soul");
  await cp(FIXTURE_SOUL, soul, { recursive: true });
  const stateHome = join(home, "state");
  const dataHome = join(home, "data");
  // The same two roots the child resolves from its own environment, so the paths below are the child's.
  const where = { home, env: { XDG_STATE_HOME: stateHome, XDG_DATA_HOME: dataHome } };
  const subject = subjectId(SUBJECT);
  const env: Record<string, string> = {
    HOME: home,
    PATH: await barePath(home),
    XDG_STATE_HOME: stateHome,
    XDG_DATA_HOME: dataHome,
    MIND_NO_UPDATE_CHECK: "1",
    // Nothing listens on port 9: no test run writes into this machine's real Qdrant.
    MIND_QDRANT_URL: "http://127.0.0.1:9",
  };
  const personal = personalPath(where, subject);
  const ledger = ledgerDir(where, subject);

  /** Every ledger line there is right now. Synchronous, so a fake peer can read it while a request is open. */
  const ledgerRows = (): LedgerRow[] => {
    if (!existsSync(ledger)) return [];
    try {
      return readdirSync(ledger)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .flatMap((name) => readFileSync(join(ledger, name), "utf8").split("\n").filter((l) => l.trim() !== ""))
        .map((line) => JSON.parse(line) as LedgerRow);
    } catch {
      // `ledger` is a plain file in the tests that put one there to stop the writes.
      return [];
    }
  };

  const run = async (args: readonly string[], extraEnv: Record<string, string> = {}) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env: { ...env, ...extraEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };

  const allow = (peer: Peer) => writePeers(a2aDirFor(where, subject), [peer]);

  /** The ledger's place is taken by a file, so no line can be appended whoever runs this. */
  const breakLedger = async () => {
    await mkdir(join(ledger, ".."), { recursive: true });
    await writeFile(ledger, "not a directory\n");
  };

  return { home, soul, env, personal, ledger, ledgerRows, run, allow, breakLedger };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** What the fake peer saw of one request, taken at the moment it arrived. */
interface Arrival {
  readonly authorization: string | null;
  readonly messageId: string;
  readonly text: string;
  /** The ledger as it stood when this request reached the peer. */
  readonly ledgerThen: readonly LedgerRow[];
}

/** A peer on loopback that answers like one, and writes down what it was asked and what the ledger held then. */
function fakePeer(t: Setup, answer: "ack" | "busy" = "ack") {
  const arrivals: Arrival[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const ledgerThen = t.ledgerRows();
      const body = (await req.json()) as { id: string; params: { message: { messageId: string; parts: { text: string }[] } } };
      arrivals.push({
        authorization: req.headers.get("authorization"),
        messageId: body.params.message.messageId,
        text: body.params.message.parts.map((p) => p.text).join("\n"),
        ledgerThen,
      });
      if (answer === "busy") return new Response("busy", { status: 503 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { role: "ROLE_AGENT", parts: [{ text: "the fake peer has it" }], messageId: `ack-${body.params.message.messageId}` } });
    },
  });
  peers.push({ stop: () => server.stop(true) });
  const peer: Peer = { name: "fake", endpoint: `http://127.0.0.1:${server.port}/`, inboundToken: newToken(), outboundToken: null, addedBy: "test", addedAt: "2026-10-13T00:00:00Z" };
  return { peer, arrivals };
}

const send = (t: Setup, text: string, extraEnv: Record<string, string> = {}) =>
  t.run(["a2a", "send", t.soul, "--subject", SUBJECT, "--to", "fake", "--text", text], extraEnv);

const blockedPath = (t: Setup) => join(t.personal, EGRESS_DIR, BLOCKED_FILE);
const blockedLines = (t: Setup): { at: string; backend: string; findings: { rule: string; needle?: number }[] }[] =>
  existsSync(blockedPath(t))
    ? readFileSync(blockedPath(t), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l))
    : [];
const outRows = (t: Setup) => t.ledgerRows().filter((r) => r.backend.startsWith("a2a:out:"));

async function writeNeedles(t: Setup, ...needles: string[]) {
  await mkdir(join(t.personal, EGRESS_DIR), { recursive: true });
  await writeFile(join(t.personal, EGRESS_DIR, NEEDLES_FILE), `# mine\n${needles.join("\n")}\n`);
}

describe("a2a send — the egress screen runs before anything is recorded or sent (S8.3, I-6)", () => {
  const CLEAN = "the invoice for the quarter is ready for you to read";

  test("control: a clean text is sent, recorded once, and leaves no blocked line", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    const result = await send(t, CLEAN);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("the fake peer has it");
    expect(arrivals.map((a) => a.text)).toEqual([CLEAN]);
    expect(outRows(t)).toHaveLength(1);
    expect(blockedLines(t)).toEqual([]);
  }, 30_000);

  for (const [label, text, rule] of [
    ["an e-mail address", "please write to wanida@example.com about it", "email"],
    ["a phone number", "call her on 081-234-5678 today", "thai-phone"],
  ] as const) {
    test(`${label} is not sent: the peer is never called, blocked.jsonl names the rule and never the text, and the ledger has no line`, async () => {
      const t = await setup();
      const { peer, arrivals } = fakePeer(t);
      await t.allow(peer);
      const result = await send(t, text);

      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("not sent to fake");
      expect(result.stderr).toContain(rule);
      // Nothing left, nothing was announced as leaving, and nothing was said to have been sent.
      expect(arrivals).toEqual([]);
      expect(result.stderr).not.toContain("leaving this machine");
      expect(result.stdout).not.toContain("sent to fake");

      const lines = blockedLines(t);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.backend).toBe("a2a:fake");
      expect(lines[0]!.findings).toEqual([{ rule }]);
      expect(Number.isNaN(Date.parse(lines[0]!.at))).toBe(false);
      expect(readFileSync(blockedPath(t), "utf8")).not.toContain(text);
      expect(result.stderr).not.toContain(text);
      // A message that never went out is not a message out.
      expect(outRows(t)).toEqual([]);
    }, 30_000);
  }

  test("a text carrying one of the owner's needles is not sent; the record points at the needle's number, not its words", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Somsak Wongsawat", "Wanida Srisuk");
    const result = await send(t, "tell Wanida   Srisuk that the quarter is closed");

    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("personal needle #2");
    expect(result.stderr).not.toContain("Wanida");
    expect(arrivals).toEqual([]);
    expect(blockedLines(t).map((l) => l.findings)).toEqual([[{ rule: "needle", needle: 2 }]]);
    expect(readFileSync(blockedPath(t), "utf8")).not.toContain("Wanida");
    expect(outRows(t)).toEqual([]);
  }, 30_000);

  test("a credential in the text is not sent", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    const result = await send(t, "connect with postgres://app:hunter22-x@db.invalid/main");
    expect(result.code, result.stderr).toBe(1);
    expect(arrivals).toEqual([]);
    expect(blockedLines(t).flatMap((l) => l.findings.map((f) => f.rule)).some((rule) => rule.startsWith("secret:"))).toBe(true);
    expect(outRows(t)).toEqual([]);
  }, 30_000);

  describe("the local judge, when it is on (D-061)", () => {
    /** A judge on loopback that answers with `reply`, standing in for the local Ollama. */
    function judge(reply: (text: string) => Response) {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const body = (await req.json()) as { messages: { content: string }[] };
          return reply(body.messages.at(-1)?.content ?? "");
        },
      });
      peers.push({ stop: () => server.stop(true) });
      return { MIND_EGRESS_JUDGE: "stub", OLLAMA_HOST: `http://127.0.0.1:${server.port}` };
    }
    const PARAPHRASE = "pass this to the bookkeeper whose name means young woman";

    test("a paraphrase the filter cannot see, which the judge reads as revealing, is not sent", async () => {
      const t = await setup();
      const { peer, arrivals } = fakePeer(t);
      await t.allow(peer);
      await writeNeedles(t, "Wanida Srisuk");
      const asked: string[] = [];
      const result = await send(t, PARAPHRASE, judge((text) => {
        asked.push(text);
        return Response.json({ message: { content: JSON.stringify({ reveals: true }) } });
      }));
      expect(asked.length).toBeGreaterThan(0);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("the local judge read it as revealing");
      expect(arrivals).toEqual([]);
      expect(blockedLines(t).map((l) => l.findings)).toEqual([[{ rule: "judge:reveals" }]]);
      expect(outRows(t)).toEqual([]);
    }, 30_000);

    test("a judge that cannot answer keeps the text in: for a message there is no local fallback", async () => {
      const t = await setup();
      const { peer, arrivals } = fakePeer(t);
      await t.allow(peer);
      await writeNeedles(t, "Wanida Srisuk");
      const result = await send(t, PARAPHRASE, judge(() => new Response("down", { status: 500 })));
      expect(result.code, result.stderr).toBe(1);
      expect(arrivals).toEqual([]);
      expect(blockedLines(t).map((l) => l.findings)).toEqual([[{ rule: "judge:unsure" }]]);
      expect(outRows(t)).toEqual([]);
    }, 30_000);

    test("control: the same judge, answering that nothing is revealed, lets the text go", async () => {
      const t = await setup();
      const { peer, arrivals } = fakePeer(t);
      await t.allow(peer);
      await writeNeedles(t, "Wanida Srisuk");
      const result = await send(t, PARAPHRASE, judge(() => Response.json({ message: { content: JSON.stringify({ reveals: false }) } })));
      expect(result.code, result.stderr).toBe(0);
      expect(arrivals.map((a) => a.text)).toEqual([PARAPHRASE]);
      expect(blockedLines(t)).toEqual([]);
    }, 30_000);
  });
});

describe("a2a send — the ledger line is written before the message leaves (S8.2 AC5)", () => {
  const TEXT = "the invoice for the quarter is ready for you to read";

  test("when the peer's request arrives, the ledger already holds that message's line, in full, under that message's id", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    const result = await send(t, TEXT);

    expect(result.code, result.stderr).toBe(0);
    expect(arrivals).toHaveLength(1);
    const arrival = arrivals[0]!;
    const before = arrival.ledgerThen.filter((r) => r.turn === arrival.messageId);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ backend: "a2a:out:fake", subject: SUBJECT, prompt: TEXT, turn: arrival.messageId });
    // And there is still exactly one afterwards: sending did not write it a second time.
    expect(outRows(t).filter((r) => r.turn === arrival.messageId)).toHaveLength(1);
  }, 30_000);

  test("a peer that refuses the message does not undo the record: the attempt is in the ledger and the command says it failed", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t, "busy");
    await t.allow(peer);
    const result = await send(t, TEXT);

    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("fake did not take it");
    expect(arrivals).toHaveLength(1);
    expect(outRows(t)).toHaveLength(1);
    expect(outRows(t)[0]).toMatchObject({ backend: "a2a:out:fake", prompt: TEXT, turn: arrivals[0]!.messageId });
  }, 30_000);

  test("a ledger that cannot be written means the message is not sent, and nothing is said to be leaving", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await t.breakLedger();
    const result = await send(t, TEXT);

    expect(result.code, result.stderr).not.toBe(0);
    // It stopped on the ledger, not on something else: the error names the path that could not be made.
    expect(result.stderr).toContain(t.ledger);
    expect(arrivals).toEqual([]);
    expect(result.stderr).not.toContain("leaving this machine");
    expect(result.stdout).not.toContain("sent to fake");
    expect(result.stdout).not.toContain("the fake peer has it");
  }, 30_000);

  test("control: the same send with the ledger in place goes through", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    const result = await send(t, TEXT);
    expect(result.code, result.stderr).toBe(0);
    expect(arrivals).toHaveLength(1);
  }, 30_000);

  test("a text the screen stops never reaches the ledger step: with the ledger broken it is still a block, not a ledger error", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await t.breakLedger();
    const result = await send(t, "write to wanida@example.com");
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("not sent to fake — kept in: email");
    expect(arrivals).toEqual([]);
    expect(blockedLines(t)).toHaveLength(1);
  }, 30_000);
});

describe("a2a send — the judge is automatic when a local model is configured, and said to be missing when it is not (D-181)", () => {
  const CLEAN = "the invoice for the quarter is ready for you to read";
  // The filter cannot see this one; only a model that reads meaning can.
  const PARAPHRASE = "pass this to the bookkeeper whose name means young woman";
  const THAI = /[฀-๿]/;
  const warnings = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith(JUDGE_WARNING_PREFIX));

  /** A model on loopback standing in for the local Ollama, answering `reply` and keeping what it was asked. */
  function localModel(reply: (text: string) => Response) {
    const asked: { model: string; text: string }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model: string; messages: { content: string }[] };
        const user = body.messages.at(-1)?.content ?? "";
        const text = user.slice(user.indexOf("TEXT:\n") + "TEXT:\n".length);
        asked.push({ model: body.model, text });
        return reply(text);
      },
    });
    peers.push({ stop: () => server.stop(true) });
    return { asked, host: `http://127.0.0.1:${server.port}`, env: { MIND_OLLAMA_MODEL: "local-stub", OLLAMA_HOST: `http://127.0.0.1:${server.port}` } };
  }
  const reveals = (flag: boolean) => (): Response => Response.json({ message: { content: JSON.stringify({ reveals: flag }) } });

  test("no judge named and no local model: two sends, two warnings — one line each, in English, before the message goes", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    const first = await send(t, CLEAN);
    const second = await send(t, CLEAN);
    for (const result of [first, second]) {
      expect(result.code, result.stderr).toBe(0);
      expect(warnings(result.stderr)).toEqual([judgeWarning("en")]);
      expect(THAI.test(result.stderr)).toBe(false);
      // Said before anything is announced as leaving, so a person who stops reading at the notice has read it.
      expect(result.stderr.indexOf(JUDGE_WARNING_PREFIX)).toBeLessThan(result.stderr.indexOf("leaving this machine"));
    }
    expect(arrivals).toHaveLength(2);
    expect(outRows(t)).toHaveLength(2);
  }, 60_000);

  test("filter-only is the filter's result: a paraphrase of a needle goes, and the line says that only the filter looked", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const result = await send(t, PARAPHRASE);
    expect(result.code, result.stderr).toBe(0);
    expect(arrivals.map((a) => a.text)).toEqual([PARAPHRASE]);
    expect(warnings(result.stderr)).toEqual([judgeWarning("en")]);
    expect(warnings(result.stderr)[0]).toContain("only the filter screened this");
  }, 60_000);

  test("a text the filter stops is not sent and not warned about: nothing left, nothing in the ledger", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    const result = await send(t, "please write to wanida@example.com about it");
    expect(result.code, result.stderr).toBe(1);
    expect(arrivals).toEqual([]);
    expect(warnings(result.stderr)).toEqual([]);
    expect(blockedLines(t).map((l) => l.findings)).toEqual([[{ rule: "email" }]]);
    expect(outRows(t)).toEqual([]);
  }, 60_000);

  test("Thai is chosen: the warning is the English, then the Thai, on the one line", async () => {
    const t = await setup();
    const { peer } = fakePeer(t);
    await t.allow(peer);
    const result = await send(t, CLEAN, { MIND_LANG: "th" });
    expect(result.code, result.stderr).toBe(0);
    expect(warnings(result.stderr)).toEqual([judgeWarning("th")]);
    expect(THAI.test(warnings(result.stderr)[0]!)).toBe(true);
  }, 60_000);

  test("a local model is configured: the judge reads the message by itself, and a reveal is not sent and not recorded as sent", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(reveals(true));
    const result = await send(t, PARAPHRASE, model.env);
    expect(model.asked).toEqual([{ model: "local-stub", text: PARAPHRASE }]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("the local judge read it as revealing");
    expect(warnings(result.stderr)).toEqual([]);
    expect(result.stderr).not.toContain("leaving this machine");
    expect(arrivals).toEqual([]);
    expect(blockedLines(t).map((l) => l.findings)).toEqual([[{ rule: "judge:reveals" }]]);
    expect(outRows(t)).toEqual([]);
  }, 60_000);

  test("a local model is configured and reads the message as clear: it is sent, with the ledger line already on disk, and no warning", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(reveals(false));
    const result = await send(t, CLEAN, model.env);
    expect(result.code, result.stderr).toBe(0);
    expect(model.asked).toHaveLength(1);
    expect(warnings(result.stderr)).toEqual([]);
    expect(arrivals).toHaveLength(1);
    const before = arrivals[0]!.ledgerThen.filter((r) => r.turn === arrivals[0]!.messageId);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ backend: "a2a:out:fake", prompt: CLEAN });
  }, 60_000);

  test("a local model that cannot answer keeps the message in: for a message there is no local fallback", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(() => new Response("down", { status: 500 }));
    const result = await send(t, CLEAN, model.env);
    expect(result.code, result.stderr).toBe(1);
    expect(arrivals).toEqual([]);
    expect(blockedLines(t).map((l) => l.findings)).toEqual([[{ rule: "judge:unsure" }]]);
    expect(outRows(t)).toEqual([]);
  }, 60_000);

  test("a judge that cannot answer says so: which model, where, that nothing was sent, and what to do", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(() => new Response("down", { status: 500 }));
    const result = await send(t, CLEAN, model.env);
    expect(result.code, result.stderr).toBe(1);
    expect(arrivals).toEqual([]);
    expect(result.stderr).toContain("the local judge could not decide, so it stays in");
    expect(result.stderr).toContain(`the judge (local-stub at ${model.host}) gave no clear answer: it may be down, still loading (it is given 20 s)`);
    expect(result.stderr).toContain("Nothing was sent, and a message has no local fallback");
    expect(result.stderr).toContain("send again");
    // The hint names the model and the address, never the text or a needle.
    expect(result.stderr).not.toContain(CLEAN);
    expect(result.stderr).not.toContain("Wanida");
  }, 60_000);

  test("a judge that reads the message as revealing is not a judge that is down: no hint about loading", async () => {
    const t = await setup();
    const { peer } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(reveals(true));
    const result = await send(t, PARAPHRASE, model.env);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).not.toContain("gave no clear answer");
  }, 60_000);

  test("a model the daemon relays to a hosted service is not made the judge: the filter alone looked, the line says what to fix, and the model is never asked", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(reveals(true));
    const result = await send(t, PARAPHRASE, { ...model.env, MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" });
    expect(model.asked).toEqual([]);
    expect(result.code, result.stderr).toBe(0);
    expect(arrivals.map((a) => a.text)).toEqual([PARAPHRASE]);
    expect(warnings(result.stderr)).toEqual([judgeWarning("en", "local-model-not-local")]);
    expect(warnings(result.stderr)[0]).toContain("-cloud or :cloud");
  }, 60_000);

  test("a host with no scheme is not a local model either, and the line says the host is what to fix", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    const result = await send(t, CLEAN, { MIND_OLLAMA_MODEL: "qwen", OLLAMA_HOST: "127.0.0.1:11434" });
    expect(result.code, result.stderr).toBe(0);
    expect(arrivals).toHaveLength(1);
    expect(warnings(result.stderr)).toEqual([judgeWarning("en", "local-model-not-local")]);
    expect(warnings(result.stderr)[0]).toContain("OLLAMA_HOST must be a full URL on a loopback address");
  }, 60_000);

  test("a ledger that cannot be written still means nothing is sent, with the judge on", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    await t.breakLedger();
    const model = localModel(reveals(false));
    const result = await send(t, CLEAN, model.env);
    expect(model.asked).toHaveLength(1);
    expect(result.code, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(t.ledger);
    expect(arrivals).toEqual([]);
    expect(result.stderr).not.toContain("leaving this machine");
  }, 60_000);

  test("an explicit empty MIND_EGRESS_JUDGE wins over a configured local model: the judge is not asked, and the warning is still said", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(reveals(true));
    const result = await send(t, PARAPHRASE, { ...model.env, MIND_EGRESS_JUDGE: "" });
    expect(model.asked).toEqual([]);
    expect(result.code, result.stderr).toBe(0);
    expect(arrivals.map((a) => a.text)).toEqual([PARAPHRASE]);
    expect(warnings(result.stderr)).toEqual([judgeWarning("en")]);
  }, 60_000);

  test("an explicit MIND_EGRESS_JUDGE names the model that is asked, whatever the local model is", async () => {
    const t = await setup();
    const { peer, arrivals } = fakePeer(t);
    await t.allow(peer);
    await writeNeedles(t, "Wanida Srisuk");
    const model = localModel(reveals(true));
    const result = await send(t, PARAPHRASE, { ...model.env, MIND_EGRESS_JUDGE: "named-guard" });
    expect(model.asked.map((a) => a.model)).toEqual(["named-guard"]);
    expect(result.code, result.stderr).toBe(1);
    expect(arrivals).toEqual([]);
  }, 60_000);
});

/** Read a stream into `into.text` as it arrives. */
function collect(stream: ReadableStream<Uint8Array>, into: { text: string }): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) into.text += decoder.decode(chunk, { stream: true });
  })();
}

/** Start `mind a2a serve` on a free loopback port and wait until it says where it listens. */
async function serve(t: Setup) {
  const child = Bun.spawn([BUN, "run", BIN, "a2a", "serve", t.soul, "--subject", SUBJECT, "--port", "0"], {
    cwd: ROOT,
    env: t.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = { text: "" };
  const err = { text: "" };
  children.push({ kill: (signal) => child.kill(signal), exited: child.exited, reading: Promise.all([collect(child.stdout, out), collect(child.stderr, err)]) });
  const banner = /listening for A2A at (http:\/\/\S+)/;
  await waitFor(() => banner.test(out.text) || child.exitCode !== null);
  const url = banner.exec(out.text)?.[1];
  expect(url, `the listener never said where it listens: ${out.text}${err.text}`).toBeDefined();
  return { url: url!, stderr: err };
}

const rpc = (text: string, messageId: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "SendMessage",
  params: { message: { role: "ROLE_USER", parts: [{ text }], messageId } },
});

async function post(url: string, token: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as { result?: { messageId: string; parts: { text: string }[] }; error?: { code: number; message: string } } };
}

function inboxLines(t: Setup): { from: string; messageId: string; text: string }[] {
  const path = join(t.personal, INBOX);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) : [];
}

describe("a2a serve — the ledger line is written before the message reaches the inbox (S8.2 AC5)", () => {
  const bob = (): Peer => ({ name: "bob", endpoint: "http://127.0.0.1:9/", inboundToken: newToken(), outboundToken: null, addedBy: "test", addedAt: "2026-10-13T00:00:00Z" });
  const TEXT = "a note from bob about the quarter";

  test("control: an allowed peer's message is acked, and is in the ledger and in the inbox, once, even when it is sent again", async () => {
    const t = await setup();
    const peer = bob();
    await t.allow(peer);
    const { url, stderr } = await serve(t);

    const first = await post(url, peer.inboundToken, rpc(TEXT, "m-1"));
    expect(first.status).toBe(200);
    expect(first.body.result?.messageId).toBe("ack-m-1");
    expect(first.body.result?.parts[0]?.text).toContain("Example Keeper's inbox");
    await post(url, peer.inboundToken, rpc(TEXT, "m-1"));

    const inRows = t.ledgerRows().filter((r) => r.backend === "a2a:in:bob");
    expect(inRows).toHaveLength(1);
    expect(inRows[0]).toMatchObject({ subject: SUBJECT, turn: "m-1", prompt: TEXT });
    expect(inboxLines(t)).toMatchObject([{ from: "bob", messageId: "m-1", text: TEXT }]);
    expect(stderr.text).toContain("a message from bob is in the inbox (m-1)");
  }, 30_000);

  test("a call without an allowed peer's token is refused and leaves nothing in the ledger or the inbox", async () => {
    const t = await setup();
    const peer = bob();
    await t.allow(peer);
    const { url } = await serve(t);

    const stranger = await post(url, newToken(), rpc(TEXT, "m-x"));
    expect(stranger.status).toBe(401);
    expect(t.ledgerRows()).toEqual([]);
    expect(inboxLines(t)).toEqual([]);
  }, 30_000);

  test("when the inbox cannot be written the ledger line is already there, and the sender is told it was not delivered", async () => {
    const t = await setup();
    const peer = bob();
    await t.allow(peer);
    // A directory where the inbox file must be: the append to it fails, whoever runs this.
    await mkdir(join(t.personal, INBOX), { recursive: true });
    const { url } = await serve(t);

    const answer = await post(url, peer.inboundToken, rpc(TEXT, "m-2"));
    expect(answer.body.error?.message).toContain("not delivered");
    expect(answer.body.result).toBeUndefined();
    const inRows = t.ledgerRows().filter((r) => r.backend === "a2a:in:bob");
    expect(inRows).toHaveLength(1);
    expect(inRows[0]).toMatchObject({ turn: "m-2", prompt: TEXT });
  }, 30_000);

  test("when the ledger cannot be written nothing reaches the inbox, and the sender is told it was not delivered", async () => {
    const t = await setup();
    const peer = bob();
    await t.allow(peer);
    await t.breakLedger();
    const { url } = await serve(t);

    const answer = await post(url, peer.inboundToken, rpc(TEXT, "m-3"));
    expect(answer.body.error?.message).toContain("not delivered");
    expect(answer.body.result).toBeUndefined();
    expect(existsSync(join(t.personal, INBOX))).toBe(false);
    expect(inboxLines(t)).toEqual([]);

    // The same message sent again, still with no ledger, is still not delivered: a retry is not a way round it.
    const again = await post(url, peer.inboundToken, rpc(TEXT, "m-3"));
    expect(again.body.error?.message).toContain("not delivered");
    expect(existsSync(join(t.personal, INBOX))).toBe(false);
  }, 30_000);
});
