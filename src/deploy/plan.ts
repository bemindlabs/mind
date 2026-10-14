/**
 * S13.1 — `mind deploy plan`: what would go where, before anything is done.
 *
 * D-100 widened I-6's "on this machine" to "on a machine the owner controls",
 * on four conditions: the disk there is encrypted with a key outside the
 * provider's place, `erase` reaches it, the machines talk over the tailnet or
 * ssh with no public port, and the first deploy waits for a typed phrase. Before
 * any of that is built (S13.2–S13.5), a person has to be able to see the whole
 * of it — every byte of theirs that would move, where it would land, what stays,
 * which of the four conditions this provider can meet and how, and every
 * command `apply` would run — and argue with it. That is this file.
 *
 * ## What it reads, and what it does not do
 *
 * It reads sizes off this disk (`readdir` and `lstat`, never the contents of a
 * place), the agent's `.git/HEAD` to know whether there is a commit to clone,
 * and whether the personal directory sits inside a repository. It writes
 * nothing, opens no socket and starts no process: every command in the plan is
 * an argv in a list, shown and never run. `test/deploy/no-network.test.ts`
 * walks this directory's import closure for a subprocess or a socket, and
 * `test/deploy/plan.test.ts` runs a plan with both taken away and counts the
 * tree before and after.
 *
 * ## One data map, evaluated twice
 *
 * The places are `erase`'s own (`src/erase/map.ts`, S7.1): evaluated with this
 * machine's roots they say where each thing is here, and evaluated with the
 * remote's roots they say where it would be there. The remote's paths are
 * therefore the ones the engine there resolves — the same functions — which is
 * also what lets D-100 #2 be met: `erase` run there finds every place.
 *
 * Everything personal lands on the encrypted volume: the agent's repository
 * (memory/ and the soul are in it), the state root and the data root, and the
 * home the services run with. Only the binary and the unit files are on the
 * boot disk, and neither holds anything of anybody's.
 */

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DERIVED_DIR, SOUL_DIR } from "../agent/template.ts";
import { dataMap, type MapEnv, type MapTree, type Travel } from "../erase/map.ts";
import type { PlaceId } from "../erase/place-id.ts";
import { personalDir } from "../guard/personal.ts";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { RELEASE_REPO } from "../update/version.ts";
import { binaryAsset, commandsFor, type Placeholder, type Step } from "./commands.ts";
import { DEFAULT_DISK_GB, type Target } from "./target.ts";

/** The id of the plan document, for a script that parses `deploy plan --json`. */
export const DEPLOY_PLAN_SCHEMA = "mind/deploy-plan@1";

/** The encrypted volume's mount point there. Everything personal is under it. */
export const REMOTE_VOLUME = "/srv/mind";
/** The account the services run as there — not the one you ssh in with. */
export const REMOTE_USER = "mind";
/** On the boot disk: the binary holds nothing of anybody's. */
export const REMOTE_BINARY = "/usr/local/bin/mind";
/** `mind web`'s own default (`WEB_PORT` in bin/commands/web.ts), on loopback there. */
export const REMOTE_WEB_PORT = 30701;
/** Every how-many minutes the triggers timer ticks — `triggers schedule`'s default. */
export const TRIGGER_EVERY_MIN = 5;
/** The container's size on a VPS, where the target file has no `diskGb` (the target's own default). */
export const DEFAULT_CONTAINER_GB = DEFAULT_DISK_GB;

/** Where things would be on the machine there. */
export interface RemoteLayout {
  readonly volume: string;
  /** HOME for the services: on the volume, so nothing a program writes under ~ is left in the clear. */
  readonly home: string;
  readonly stateHome: string;
  readonly dataHome: string;
  readonly agentDir: string;
  readonly binary: string;
  readonly user: string;
  /** The page's link key there (`web --key-file`), made there, on the volume. */
  readonly webKey: string;
}

/**
 * The layout on a volume mounted at `volume`: the current one by default. `erase --remote` passes the mount point an
 * earlier plan named, so a machine set up by hand from that plan is counted too (I-4).
 */
export function remoteLayout(subject: SubjectId, volume: string = REMOTE_VOLUME): RemoteLayout {
  return {
    volume,
    home: `${volume}/home`,
    stateHome: `${volume}/state`,
    dataHome: `${volume}/data`,
    agentDir: `${volume}/agents/${subject}`,
    binary: REMOTE_BINARY,
    user: REMOTE_USER,
    webKey: `${volume}/home/web.key`,
  };
}

