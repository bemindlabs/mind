/**
 * One synthetic agent, and data of its subject in every kind of place the data
 * map names — so a deploy plan has something real to measure.
 *
 * Built on `synthetic-soul.ts`'s identity A (D-021: every fixture is synthetic).
 * The repository's `.git/` is written by hand — a HEAD, a ref, nothing else —
 * because `deploy plan` reads exactly those two files to decide whether there
 * is a commit to clone, and a test of *that* must not depend on a `git` binary
 * being on the machine running it. Tests that need a real commit make one.
 *
 * Every byte lands under the directory the caller passes, which is always a
 * `mkdtemp` in a test.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SOUL_A, writeSoul } from "./synthetic-soul.ts";

/** How much of a repository `.git/` holds. */
export type Commits = "committed" | "no-commits" | "no-git";

export interface SyntheticAgent {
  readonly subject: string;
  readonly agentDir: string;
  readonly home: string;
  readonly env: { readonly XDG_STATE_HOME: string; readonly XDG_DATA_HOME: string };
  /** Bytes written into each place, by data-map key — what `measure` must find. */
  readonly written: Readonly<Record<string, { readonly files: number; readonly bytes: number }>>;
}

/** A 40-hex id nobody computed from anything: `.git/` is fabricated, not made by git. */
export const FAKE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function put(path: string, text: string): Promise<number> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Write the agent and its subject's data under `root`.
 *
 * Places filled: the ledger, the run records, the apply backups, the level-3
 * confirmations, the A2A peers, the rag marker, the personal directory (with
 * one symlink), and `.mind/`. Left empty on purpose: chat, push, basis, the
 * trigger times — a plan must print them and give them no copy command.
 */
export async function writeSyntheticAgent(root: string, commits: Commits = "committed"): Promise<SyntheticAgent> {
  const subject = SOUL_A.subject;
  const home = join(root, "home");
  const env = { XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") };
  const state = join(env.XDG_STATE_HOME, "mind");
  const data = join(env.XDG_DATA_HOME, "mind");

  const agentDir = join(root, "agents", "alpha");
  await writeSoul(agentDir, SOUL_A, "soul");
  await put(join(agentDir, "memory", "shelves.md"), "# shelves\n\nThe west shelf holds the ledgers.\n");
  await put(join(agentDir, ".gitignore"), "/.mind/\n");
  await put(join(agentDir, ".mind", "index", "fts.db"), "derived bytes\n");

  if (commits !== "no-git") {
    await put(join(agentDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(agentDir, ".git", "refs", "heads"), { recursive: true });
    if (commits === "committed") await put(join(agentDir, ".git", "refs", "heads", "main"), `${FAKE_COMMIT}\n`);
  }

  const written: Record<string, { files: number; bytes: number }> = {};
  const fill = async (key: string, files: readonly (readonly [string, string])[]) => {
    let bytes = 0;
    for (const [path, text] of files) bytes += await put(path, text);
    written[key] = { files: files.length, bytes };
  };

  await fill("ledger", [[join(state, "ledger", subject, "2026-09.jsonl"), '{"turn":1}\n{"turn":2}\n']]);
  await fill("runs", [[join(state, "runs", subject, "run.json"), '{"pid":4812}\n']]);
  await fill("backups", [[join(state, "backups", subject, "manifest.json"), '{"files":[]}\n']]);
  await fill("confirmations", [[join(state, "dial", subject, "confirmed.json"), '{"write":{"by":"x"}}\n']]);
  await fill("a2a", [[join(state, "a2a", subject, "peers.json"), '{"peers":[]}\n']]);
  await fill("rag-marker", [[join(state, "rag", subject, "collection.json"), '{"qdrantUrl":"http://127.0.0.1:1"}\n']]);
  await fill("personal", [
    [join(data, subject, "personal", "proposals", "p1.json"), '{"what":"tidy the shelves"}\n'],
    [join(data, subject, "personal", "observer", "capture.jsonl"), '{"kind":"edit"}\n'],
  ]);
  await symlink("/nonexistent/elsewhere", join(data, subject, "personal", "a-link"));

  return { subject, agentDir, home, env, written };
}

/** A target file's text for a VPS at a documentation address (RFC 5737). */
export function sshTarget(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "vps-1", provider: "ssh", ssh: { host: "203.0.113.10", user: "deploy" }, ...extra });
}
