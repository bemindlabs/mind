/**
 * `mind web <dir> --subject <id>` — a page for one agent (D-060).
 *
 * Reads what the commands read and serves it in plain words; every button
 * runs the CLI as a child. Loopback only unless `--host` says otherwise.
 */

import { readMind } from "../../src/env.ts";
import { chosenLanguage } from "../../src/lang.ts";
import { reasonsIn } from "../../src/decide/sensitive-lang.ts";
import { firedPath, nextDue, parseTriggers, readFired, triggersDirFor, TRIGGERS_FILE } from "../../src/decide/triggers.ts";
import { proposalsDir, readProposals } from "../../src/decide/proposals.ts";
import { readTriage, typesafeKey } from "../../src/decide/triage.ts";
import { engineNotDumpable, notDumpableNote } from "../../src/exec/fence.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import { query } from "../../src/ledger/store.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { runGuarded } from "../../src/spawn.ts";
import { runWithDeadline } from "../../src/web/deadline.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { startWeb, tailnetNames } from "../../src/web/server.ts";
import { ago, approvalLists, excerpt, inLanguage, levelSentence, operateSentence, remoteForPage, triageChips, type AgentInfo, type PrivacyState, type SettingsState, type ViewState } from "../../src/web/view.ts";
import { latestScreen, pendingApprovals, recentTasks } from "../../src/task/screen.ts";
import { answerHeld } from "../../src/task/answer.ts";
import { tasksDir } from "../../src/task/store.ts";
import { basisDirFor, readBasis, recordState } from "../../src/consent/basis.ts";
import { listMemories, memoryGraph, readMemoryFile, whoMentions } from "../../src/web/memories.ts";
import { keyPrint, loadOrCreateKey, replaceKey } from "../../src/web/key.ts";
import { encodeQr, qrTerminal } from "../../src/web/qr.ts";
import { SOUL_DIR } from "../../src/agent/index.ts";
import { linkLines } from "../../src/web/banner.ts";
import { isatty } from "node:tty";
import { addSubscription, forgetAll, forgetEverything, notifyAll, pushDirFor, removeSubscription, subscriptionsFor, WaitingWatch, type Fetcher } from "../../src/web/push.ts";
import { profileOf } from "../../src/soul/profile.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { a2aDirFor, readPeers } from "../../src/a2a/peers.ts";
import { chatDirFor, contactKey, readChatState } from "../../src/connectors/users.ts";
import { describeFindings, judgeModelFor, loadLexicon, readBlocked } from "../../src/egress/index.ts";
import { allBackends, PHASE_A_BACKENDS, routeModels, takesNoModel, VENDORS } from "../../src/exec/index.ts";
import { loadPrices, pricesInForce } from "../../src/pricing/table.ts";
import { OLLAMA_MODEL_ENV } from "../../src/exec/ollama-exec.ts";
import { modelChoices, ollamaTags, type ModelsState } from "../../src/web/models.ts";
import { stateRoot } from "../../src/state.ts";
import { readCheck } from "../../src/update/version.ts";
import { VERSION } from "../../src/version.ts";
import { homedir } from "node:os";
import { decideDial, dialEnv } from "../dial.ts";
import { bold, dim, ledgerEnv, parseArgs, report, usageError } from "../shared.ts";
import { extname, join, resolve } from "node:path";

const USAGE = "usage: mind web <dir> --subject <id> [--port <n>] [--host <addr>] [--name <host,…>] [--https] [--key-file <path>] [--qr] [--backend a,b] [--model <m> | --model <backend>=<m>,…]";

/** The default port: Mind's block in the dev band, beside the A2A default (30700). */
export const WEB_PORT = 30701;