/** The roots the engine there resolves every place against — the services' environment. */
export function remoteEnv(layout: RemoteLayout): MapEnv {
  return { home: layout.home, env: { XDG_STATE_HOME: layout.stateHome, XDG_DATA_HOME: layout.dataHome } };
}

/** What is in one place on this disk. */
export interface Size {
  readonly files: number;
  readonly bytes: number;
  /** Links go as links (tar does not follow them); what they point at does not go. */
  readonly symlinks: number;
}

/**
 * Count one directory: files, bytes, symlinks. `null` when there is nothing there.
 *
 * `lstat` only — a size is a question about the file, not about what is in it,
 * and a place is somebody's data. Not `census` from the observer: that one
 * reads every byte to count lines, which a plan does not need and a repository's
 * pack files would make slow.
 *
 * @param skip Names at the top level to leave out (`.git`, `.mind`).
 */
export async function measure(dir: string, skip: readonly string[] = []): Promise<Size | null> {
  const top = await stat(dir).catch(() => undefined);
  if (top === undefined) return null;
  if (!top.isDirectory()) return { files: 1, bytes: top.size, symlinks: 0 };

  let files = 0;
  let bytes = 0;
  let symlinks = 0;
  const walk = async (at: string, depth: number): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (depth === 0 && skip.includes(entry.name)) continue;
      const path = join(at, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      bytes += (await lstat(path).catch(() => undefined))?.size ?? 0;
    }
  };
  await walk(dir, 0);
  return { files, bytes, symlinks };
}

/** Whether the agent directory has a commit a clone would carry. */
export type RepoState = "committed" | "no-commits" | "not-a-repo" | "unknown";

/**
 * Read `.git/HEAD` and the ref it names — two files, no `git`.
 *
 * `unknown` for a worktree or submodule (`.git` is a file there), for a
 * reftable repository, and for any HEAD this does not recognise: the plan then
 * says it could not tell, rather than refusing a repository it did not understand.
 */
export async function repoState(agentDir: string): Promise<RepoState> {
  const git = join(agentDir, ".git");
  const info = await stat(git).catch(() => undefined);
  if (info === undefined) return "not-a-repo";
  if (!info.isDirectory()) return "unknown";
  // A reftable repository (git ≥ 2.45) keeps no loose refs and no packed-refs;
  // reading it as "no commits" would refuse a repository that has them.
  if ((await stat(join(git, "reftable")).catch(() => undefined)) !== undefined) return "unknown";
  const head = (await readFile(join(git, "HEAD"), "utf8").catch(() => "")).trim();
  const ref = /^ref: (refs\/\S+)$/.exec(head);
  if (ref === null) return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ? "committed" : "unknown";
  if ((await stat(join(git, ref[1]!)).catch(() => undefined)) !== undefined) return "committed";
  const packed = await readFile(join(git, "packed-refs"), "utf8").catch(() => "");
  return packed.split("\n").some((line) => line.endsWith(` ${ref[1]}`)) ? "committed" : "no-commits";
}

/**
 * How one entry gets there: the data map's own {@link Travel} kinds, plus the
 * two things that go and are not a place of anybody's data — the binary
 * (`engine`) and the repository the clone carries (`clone`).
 */
export type EntryTravel = "engine" | "clone" | Travel["kind"];

/** One thing the plan is about: where it is here, where it would be there, how big. */
export interface PlanEntry {
  readonly key: string;
  readonly place: PlaceId | null;
  readonly travel: EntryTravel;
  readonly label: string;
  /** On this machine. `null` for what is not on this disk (the binary, the vector collection). */
  readonly here: string | null;
  /** There. `null` for what does not go and is not made there. */
  readonly there: string | null;
  /** `null` when it is not on this disk, or not there at all. */
  readonly size: Size | null;
  /** Lands on the encrypted volume. */
  readonly encrypted: boolean;
  /** Why it is in this list rather than a plain copy — or `null` for a plain copy. */
  readonly note: string | null;
}

/** One unit file the plan would install. */
export interface Unit {
  readonly name: string;
  readonly path: string;
  readonly text: string;
  /** Started with `enable --now`. The oneshot a timer starts is not. */
  readonly enable: boolean;
}

