/**
 * `mind update` — is there a newer release, and which file is ours (D-065).
 *
 * Pure: versions, the release list GitHub returns, the asset for this machine,
 * and when an automatic check is due. The network and the file swap are in
 * `install.ts`; the command decides when either happens.
 *
 * Releases come from the public repository — the one a person without access
 * to the development history installs from.
 */

import { readMind } from "../env.ts";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The prefix of every release asset: `mind-linux-x64`. */
const ASSET_PREFIX = "mind-";

export const RELEASE_REPO = "bemindlabs/mind";
export const RELEASES_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=20`;
export const NO_CHECK_ENV = "MIND_NO_UPDATE_CHECK";
/** One automatic check a day, at most. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHECK_FILE = "update-check.json";

export interface Version {
  readonly core: readonly [number, number, number];
  /** `alpha` in `0.3.0-alpha`; empty for a release. */
  readonly pre: string;
  readonly text: string;
}

/** `v0.3.0-alpha`, `0.3.0` → a version, or `undefined`. */
export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (m === null) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "", text: text.trim().replace(/^v/, "") };
}

/** Semver order, prerelease below its release: 0.3.0-alpha < 0.3.0 < 0.3.1. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return a.pre < b.pre ? -1 : 1;
}

export interface Release {
  readonly tag: string;
  readonly version: Version;
  readonly prerelease: boolean;
  readonly url: string;
  readonly assets: ReadonlyMap<string, string>;
}

/** The newest usable release in GitHub's list: not a draft, with a version tag. */
export function latestRelease(body: unknown): Release | undefined {
  if (!Array.isArray(body)) return undefined;
  let best: Release | undefined;
  for (const r of body as Record<string, unknown>[]) {
    if (r["draft"] === true || typeof r["tag_name"] !== "string") continue;
    const version = parseVersion(r["tag_name"]);
    if (version === undefined) continue;
    const assets = new Map<string, string>();
    for (const a of (Array.isArray(r["assets"]) ? r["assets"] : []) as Record<string, unknown>[]) {
      if (typeof a["name"] === "string" && typeof a["browser_download_url"] === "string") assets.set(a["name"], a["browser_download_url"]);
    }
    const release = { tag: r["tag_name"], version, prerelease: r["prerelease"] === true, url: typeof r["html_url"] === "string" ? r["html_url"] : "", assets };
    if (best === undefined || compareVersions(version, best.version) > 0) best = release;
  }
  return best;
}

/** The asset built for this machine, `mind-<os>-<arch>`, or `undefined` when there is no build for it. */
export function assetFor(platform: string, arch: string): string | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  return os === undefined || cpu === undefined ? undefined : `${ASSET_PREFIX}${os}-${cpu}`;
}

/** The sha256 SHA256SUMS lists for a file, or `undefined`. */
export function sumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m !== null && m[2] === name) return m[1];
  }
  return undefined;
}

/** What the last automatic check found, kept so the next command need not ask. */
export interface CheckRecord {
  readonly at: string;
  readonly latest: string | null;
}

export async function readCheck(stateDir: string): Promise<CheckRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, CHECK_FILE), "utf8")) as CheckRecord;
    return typeof raw.at === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCheck(stateDir: string, record: CheckRecord): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, CHECK_FILE);
  await writeFile(`${path}.${process.pid}`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(`${path}.${process.pid}`, path);
}

/**
 * Whether this run may check by itself. Never when told not to, never when
 * nobody is at a terminal to read the line (hooks, pipes, CI), never for the
 * commands whose output a program reads, and at most once a day. Never after
 * `deploy` either: `deploy plan` says no request leaves this machine while it
 * runs, and a check after it would make that false once a day (S13.1).
 */
export function autoCheckDue(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly interactive: boolean;
  readonly verb: string | undefined;
  readonly argv: readonly string[];
  readonly last: CheckRecord | undefined;
  readonly now: Date;
}): boolean {
  const v = readMind(NO_CHECK_ENV, options.env);
  if (v !== undefined && v !== "" && v !== "0") return false;
  if (options.env["CI"] !== undefined && options.env["CI"] !== "") return false;
  if (!options.interactive) return false;
  if (options.verb === undefined || ["update", "version", "--version", "-v", "observe", "a2a", "web", "deploy"].includes(options.verb)) return false;
  if (options.argv.includes("--json")) return false;
  if (options.last === undefined) return true;
  const at = Date.parse(options.last.at);
  return Number.isNaN(at) || options.now.getTime() - at >= CHECK_EVERY_MS;
}

/** The one line a newer release earns, or `undefined`. */
export function newerLine(current: string, latest: string | null): string | undefined {
  if (latest === null) return undefined;
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (a === undefined || b === undefined || compareVersions(b, a) <= 0) return undefined;
  return `mind ${b.text} is available (you have ${a.text}) — \`mind update\` shows what it would do. ${NO_CHECK_ENV}=1 stops this check.`;
}