async function gather(dir: string, id: SubjectId, options: ReadonlyMap<string, string> = new Map()): Promise<ViewState> {
  const now = new Date();
  // GL-01: English, and the Thai halves only when Thai is chosen (`MIND_LANG` or the locale).
  const language = chosenLanguage(process.env);
  const loaded = await loadSoul(dir, id);
  const verdict = await decideDial(dir, dialEnv(), id);
  const level = levelSentence(verdict.effective.act, verdict.effective.stopped);

  const pdir = await proposalsDir(dialEnv(), id);
  const inventory = pdir.ok ? await readProposals(pdir.path) : { proposals: [], unreadable: [] };
  const waiting = [];
  for (const { proposal } of [...inventory.proposals].sort((a, b) => b.proposal.at.localeCompare(a.proposal.at))) {
    if (proposal.decision === null) {
      const triage = pdir.ok ? await readTriage(pdir.path, proposal.id) : undefined;
      waiting.push({
        id: proposal.id,
        what: proposal.what,
        why: proposal.why,
        impact: proposal.impact,
        filed: ago(proposal.at, now),
        byAgent: (proposal as { filedBy?: string }).filedBy === "agent",
        chips: triage === undefined ? [] : triageChips(triage),
      });
    }
  }

  // `triggers.md` lives in the agent's `soul/`, and `mind triggers` is given that directory, which is also what its
  // fire times are keyed by. The page may be started on the repository root or on `soul/` itself; both show the
  // same schedule (B4 of the first stranger run: it only looked in the root and showed nothing).
  const triggers: { id: string; every: string; next: string }[] = [];
  const inSoul = join(dir, SOUL_DIR);
  const triggersAt = (await Bun.file(join(inSoul, TRIGGERS_FILE)).exists()) ? inSoul : dir;
  const file = Bun.file(join(triggersAt, TRIGGERS_FILE));
  if (await file.exists()) {
    const parsed = parseTriggers(TRIGGERS_FILE, await file.text());
    if (parsed.ok) {
      const fired = await readFired(firedPath(triggersAt, triggersDirFor(dialEnv(), id)));
      for (const t of parsed.value) {
        const due = nextDue(t, fired, now);
        triggers.push({ id: t.id, every: t.every, next: due <= now ? "now" : ago(due.toISOString(), now) });
      }
    }
  }

  const ledger = await query(ledgerEnv(), id);
  const recent = [...ledger.entries]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10)
    .map((e) => ({ id: e.id, when: ago(e.at, now), backend: e.backend, asked: excerpt(e.prompt), ok: e.confidence === "confirmed" || e.confidence === "partial" }));

  return {
    agent: {
      name: loaded.ok ? loaded.soul.role.name : "this agent",
      role: loaded.ok ? loaded.soul.role.role : "its soul does not load — run `mind soul check` in a terminal",
      subject: id,
      dir,
    },
    autonomy: {
      ...level,
      levels: { read: verdict.effective.dial.read, write: verdict.effective.dial.write, run: verdict.effective.dial.run, reach: verdict.effective.dial.reach, operate: verdict.effective.dial.operate },
      operate: inLanguage(operateSentence(verdict.effective.operate), language),
    },
    stopped: verdict.effective.stopped,
    waiting,
    // D-144 §2 and D-153 follow-up — the rules are the store's (`refileProblem`), the ones `proposal new --refile`
    // asks. An approval that names no action is never in `approved`: `turn` refuses it, so it is not offered with
    // "Do it now"; it is in `needsReapproval`, or — asked again already — in no list at all.
    ...approvalLists(inventory, now),
    triggers,
    tasks: await recentTasks(dialEnv(), id),
    taskApprovals: (await pendingApprovals(dialEnv(), id, now)).map((a) => ({ ...a, reasons: reasonsIn(a.reasons, language) })),
    recent,
    canTriage: (await typesafeKey(process.env)) !== undefined,
    version: { current: VERSION, latest: (await readCheck(stateRoot(homedir(), process.env)))?.latest ?? null },
    engine: engineOf(options, ledger.entries, now),
  };
}

/** The chain `mind web` was started with: its `--backend`, else the usual one. */
function startedChain(options: ReadonlyMap<string, string>): string[] {
  const named = (options.get("backend") ?? "").split(",").map((b) => b.trim()).filter((b) => b !== "");
  return named.length > 0 ? named : [...PHASE_A_BACKENDS];
}