/** A long-running (or timed) piece of the agent there. */
export interface Service {
  readonly name: string;
  readonly what: string;
  readonly exec: readonly string[];
  /** Where it listens there, in words — `null` for what opens no port. */
  readonly listens: string | null;
  readonly units: readonly Unit[];
}

export type GateId = "encrypted-disk" | "erase-reaches-remote" | "no-public-port" | "typed-phrase";

/** One of D-100's four conditions, as `apply` will hold this provider to it. */
export interface Gate {
  readonly id: GateId;
  /** D-100's condition, in its own words. */
  readonly condition: string;
  readonly canBeMet: boolean;
  readonly how: string;
  /** Stories that have to land before `apply` can meet it. */
  readonly waitsOn: readonly string[];
}

/** Everything a plan says. The same object is `--json`'s document. */
export interface DeployPlan {
  readonly schema: string;
  readonly at: string;
  readonly engine: string;
  readonly subject: SubjectId;
  readonly agentDir: string;
  readonly target: Target;
  readonly defaulted: readonly string[];
  readonly remote: RemoteLayout;
  /** The phrase `apply` will ask for at a terminal before its first command (D-100 #4). */
  readonly phrase: string;
  /** Where the keys would be kept — on this machine, never there. The disk key is GCP's CSEK. */
  readonly keys: { readonly volume: string; readonly disk: string };
  readonly goes: readonly PlanEntry[];
  readonly rebuilt: readonly PlanEntry[];
  readonly stays: readonly PlanEntry[];
  /** What is not in the data map, and does not go either. */
  readonly notGoing: readonly string[];
  readonly services: readonly Service[];
  readonly gates: readonly Gate[];
  readonly steps: readonly Step[];
  readonly placeholders: readonly Placeholder[];
  /** What would land on the encrypted volume: the repository and every copied place. */
  readonly totals: { readonly files: number; readonly bytes: number };
  /** Non-empty: `apply` would refuse, and the command exits 1. */
  readonly refusals: readonly string[];
  readonly notes: readonly string[];
  readonly limits: readonly string[];
}

/** What a plan is made from. Everything about this machine arrives here; nothing is read from the process. */
export interface DeployInput {
  readonly target: Target;
  readonly defaulted: readonly string[];
  /** Absolute. */
  readonly agentDir: string;
  readonly subject: SubjectId;
  /** This engine's version: the binary that would go is the same one. */
  readonly engine: string;
  /** This machine's roots. */
  readonly local: MapEnv;
  readonly now: () => Date;
}

/** The phrase the first `apply` waits for. Names the subject and the machine, so a habit cannot carry. */
export function deployPhrase(subject: SubjectId, name: string): string {
  return `deploy ${subject} to ${name}`;
}

/**
 * What this plan does not check — printed on every run, carried in the JSON.
 *
 * The person reading a clean plan is exactly the person about to believe it
 * covers more than it does.
 */
export const DEPLOY_LIMITS: readonly string[] = [
  "nothing here has touched the target. Whether the host answers, whether the account may create " +
    "a machine, whether the zone or region has that type, what the VPS already runs and listens on, " +
    "whether sudo works there — `apply` finds out, and this does not.",
  "the commands are what this version would run. None has been run against a real provider: " +
    "S13.2–S13.4 build them and measure them, and may change them. A value in braces exists only " +
    "at apply time; the list under the commands says where each one comes from.",
  "sizes are what is on this disk now, read with lstat. What a clone carries is counted as the " +
    "working tree and .git/ — this runs no git, so it cannot tell committed from uncommitted, and a " +
    "clone carries only what is committed.",
  "the data map is erase's own list (S7.1). What it does not name — the vendors' transcripts, shell " +
    "history, files elsewhere in your home — deploy does not carry, and this plan cannot see whether " +
    "the agent there would miss any of it.",
  "disk encryption protects what is at rest. A provider that runs the machine can read the memory " +
    "of a running one, and while the volume is open there, what is on it is in that memory. No " +
    "setting here changes that.",
  "`home` is checked for shape — a tailnet name or address — and not asked. Whether that machine " +
    "answers, and whether a turn there could reach its model, is S13.6's to measure.",
  "this command starts nothing — no ssh, gcloud, aws, git or tar — opens no socket, and skips the " +
    "daily update check (D-065), so no request leaves this machine while it runs.",
];

