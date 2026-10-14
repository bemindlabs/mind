/**
 * `erase --remote`, step 5 — what the remote half says it did, and what it did not reach (S13.5 AC2, D-100 #2).
 *
 * The local certificate prints `NOT_SEARCHED` on every run because a clean
 * result read without it is taken as "gone", and some of those places are
 * where the data demonstrably still is. The remote has its own list, and the
 * largest entries are the ones the owner cannot touch from here: copies the
 * host itself keeps. They are named in every remote certificate, whatever the
 * verdict, including a verified one.
 *
 * Pure. It reads nothing and sends nothing; it turns the remote erasure and
 * its verdict into a record in the shape of the local certificate.
 */

import type { SubjectId } from "../types.ts";
import type { RemoteErasePlan } from "./remote.ts";
import { remoteTrees } from "./remote.ts";
import type { RemoteErasure, RemoteVerdict } from "./remote-verify.ts";

export const REMOTE_CERTIFICATE_SCHEMA = "mind/erase-remote-certificate@1";

/** What the remote half asked the machine. */
export const REMOTE_SEARCHED: readonly string[] = [
  "each directory the data map names for this subject, with the remote's roots: asked by name, " +
    "before and after the delete, over ssh.",
];

/**
 * What the remote half does not reach, and therefore does not certify.
 *
 * Printed on every remote run and carried in the JSON. The first three are
 * held by somebody other than the owner's own account on the machine.
 */
export const REMOTE_NOT_SEARCHED: readonly string[] = [
  "provider snapshots and images. A snapshot of the disk or the machine, taken by the owner in the " +
    "provider's panel or by the provider, holds the data as it was then; deleting the directories " +
    "does not change it, and this run cannot list one.",
  "provider backups. Automatic or scheduled backups of the machine are kept by the provider, " +
    "outside the machine, and are not read, listed or deleted here.",
  "copies the host holds. Whatever the company that runs the machine keeps — Hostinger, for a " +
    "Hostinger VPS — in its storage layers, logs and support systems is outside the machine and " +
    "outside this run. Ask the host to delete the machine, its snapshots and its backups if the " +
    "subject must leave there too.",
  "freed blocks. The directories are removed from the encrypted volume's file system; the bytes " +
    "stay in the container file on the host's disk until they are overwritten, and are readable " +
    "only with the volume's key.",
  "the machine outside the data map: shell history, the process list, system logs and any file " +
    "somebody copied out of the volume by hand. Nothing here reads a file's contents on the remote; " +
    "it asks whether each named directory is there.",
  "clones and remotes of the agent repository, anywhere, and this machine's own half — that is the " +
    "local certificate's.",
];

export interface RemoteCertificateDirectory {
  readonly label: string;
  readonly dir: string;
  /** What the second look saw: `not there`, `there` or `unknown` (the machine could not be asked). */
  readonly after: "not there" | "there" | "unknown";
}

export interface RemoteCertificate {
  readonly schema: typeof REMOTE_CERTIFICATE_SCHEMA;
  readonly verdict: RemoteVerdict["verdict"];
  readonly statement: string;
  readonly subject: SubjectId;
  readonly machine: string;
  readonly issuedAt: string;
  readonly engine: string;
  readonly by: { readonly claimed: string; readonly observed: string; readonly note: string };
  readonly directories: readonly RemoteCertificateDirectory[];
  readonly searched: readonly string[];
  readonly notSearched: readonly string[];
}

export interface RemoteCertificateInput {
  readonly plan: RemoteErasePlan;
  readonly erasure: RemoteErasure;
  readonly by: string;
  readonly observedAccount: string;
  readonly engine: string;
  readonly issuedAt: string;
}

function statementFor(plan: RemoteErasePlan, verdict: RemoteVerdict): string {
  switch (verdict.verdict) {
    case "erased-and-verified":
      return (
        `On ${plan.machine}, every directory of ${plan.subject}'s data map was removed and the machine, ` +
        "asked again, said none is there. That is the whole claim: see notSearched for what it does not cover."
      );
    case "remaining":
      return `On ${plan.machine}, ${verdict.left.length} director${verdict.left.length === 1 ? "y is" : "ies are"} still there after the delete. The subject is not erased there.`;
    case "not-verified":
      return (
        `${plan.machine} could not be asked after the delete, so nothing is claimed about what is there. ` +
        `This is not an erasure certificate. ${verdict.reason}`
      );
  }
}

/** Build the remote certificate. */
export function remoteCertificate(input: RemoteCertificateInput): RemoteCertificate {
  const { erasure } = input;
  const plan = erasure.plan ?? input.plan;
  const verdict = erasure.verdict;
  const left = new Set(verdict.verdict === "remaining" ? verdict.left.map((tree) => tree.dir) : []);
  return {
    schema: REMOTE_CERTIFICATE_SCHEMA,
    verdict: verdict.verdict,
    statement: statementFor(plan, verdict),
    subject: plan.subject,
    machine: plan.machine,
    issuedAt: input.issuedAt,
    engine: input.engine,
    by: {
      claimed: input.by,
      observed: input.observedAccount,
      note:
        "mind authenticates neither. `claimed` is the text passed to --by; `observed` is the OS account " +
        "this process ran as. Nothing here is evidence that a particular person asked for this.",
    },
    directories: remoteTrees(plan).map(({ label, dir }) => ({
      label,
      dir,
      after:
        verdict.verdict === "not-verified" ? "unknown" : left.has(dir) ? "there" : "not there",
    })),
    searched: REMOTE_SEARCHED,
    notSearched: REMOTE_NOT_SEARCHED,
  };
}

/** The lines a person reads. The not-searched list is last, and is printed whatever the verdict. */
export function formatRemoteCertificate(cert: RemoteCertificate): readonly string[] {
  return [
    `remote erase certificate — ${cert.verdict}`,
    cert.statement,
    "",
    ...cert.directories.map((entry) => `  ${entry.after.padEnd(9)} ${entry.label} — ${entry.dir}`),
    "",
    "What this asked:",
    ...cert.searched.map((note) => `  - ${note}`),
    "What it does not search, and therefore does not certify:",
    ...cert.notSearched.map((note) => `  - ${note}`),
  ];
}