/** What answers from this page: the chain, the local model, the judge, and the last turn that really answered. */
function engineOf(
  options: ReadonlyMap<string, string>,
  entries: readonly { readonly at: string; readonly backend: string; readonly model: string | null; readonly model_requested?: string | null; readonly confidence: string }[],
  now: Date,
): ViewState["engine"] {
  const chain = startedChain(options);
  const answered = [...entries]
    .filter((e) => (e.confidence === "confirmed" || e.confidence === "partial") && !e.backend.includes(":"))
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  // D-142: `--model` is ollama's only when it names ollama's step — `--model claude=opus` is not a local model.
  const routed = routeModels(options.get("model"), chain);
  return {
    chain,
    localModel: (routed.ok ? routed.models.get("ollama") : undefined) || readMind(OLLAMA_MODEL_ENV, process.env)?.trim() || null,
    judge: judgeModelFor("cloud-turn", process.env),
    last:
      answered === undefined
        ? null
        : { backend: answered.backend, model: answered.model, modelRequested: answered.model_requested ?? null, when: ago(answered.at, now) },
  };
}

/**
 * The chat picker's choices (D-085, D-142): which backends answer, and model names with a reason to work — the
 * vendor's own documented names and the price table's for that backend, never the ledger's history.
 */
async function gatherModels(options: ReadonlyMap<string, string>): Promise<ModelsState> {
  const all = allBackends();
  const ledger = ledgerEnv();
  const [backends, prices, tags] = await Promise.all([
    Promise.all(all.map(async (b) => ({ id: b.id, available: (await b.available()).ok }))),
    loadPrices(ledger.home, ledger.env),
    // The local list, if Ollama answers quickly; a picker is not worth waiting for.
    fetch(`${(process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434").replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(1500) })
      .then(async (r) => (r.ok ? ollamaTags(await r.json()) : []))
      .catch(() => []),
  ]);
  const engine = engineOf(options, [], new Date());
  return {
    backends,
    chain: engine.chain,
    defaultTurn: { backend: options.get("backend") ?? null, model: options.get("model") ?? null },
    models: modelChoices({
      backends: all.map((b) => b.id),
      listed: Object.fromEntries(VENDORS.flatMap((v) => (v.model === undefined ? [] : [[v.id, v.model.listed] as const]))),
      // The owner's entries and the shipped ones — the shipped alone while the owner's file cannot be read.
      priced: pricesInForce(prices),
      modelless: all.map((b) => b.id).filter((b) => takesNoModel(b) !== undefined),
      localModel: engine.localModel,
      ollama: tags,
    }),
  };
}

/** The agent repository's remote, HEAD and last commit — read with the git verbs Mind may use. */
async function repoInfo(dir: string, now: Date): Promise<AgentInfo["repo"]> {
  const git = async (args: readonly string[]) => {
    const out = await runGuarded(["git", ...args], { cwd: dir }).catch(() => undefined);
    return out === undefined || out.code !== 0 ? "" : new TextDecoder().decode(out.stdout).trim();
  };
  const remotes = await git(["config", "--get-regexp", "^remote\\..*\\.url$"]);
  // origin first, else whichever is listed first.
  const lines = remotes.split("\n").filter((l) => l !== "");
  const pick = lines.find((l) => l.startsWith("remote.origin.url ")) ?? lines[0];
  const shown = pick === undefined ? null : remoteForPage(pick.slice(pick.indexOf(" ") + 1));
  const head = (await git(["rev-parse", "--short", "HEAD"])) || null;
  let lastCommit: string | null = null;
  let lastCommitAt: string | null = null;
  if (head !== null) {
    const commit = await git(["cat-file", "commit", "HEAD"]);
    const [headers, ...message] = commit.split("\n\n");
    lastCommit = (message.join("\n\n").split("\n")[0] ?? "").trim() || null;
    const stamp = /^committer .* (\d+) [+-]\d{4}$/m.exec(headers ?? "");
    lastCommitAt = stamp === null ? null : ago(new Date(Number(stamp[1]) * 1000).toISOString(), now);
  }
  return { remote: shown?.remote ?? null, web: shown?.web ?? null, head, lastCommit, lastCommitAt };
}

/** What the Agent tab shows: the soul in full, the repository, and what the ledger counts. */
async function gatherAgent(dir: string, id: SubjectId): Promise<AgentInfo> {
  const now = new Date();
  const loaded = await loadSoul(dir, id);
  const memories = await listMemories(dir);
  const ledger = await query(ledgerEnv(), id);
  const counts = new Map<string, number>();
  let last: string | null = null;
  for (const e of ledger.entries) {
    counts.set(e.backend, (counts.get(e.backend) ?? 0) + 1);
    if (last === null || e.at > last) last = e.at;
  }
  const stats = {
    memories: memories.length,
    turns: ledger.entries.length,
    lastTurn: last === null ? null : ago(last, now),
    byBackend: [...counts].map(([backend, turns]) => ({ backend, turns })).sort((a, b) => b.turns - a.turns),
  };
  const repo = await repoInfo(dir, now);
  if (!loaded.ok) {
    return {
      ok: false, problems: loaded.issues.map((i) => `${i.file ?? ""}${i.line === undefined ? "" : `:${i.line}`} ${i.message}`.trim()),
      name: "this agent", role: "", subject: id, dir, repo, prohibitions: [], scope: { does: "", doesNot: "" }, person: null, roleNotes: "", personNotes: "", stats,
    };
  }
  const { role, person } = loaded.soul;
  return {
    ok: true,
    problems: [],
    name: role.name,
    role: role.role,
    subject: id,
    dir,
    repo,
    prohibitions: role.prohibitions,
    scope: { does: role.scope.does, doesNot: role.scope.does_not },
    person: {
      tone: person.tone,
      addressesUserAs: person.addresses_user_as,
      refersToSelfAs: person.refers_to_self_as,
      principles: person.principles,
      inheritsFrom: person.inherits_from,
    },
    roleNotes: role.body.trim(),
    personNotes: person.body.trim(),
    stats,
  };
}

/** What the Privacy tab shows: capture, what was kept in, the needles, and the basis records (gap 3, D-079). */
async function gatherPrivacy(dir: string, id: SubjectId): Promise<PrivacyState> {
  const now = new Date();
  const status = await runGuarded([...engineCommand().argv, "observe", "status", "--subject", id], { env: { ...process.env, NO_COLOR: "1" } }).catch(() => undefined);
  const text = status === undefined ? "" : new TextDecoder().decode(status.stdout).replace(/\u001b\[[0-9;]*m/g, "");
  const lines = text.split("\n\n")[0]!.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const blocked = [...(await readBlocked(dialEnv(), id))].sort((a, b) => b.at.localeCompare(a.at));
  const loaded = await loadSoul(dir, id);
  const { lexicon } = await loadLexicon(dialEnv(), id, loaded.ok ? loaded.soul.person.inherits_from : []);
  const records = await readBasis(basisDirFor(dialEnv(), id));
  return {
    capture: { on: lines.some((l) => l.startsWith("capture: on")), lines },
    keptIn: blocked.slice(0, 50).map((b) => ({ when: ago(b.at, now), at: b.at, backend: b.backend, why: describeFindings(b.findings) })),
    keptInTotal: blocked.length,
    needles: lexicon.needles.length,
    judge: judgeModelFor("cloud-turn", process.env),
    basis: records.map((r) => ({ id: r.id, basis: r.basis, uses: r.uses, approvedBy: r.approvedBy, at: r.at.slice(0, 10), expires: r.expires, state: recordState(r, now), note: r.note })),
  };
}

/** What the Settings tab shows. Read fresh each time it is opened. */
async function gatherSettings(dir: string, id: SubjectId, options: ReadonlyMap<string, string>): Promise<SettingsState> {
  const now = new Date();
  const verdict = await decideDial(dir, dialEnv(), id);
  const dial = verdict.effective.dial;
  const loaded = await loadSoul(dir, id);
  const chat = await readChatState(chatDirFor(dialEnv(), id));
  const peers = await readPeers(a2aDirFor(dialEnv(), id));
  const { lexicon } = await loadLexicon(dialEnv(), id, loaded.ok ? loaded.soul.person.inherits_from : []);
  const backends = await Promise.all(allBackends().map(async (b) => ({ id: b.id, available: (await b.available()).ok })));
  const check = await readCheck(stateRoot(homedir(), process.env));
  return {
    levels: { read: dial.read, write: dial.write, run: dial.run, reach: dial.reach, operate: dial.operate },
    operate: inLanguage(operateSentence(verdict.effective.operate), chosenLanguage(process.env)),
    stopped: verdict.effective.stopped,
    backends,
    defaultTurn: { backend: options.get("backend") ?? null, model: options.get("model") ?? null },
    chatUsers: chat.users.map((u) => ({ platform: u.platform, userId: u.userId, label: u.label, told: chat.contacted.includes(contactKey(u.platform, u.userId)), added: ago(u.addedAt, now) })),
    peers: peers.map((p) => ({ name: p.name, endpoint: p.endpoint, added: ago(p.addedAt, now) })),
    guards: { judge: judgeModelFor("cloud-turn", process.env), triage: (await typesafeKey(process.env)) !== undefined, needles: lexicon.needles.length },
    version: { current: VERSION, latest: check?.latest ?? null, checked: check === undefined ? null : ago(check.at, now) },
  };
}

export async function cmdWeb(argv: readonly string[]): Promise<number> {
  // EXEC-02: this page holds the owner's environment for as long as it runs, and every turn it starts is a
  // program of the same user. With the flag at 0 `/proc/<pid>/environ` and `mem` belong to root.
  const closed = notDumpableNote(engineNotDumpable());
  if (closed !== undefined) console.error(dim(closed));
  const { positional, options } = parseArgs(argv, ["https", "qr"]);
  const dir = positional[0];
  const raw = options.get("subject");
  if (dir === undefined || positional.length > 1 || raw === undefined || raw === "") return usageError(USAGE);
  let id: SubjectId;
  try {
    id = subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);
  const port = Number(options.get("port") ?? String(WEB_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return usageError(`${USAGE} — --port is a number`);
  const hostname = options.get("host") ?? "127.0.0.1";
  const turnFlags = ["backend", "model"].flatMap((name) => {
    const value = options.get(name);
    return value === undefined || value === "" ? [] : [`--${name}`, value];
  });
  // D-142: a `--model` every turn from this page would refuse is refused once, here, rather than on every message.
  const startedModels = routeModels(options.get("model"), startedChain(options));
  if (!startedModels.ok) return usageError(`${USAGE} — ${startedModels.reason}`);

  // The names a browser may use to reach it: any given with --name, and — on
  // a tailnet address — this machine's own tailnet names, so the URL a person
  // types is not refused as a wrong host.
  const names = (options.get("name") ?? "").split(",").map((n) => n.trim()).filter((n) => n !== "");
  // --https: something in front (tailscale serve) ends TLS and forwards here,
  // with the tailnet name in the Host header — so the name must be accepted,
  // and the link printed is the https one.
  const https = options.has("https");
  const keyFile = options.get("key-file");
  let token: string | undefined;
  if (keyFile !== undefined && keyFile !== "") {
    const key = await loadOrCreateKey(keyFile);
    if (!key.ok) {
      console.error(`mind: ${key.reason}`);
      return 1;
    }
    token = key.key;
    if (key.created) console.error(dim(`mind: a page key was written to ${keyFile} (600); the link stays the same across restarts.`));
  }
  if (hostname.startsWith("100.") || https) {
    const status = await runGuarded(["tailscale", "status", "--self", "--json"]).catch(() => undefined);
    if (status !== undefined && status.code === 0) names.push(...tailnetNames(new TextDecoder().decode(status.stdout)));
  }

  const absolute = resolve(dir);
  // S14.3 (D-130): phones that asked to be told. Off until one subscribes; only this process sends.
  const pushDir = pushDirFor(dialEnv(), id);
  const relayFetch: Fetcher = (url, init) => fetch(url, init);
  const server = startWeb(
    {
      dir: absolute,
      subject: id,
      turnFlags,
      state: () => gather(absolute, id, options),
      settings: () => gatherSettings(absolute, id, options),
      models: () => gatherModels(options),
      agent: () => gatherAgent(absolute, id),
      privacy: () => gatherPrivacy(absolute, id),
      memories: () => listMemories(absolute),
      memoryGraph: () => memoryGraph(absolute),
      memoryWho: (thing) => whoMentions(absolute, thing),
      memory: (path) => readMemoryFile(absolute, path),
      // Gap 2 (D-079): one turn from the ledger, asked and answered, for "Recently".
      turnDetail: async (entryId) => {
        const e = (await query(ledgerEnv(), id)).entries.find((x) => x.id === entryId);
        if (e === undefined) return undefined;
        return { asked: e.prompt, answer: e.text, backend: e.backend, model: e.model, modelRequested: e.model_requested ?? null, when: ago(e.at, new Date()), content: e.content };
      },
      profile: async () => {
        const loaded = await loadSoul(absolute, id);
        return loaded.ok ? { ok: true as const, profile: profileOf(loaded.soul) } : { ok: false as const, reason: loaded.issues.map((i) => i.message).join("; ") };
      },
      memoryWrite: async (path, content) => {
        const tmp = await mkdtemp(join(tmpdir(), "mind-memory-"));
        try {
          const file = join(tmp, "memory.md");
          await writeFile(file, content, { mode: 0o600 });
          const out = await runGuarded([...engineCommand().argv, "memory", "write", absolute, "--subject", id, "--file", path, "--from", file, "--yes"]);
          return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: out.stderr };
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      },
      memoryImport: async (source, write) => {
        const tmp = await mkdtemp(join(tmpdir(), "mind-import-"));
        try {
          const how = source.kind === "url" ? ["--url", source.url] : ["--from", join(tmp, `upload${extname(source.name).toLowerCase()}`), "--name", source.name];
          if (source.kind === "file") await writeFile(how[1]!, source.bytes, { mode: 0o600 });
          const out = await runGuarded([...engineCommand().argv, "memory", "import", absolute, "--subject", id, ...how, ...(write ? ["--yes"] : [])]);
          return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: out.stderr };
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      },
      editProfile: async (profile, write) => {
        // Handed to the command as a file that lives only as long as the call.
        const dir = await mkdtemp(join(tmpdir(), "mind-profile-"));
        try {
          const file = join(dir, "profile.json");
          await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
          const out = await runGuarded([...engineCommand().argv, "soul", "edit", absolute, "--subject", id, "--profile", file, ...(write ? ["--yes"] : [])]);
          return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: out.stderr };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      push: {
        subscribe: (relay, handle, key) => addSubscription(pushDir, relay, handle, key, new Date()),
        unsubscribe: async (handle) => {
          const gone = await removeSubscription(pushDir, handle);
          if (gone !== undefined) await forgetAll([gone], relayFetch);
          return gone !== undefined;
        },
        count: async (key) => (await subscriptionsFor(pushDir, key)).length,
        clear: (key) => forgetEverything(pushDir, key, relayFetch),
      },
      taskScreen: (task) => latestScreen(dialEnv(), id, task),
      taskAnswer: async (task, approval, verdict, stop) => {
        const tasks = await tasksDir(dialEnv(), id);
        if (!tasks.ok) return { ok: false as const, kind: "no-task" as const, reason: tasks.reason };
        const answered = await answerHeld({ env: dialEnv(), tasks: tasks.path, subject: id, task, approval, verdict, by: "the owner, on the web page", stop, now: new Date(), from: "web" });
        return answered.ok ? { ...answered, approval: { ...answered.approval, reasons: reasonsIn(answered.approval.reasons, chosenLanguage(process.env)) } } : answered;
      },
      run: async (args, runOptions) => {
        if (runOptions?.timeoutMs === undefined) {
          const out = await runGuarded([...engineCommand().argv, ...args]);
          return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: out.stderr };
        }
        // D-152: a deadline — SIGTERM to the child's group, SIGKILL after the grace (src/web/deadline.ts).
        const out = await runWithDeadline([...engineCommand().argv, ...args], runOptions.timeoutMs);
        return { code: out.code, stdout: out.stdout, stderr: out.stderr, timedOut: out.timedOut };
      },
    },
    {
      port,
      hostname,
      names,
      scheme: https ? "https" : "http",
      ...(token === undefined ? {} : { token }),
      ...(keyFile === undefined || keyFile === "" ? {} : { saveKey: (key: string) => replaceKey(keyFile, key) }),
      onRotate: () => console.error(dim(`mind: the page's key was changed from the page — every paired phone and every old link stop working${keyFile ? `; the new one is in ${keyFile}` : ""}.`)),
    },
  );
  // D-162: the key goes only to a terminal. A service, a pipe or a file keeps what it is given (journald keeps
  // stdout and stderr both), so there the link is printed without its key — the key file's path instead, or the
  // key masked when there is no file. `isatty(1)`, never `process.stdout` (bin/shared.ts says why).
  const terminal = isatty(1);
  const shown = linkLines(server.url, { terminal, ...(keyFile === undefined || keyFile === "" ? {} : { keyFile: resolve(keyFile) }) });
  console.log(bold(`${loaded.soul.role.name} — open this in your browser:`));
  console.log(`  ${shown.link}`);
  if (shown.note !== undefined) console.log(dim(`  ${shown.note}`));
  if (names.length > 0) console.log(dim(`  also answers as ${[hostname, ...names.slice(1)].join(", ")} — the same key after #t=`));
  // S14.2: the app pairs by scanning the link rather than typing a 64-character key.
  if (options.has("qr")) {
    // The code is the link, key included: a log that kept it would be a log anyone could pair from (D-162).
    const modules = terminal ? encodeQr(server.url, "M") : undefined;
    console.log(
      modules === undefined
        ? dim("  (no pairing code here — it holds the key and this output is not a terminal; run --qr at a terminal, or pair from the page)")
        : modules === null
          ? dim("  (the link is too long for a code — paste it into the app instead)")
          : `${qrTerminal(modules)}\n${dim("  Scan with the Mind app. The code is the link, key included — show it only to your own phone.")}`,
    );
  }
  console.log(
    dim(
      (hostname === "127.0.0.1" || hostname === "localhost"
        ? https
          ? "On loopback, reached through the https proxy in front of it. "
          : "Only this computer can reach it. "
        : `Listening on ${hostname}: anything that can reach that address and has the link can use it. `) +
        (terminal ? "The link carries a one-time key; keep it to yourself." : "The key is never printed off a terminal (D-162).") +
        " Ctrl-C stops the page (D-060).",
    ),
  );
  // A stop lets what is running finish (an import that has written its file and is rebuilding the index, a
  // turn waiting on a model) so the page hears how it went; a second signal stops at once (D-088).
  // Every 30 s: a proposal waiting that was not before → one content-free notice to each subscribed phone.
  const watch = new WaitingWatch();
  const look = async () => {
    const pdir = await proposalsDir(dialEnv(), id);
    const inventory = pdir.ok ? await readProposals(pdir.path) : { proposals: [] };
    const waitingIds = inventory.proposals.filter(({ proposal }) => proposal.decision === null).map(({ proposal }) => proposal.id);
    if (!watch.due(waitingIds, Date.now())) return;
    // Only the phones paired with the key this page holds now (D-130).
    const subscriptions = await subscriptionsFor(pushDir, keyPrint(server.token));
    if (subscriptions.length === 0) return;
    const { sent, failed } = await notifyAll(subscriptions, relayFetch);
    watch.sent(Date.now());
    console.error(dim(`mind: told ${sent} phone(s) something is waiting${failed > 0 ? `; ${failed} relay call(s) failed` : ""}.`));
  };
  await look().catch(() => undefined);
  const watching = setInterval(() => void look().catch(() => undefined), 30_000);
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = () => {
      clearInterval(watching);
      if (stopping) {
        console.error("mind: stopping now — anything still running is cut off.");
        void server.stop(true).then(done);
        return;
      }
      stopping = true;
      const running = server.pending();
      if (running > 0) console.error(`mind: stopping — letting ${running} request(s) finish first. Again to stop at once.`);
      void server.stop().then(done);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