/** What does not go, and is not in the data map for erase to name either. */
function notGoing(target: Target, layout: RemoteLayout): string[] {
  return [
    "vendor CLI logins — ~/.claude, ~/.codex and the rest stay here. A subscription login is one " +
      "person's, not a server's (D-109); S13.7 brings API-key backends whose keys live on the " +
      "encrypted volume there.",
    "local models — ollama, vLLM and LiteLLM stay on this machine; a VPS has no GPU (D-100). S13.6 " +
      `would call the model at home over the tailnet${target.home === null ? "" : ` (${target.home})`}.`,
    "the brake and the dial's ceiling — `STOP` under the state root and the ceiling variable are " +
      "this machine's. The remote starts with no brake set, and `mind stop` has to be run there too.",
    `the page's link key here — the page there makes its own, on the volume (${layout.webKey}).`,
    "anything outside the data map — the vendors' transcripts, shell history, files elsewhere in " +
      "your home. The data map is erase's list (S7.1); what it does not name, deploy does not carry.",
  ];
}

/** The two services: the page, and the triggers timer. */
export function servicesFor(layout: RemoteLayout, subject: SubjectId): Service[] {
  const environment = [
    `Environment=HOME=${layout.home}`,
    `Environment=XDG_STATE_HOME=${layout.stateHome}`,
    `Environment=XDG_DATA_HOME=${layout.dataHome}`,
  ].join("\n");
  // Not started on a locked volume: until it is opened (by hand, or by S13.8),
  // the services are skipped rather than run against an empty mount point.
  const locked = `ConditionPathIsMountPoint=${layout.volume}`;

  const webExec = [
    layout.binary, "web", layout.agentDir, "--subject", subject,
    "--host", "127.0.0.1", "--port", String(REMOTE_WEB_PORT), "--https", "--key-file", layout.webKey,
  ];
  const tickExec = [layout.binary, "triggers", "tick", `${layout.agentDir}/${SOUL_DIR}`, "--subject", subject];
  const web = `mind-web-${subject}`;
  const triggers = `mind-triggers-${subject}`;

  return [
    {
      name: "web",
      what: "the page — what it may do, what waits for your yes or no, the chat, the brake",
      exec: webExec,
      listens: `127.0.0.1:${REMOTE_WEB_PORT} only; the tailnet reaches it through \`tailscale serve\`, nothing else does`,
      units: [
        {
          name: `${web}.service`,
          path: `/etc/systemd/system/${web}.service`,
          enable: true,
          text:
            `[Unit]\nDescription=mind web for ${subject} (loopback, tailnet through tailscale serve)\n` +
            `After=network-online.target tailscaled.service\nWants=network-online.target\n${locked}\n\n` +
            `[Service]\nUser=${layout.user}\n${environment}\nExecStart=${webExec.join(" ")}\nRestart=on-failure\n\n` +
            `[Install]\nWantedBy=multi-user.target\n`,
        },
      ],
    },
    {
      name: "triggers",
      what: `the schedules in triggers.md, every ${TRIGGER_EVERY_MIN} min — each a turn held at level 1: it proposes, never acts`,
      exec: tickExec,
      listens: null,
      units: [
        {
          name: `${triggers}.service`,
          path: `/etc/systemd/system/${triggers}.service`,
          enable: false,
          text:
            `[Unit]\nDescription=mind triggers for ${subject}\n${locked}\n\n` +
            `[Service]\nType=oneshot\nUser=${layout.user}\n${environment}\nExecStart=${tickExec.join(" ")}\n`,
        },
        {
          name: `${triggers}.timer`,
          path: `/etc/systemd/system/${triggers}.timer`,
          enable: true,
          text:
            `[Unit]\nDescription=mind triggers for ${subject}\n\n` +
            `[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${TRIGGER_EVERY_MIN}min\n\n[Install]\nWantedBy=timers.target\n`,
        },
      ],
    },
  ];
}

/** The story that builds `apply` for this provider. */
function applyStory(target: Target): string {
  return target.provider === "ssh" ? "S13.2" : target.provider === "gcp" ? "S13.3" : "S13.4";
}

/** D-100's four conditions, for this provider. */
export function gatesFor(target: Target, subject: SubjectId): Gate[] {
  const apply = applyStory(target);
  const luks =
    "a LUKS2 volume opened with a key made on this machine and handed over on stdin; the key is never " +
    "written there, so nothing there can open the volume alone (D-111). Until S13.8 unlocks it from " +
    "home over the tailnet, it is opened by hand after every boot";
  const disk: Record<Target["provider"], string> = {
    ssh: `${luks}. A container file on the VPS holds it, so the provider sees ciphertext at rest.`,
    gcp:
      `${luks}, on a separate data disk — that is the part that meets the condition. The disk is also ` +
      "created with a customer-supplied key (CSEK), which Google does not keep, so a snapshot of it is " +
      "unreadable without that key; it has to be supplied again each time the VM starts. CMEK alone " +
      "would not meet the condition: its key lives in Cloud KMS, which is Google's place.",
    aws:
      `${luks}, on a separate EBS volume — that is the part that meets the condition. EBS also ` +
      "encrypts the volume under a KMS key this deploy creates in your account; that alone would not " +
      "meet it, because the key lives in AWS KMS, which is AWS's place.",
  };
  const ssh: Record<Target["provider"], string> = {
    ssh: "sshd, which a VPS already runs; whatever else listens there is not Mind's and is not changed",
    gcp: "sshd, through the default network's default-allow-ssh rule; no firewall rule is added",
    aws: "sshd, through a security group that allows tcp/22 from your own address and nothing else, closed again once the tailnet is up",
  };
  const destroy: Record<Target["provider"], string> = {
    ssh:
      "The VPS itself is rented at Hostinger and only you can end it there; S13.5 can close the volume " +
      "and throw away its key, which leaves what is on it unreadable.",
    gcp: "The data disk is created with auto-delete off, so S13.5's destroy deletes it by name and asks again.",
    aws: "The EBS volume is created with delete-on-termination off, so S13.5's destroy deletes it by id and asks again.",
  };

  return [
    {
      id: "encrypted-disk",
      condition: "the agent's disk there is encrypted, and the key is not in the provider's place (D-100 #1)",
      canBeMet: true,
      how: disk[target.provider],
      waitsOn: [apply, "S13.8"],
    },
    {
      id: "erase-reaches-remote",
      condition: "`erase` can delete there and measure it; the data map includes the remote (D-100 #2)",
      canBeMet: true,
      how:
        "every path there is erase's own resolver evaluated with the remote's roots, and `mind erase " +
        `${subject} --remote <target.json> --yes\` removes them over ssh, remote half first, asks the machine ` +
        "again and prints what it could not reach (provider snapshots, backups, copies the host holds). " +
        "Implemented with a fake runner; real runner not wired (spawn guard, owner decision) — a connected " +
        "ssh runner comes with `apply`, and one dry run on a real throwaway machine is the owner's. " +
        destroy[target.provider],
      waitsOn: [`${apply}: a real ssh runner (spawn guard, owner decision)`, "the owner's dry run on a real machine"],
    },
    {
      id: "no-public-port",
      condition: "the machines talk over the tailnet or ssh, with no public port by default (D-100 #3)",
      canBeMet: true,
      how:
        `the page binds 127.0.0.1:${REMOTE_WEB_PORT} and reaches the tailnet only through \`tailscale serve\`; ` +
        `the triggers open no port. The one public listener this relies on is ${ssh[target.provider]}. ` +
        "`ss -ltnp` after the install checks it (S13.2 AC2).",
      waitsOn: [apply],
    },
    {
      id: "typed-phrase",
      condition: "the first deploy waits for a phrase typed at a terminal, the way consent does (D-100 #4)",
      canBeMet: true,
      how:
        `\`deploy apply\` asks for "${deployPhrase(subject, target.name)}" at a terminal before its first ` +
        "command, with no --yes. This plan asks for nothing.",
      waitsOn: [apply],
    },
  ];
}

/** A tree of the data map, sized, with its place there. */
async function entryFor(tree: MapTree, there: MapTree | undefined): Promise<PlanEntry> {
  const size = await measure(tree.dir);
  const travel = tree.travel;
  const note =
    travel.kind === "copied"
      ? null
      : travel.kind === "in-git"
        ? "inside the repository above — carried by the clone and counted there, not again"
        : travel.kind === "rebuilt"
          ? travel.how
          : travel.why;
  return {
    key: tree.key,
    place: tree.place,
    travel: travel.kind,
    label: tree.label,
    here: tree.dir,
    there: travel.kind === "stays" ? null : (there?.dir ?? null),
    size,
    encrypted: travel.kind !== "stays",
    note,
  };
}

/** The binary and the repository: the two things that go and are not a data-map place. */
async function engineAndRepo(input: DeployInput, layout: RemoteLayout): Promise<PlanEntry[]> {
  const asset = binaryAsset(input.target.arch);
  return [
    {
      key: "binary",
      place: null,
      travel: "engine",
      label: `${asset} ${input.engine}`,
      here: null,
      there: layout.binary,
      size: null,
      encrypted: false,
      note:
        `the release asset from github.com/${RELEASE_REPO}, checked against its SHA256SUMS before it is ` +
        "sent — the check `mind update --yes` makes. Not personal: it goes on the boot disk.",
    },
    {
      key: "repo",
      place: null,
      travel: "clone",
      label: "the agent's repository — its working tree, without .git/ and .mind/",
      here: input.agentDir,
      there: layout.agentDir,
      size: await measure(input.agentDir, [".git", DERIVED_DIR]),
      encrypted: true,
      note:
        "as a git bundle of every branch, cloned there with no remote (D-013): soul/, memory/, actions/ " +
        "and consent/ go this way. What is committed goes; uncommitted changes and untracked files do not.",
    },
    {
      key: "repo-history",
      place: null,
      travel: "clone",
      label: "its history (.git/)",
      here: join(input.agentDir, ".git"),
      there: `${layout.agentDir}/.git`,
      size: await measure(join(input.agentDir, ".git")),
      encrypted: true,
      note: "every committed version goes with it, which is what `git log -p` there will print.",
    },
  ];
}

/** Why `apply` would stop before its first command, from what this disk says. */
async function refusalsFor(input: DeployInput): Promise<{ refusals: string[]; notes: string[] }> {
  const refusals: string[] = [];
  const notes: string[] = [];
  const personal = await personalDir(input.local, input.subject);
  if (!personal.ok) refusals.push(`the personal directory cannot be resolved: ${personal.reason}`);

  const repo = await repoState(input.agentDir);
  if (repo === "not-a-repo") {
    refusals.push(
      `${input.agentDir} is not a git repository. An agent is one (D-013), and a clone is how it would ` +
        "go — `mind new` makes one.",
    );
  } else if (repo === "no-commits") {
    refusals.push(
      `${input.agentDir} has no commit yet, so a clone would carry nothing. Commit what should go — ` +
        "Mind never commits for you (D-013, S0.4 AC2).",
    );
  } else if (repo === "unknown") {
    notes.push(
      `whether ${input.agentDir} has a commit could not be read from .git/ without running git (a worktree, ` +
        "a submodule, or a HEAD this does not recognise). `apply` will find out when it bundles it.",
    );
  }
  return { refusals, notes };
}

/** What a reader is owed about this particular plan. */
function notesFor(input: DeployInput, entries: readonly PlanEntry[]): string[] {
  const notes: string[] = [];
  const target = input.target;
  if (target.home === null) {
    notes.push(
      "no `home` in the target file: the agent there has no local model to call (a VPS has no GPU, " +
        "D-100), so pieces of memory held from the cloud (D-095) cannot be acted on there.",
    );
  } else {
    notes.push(
      `home is ${target.home}: S13.6 would reach the model there over the tailnet. The fence lets a local ` +
        "turn connect only to 127.0.0.1 on LiteLLM's port (D-118, D-124), so S13.6 has to bring that " +
        `model to a loopback port there rather than point a turn at ${target.home}.`,
    );
  }
  notes.push(
    "until S13.7 (your own API keys) or S13.6 (the model at home) lands, a turn there has no backend: " +
      "vendor logins do not go and the machine has no model, unless you install one there yourself. " +
      "The page and the triggers run; each turn they start fails with no backend reached.",
  );
  notes.push(
    "if this machine keeps running `web`, `chat serve` or the triggers timer for this subject, both " +
      "machines act for it — two pages, two timers, two answers. Stop them here once there answers.",
  );
  if (target.provider === "ssh") {
    notes.push(
      `the volume there is a ${DEFAULT_CONTAINER_GB} GB container file: the target file has no size for ssh ` +
        "(S13.2 decides whether it takes one).",
    );
  }
  const links = entries.reduce((total, entry) => total + (entry.size?.symlinks ?? 0), 0);
  if (links > 0) {
    notes.push(`${links} symlink(s) in what goes would go as links; what they point at does not go.`);
  }
  if (input.defaulted.length > 0) {
    notes.push(`not in the target file, so defaulted: ${input.defaulted.join(", ")}.`);
  }
  return notes;
}

/**
 * Make the plan. Reads sizes; writes nothing, sends nothing, starts nothing.
 */
export async function planDeploy(input: DeployInput): Promise<DeployPlan> {
  const { target, subject } = input;
  const layout = remoteLayout(subject);
  const here = dataMap(input.local, subject, input.agentDir);
  const there = dataMap(remoteEnv(layout), subject, layout.agentDir);
  const thereByKey = new Map([...there.trees, there.ledger].map((tree) => [tree.key, tree]));

  const goes: PlanEntry[] = await engineAndRepo(input, layout);
  const rebuilt: PlanEntry[] = [];
  const stays: PlanEntry[] = [];
  const route = { "in-git": goes, copied: goes, rebuilt, stays } as const;
  for (const tree of [...here.trees, here.ledger]) {
    route[tree.travel.kind].push(await entryFor(tree, thereByKey.get(tree.key)));
  }
  rebuilt.push({
    key: "collection",
    place: here.collection.place,
    travel: here.collection.travel.kind,
    label: `the vector collection ${here.collection.name} (in Qdrant, not on this disk)`,
    here: null,
    there: null,
    size: null,
    encrypted: true,
    note: here.collection.travel.kind === "rebuilt" ? here.collection.travel.how : null,
  });
  stays.push({
    key: "blocks",
    place: here.blocks.place,
    travel: here.blocks.travel.kind,
    label: here.blocks.label,
    here: null,
    there: null,
    size: null,
    encrypted: false,
    note: here.blocks.travel.kind === "stays" ? here.blocks.travel.why : null,
  });

  // What lands on the volume: the clone and the copies. The soul is inside the
  // clone, and the binary is not anybody's data.
  const onVolume = goes.filter((entry) => entry.travel === "clone" || entry.travel === "copied");
  const totals = onVolume.reduce(
    (sum, entry) => ({ files: sum.files + (entry.size?.files ?? 0), bytes: sum.bytes + (entry.size?.bytes ?? 0) }),
    { files: 0, bytes: 0 },
  );

  const checked = await refusalsFor(input);
  const services = servicesFor(layout, subject);
  const keysIn = join(stateRoot(input.local.home, input.local.env), "deploy", target.name);
  const keys = { volume: join(keysIn, "volume.key"), disk: join(keysIn, "csek.json") };
  const commands = commandsFor({
    target,
    subject,
    agentDir: input.agentDir,
    layout,
    // Only what the map says is copied, and only what has something in it:
    // an empty place gets no command, and the engine there makes it when it
    // first needs it.
    copies: goes.flatMap((entry) =>
      entry.travel === "copied" && entry.here !== null && entry.there !== null &&
      (entry.size?.files ?? 0) + (entry.size?.symlinks ?? 0) > 0
        ? [{ label: entry.label, here: entry.here, there: entry.there }]
        : [],
    ),
    units: services.flatMap((service) => service.units),
    webPort: REMOTE_WEB_PORT,
    keys,
    containerGb: DEFAULT_CONTAINER_GB,
  });

  return {
    schema: DEPLOY_PLAN_SCHEMA,
    at: input.now().toISOString(),
    engine: input.engine,
    subject,
    agentDir: input.agentDir,
    target,
    defaulted: input.defaulted,
    remote: layout,
    phrase: deployPhrase(subject, target.name),
    keys,
    goes,
    rebuilt,
    stays,
    notGoing: notGoing(target, layout),
    services,
    gates: gatesFor(target, subject),
    steps: commands.steps,
    placeholders: commands.placeholders,
    totals,
    refusals: checked.refusals,
    notes: [...checked.notes, ...notesFor(input, [...goes, ...rebuilt])],
    limits: DEPLOY_LIMITS,
  };
}
