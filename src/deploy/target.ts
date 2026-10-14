/**
 * S13.1 — the target file: where `mind deploy` would put an agent (E13, D-100).
 *
 * One JSON file, no new dependency, and strict in the ways that matter before
 * anything is run against a machine somebody pays for:
 *
 * - **Unknown fields are refused**, at every level. A misspelt `machinetype`
 *   that quietly fell back to a default would deploy a machine nobody chose.
 * - **The provider block must match the provider.** A `gcp` block in an `ssh`
 *   target is two answers to one question, and the rule every other command
 *   here follows is to refuse rather than pick one.
 * - **No secrets.** A field whose *name* says key, password, token or secret is
 *   refused with its own reason, and the raw bytes go through the repo guard's
 *   scanner (`scanStaged`) so a key pasted into a legitimate field is caught by
 *   the same rules that stop it entering git. Neither path echoes the value.
 *   Keys belong on the encrypted volume (S13.7) or on the machine that unlocks
 *   it (D-111) — never in a file that describes where things go.
 * - **Hostnames are validated**, not just "a string": a `host` of
 *   `-oProxyCommand=…` would be an option to `ssh`, and `user@host` in `host`
 *   is the user in the wrong field.
 *
 * Pure: {@link parseTarget} takes the text and returns a value or every
 * problem, in field order. Reading the file is the caller's.
 */

import { scanStaged } from "../guard/scan.ts";

/** The three ways `deploy` borrows hands (D-002): the CLIs the owner already has. */
export type Provider = "ssh" | "gcp" | "aws";
export const PROVIDERS: readonly Provider[] = ["ssh", "gcp", "aws"];

/** The CPU of the machine there. The release builds a Linux binary for each. */
export type Arch = "x64" | "arm64";
export const ARCHES: readonly Arch[] = ["x64", "arm64"];

/** A VPS you already rent, reached with `ssh` (S13.2 — Hostinger). */
export interface SshBlock {
  readonly host: string;
  readonly user: string;
  readonly port: number;
}

/** A VM `gcloud` creates (S13.3). */
export interface GcpBlock {
  readonly project: string;
  readonly zone: string;
  readonly machineType: string;
  readonly diskGb: number;
}

/** An instance `aws` creates (S13.4). */
export interface AwsBlock {
  readonly region: string;
  readonly instanceType: string;
  readonly diskGb: number;
}

interface Common {
  /** The machine's name: the VM, its tailnet host name, and the label on everything made for it. */
  readonly name: string;
  readonly arch: Arch;
  /** The owner's machine on the tailnet, where the local model is (S13.6). `null` when not given. */
  readonly home: string | null;
}

/** A target with every default filled in. {@link TargetParse} says which were. */
export type Target =
  | (Common & { readonly provider: "ssh"; readonly ssh: SshBlock })
  | (Common & { readonly provider: "gcp"; readonly gcp: GcpBlock })
  | (Common & { readonly provider: "aws"; readonly aws: AwsBlock });

/** One reason the file cannot be a target. Never carries a value that might be a secret. */
export interface TargetProblem {
  /** Dotted path of the field, or `(file)` for the file as a whole. */
  readonly field: string;
  readonly problem: string;
}

export type TargetParse =
  | {
      readonly ok: true;
      readonly target: Target;
      /** Dotted paths of the fields that were absent and took a default. */
      readonly defaulted: readonly string[];
    }
  | { readonly ok: false; readonly problems: readonly TargetProblem[] };

/** Disk for the agent's encrypted volume when the file does not say. */
export const DEFAULT_DISK_GB = 20;
export const MIN_DISK_GB = 10;
export const MAX_DISK_GB = 4096;
export const DEFAULT_SSH_PORT = 22;

/** Small, because the agent borrows its hands (D-002) — the work happens in the backends it calls. */
export const DEFAULT_MACHINE_TYPE: Readonly<Record<Arch, string>> = { x64: "e2-small", arm64: "t2a-standard-1" };
export const DEFAULT_INSTANCE_TYPE: Readonly<Record<Arch, string>> = { x64: "t3.small", arm64: "t4g.small" };

/** GCP's Arm machine series (Tau T2A, Axion C4A and N4A). */
export const GCP_ARM_SERIES: readonly string[] = ["t2a", "c4a", "n4a"];

const TOP_FIELDS = ["name", "provider", "ssh", "gcp", "aws", "arch", "home"] as const;
const BLOCK_FIELDS: Readonly<Record<Provider, readonly string[]>> = {
  ssh: ["host", "user", "port"],
  gcp: ["project", "zone", "machineType", "diskGb"],
  aws: ["region", "instanceType", "diskGb"],
};

/**
 * A field name that says it holds a secret.
 *
 * Checked on names that are already unknown — none of the allowed names match —
 * so the only effect is a better reason than "unknown field": the person who
 * typed `"password"` into a target file needs to hear where it goes instead.
 */
const SECRET_NAME = /pass|secret|token|key|credential|private|auth|cert|pem|bearer|cookie|session/i;

/** GCE's rule for an instance name, which also suits a tailnet host name and a unit name. */
const NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_ZONE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const GCP_MACHINE_TYPE = /^[a-z][a-z0-9]*-[a-z0-9-]+$/;
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const AWS_INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
/** Graviton: a generation digit followed by `g` (`t4g`, `m7gd`, `c7gn`), or the first one, `a1`. */
const AWS_ARM_FAMILY = /^(?:a1|[a-z]+\d+g[a-z]*)\./;

/** A dotted IPv4 literal. */
export function isIPv4(value: string): boolean {
  return IPV4.test(value);
}

/**
 * An IPv6 literal, as the URL parser reads one.
 *
 * `URL` is a parser, not a socket, and it is the one strict IPv6 grammar the
 * runtime already carries — `node:net`'s `isIPv6` would bring a network module
 * into a closure whose point is that it has none.
 */
export function isIPv6(value: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(value) || !value.includes(":")) return false;
  try {
    return new URL(`http://[${value}]/`).hostname !== "";
  } catch {
    return false;
  }
}

/** A DNS host name: labels of letters, digits and inner hyphens, 253 characters at most. */
export function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.replace(/\.$/, "").split(".");
  return labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1]!);
}

/** A tailnet address: Tailscale's 100.64.0.0/10, or its IPv6 range fd7a:115c:a1e0::/48. */
export function isTailnetAddress(value: string): boolean {
  if (isIPv4(value)) {
    const [first, second] = value.split(".").map(Number);
    return first === 100 && second! >= 64 && second! <= 127;
  }
  return isIPv6(value) && /^fd7a:115c:a1e0:/i.test(value);
}

/**
 * `home`: a MagicDNS name, short or full, or a tailnet address.
 *
 * Shape only. Whether that machine is on the owner's tailnet is a question for
 * the network, which a plan does not ask — the limits say so.
 */
export function homeProblem(value: string): string | undefined {
  if (isIPv4(value) || isIPv6(value)) {
    return isTailnetAddress(value)
      ? undefined
      : "is an address outside the tailnet. The model at home is reached over the tailnet only " +
          "(D-100 #3): a tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48) or a MagicDNS name";
  }
  if (!isHostname(value)) return "is not a host name";
  if (value.includes(".") && !/\.ts\.net\.?$/i.test(value)) {
    return (
      "is a name outside the tailnet. The model at home is reached over the tailnet only (D-100 #3): " +
      "its MagicDNS name, short (`desk`) or full (`desk.<tailnet>.ts.net`), or its tailnet address"
    );
  }
  return undefined;
}

/** `host` for ssh: a host name or an address, and nothing `ssh` could read as an option. */
export function hostProblem(value: string): string | undefined {
  if (value.includes("@")) return "holds an @ — the user goes in `ssh.user`, the host alone here";
  if (isIPv4(value) || isIPv6(value) || isHostname(value)) return undefined;
  return "is not a host name or an IP address";
}

/** Whether a machine type or instance type is Arm, as far as its family says. */
export function isArmType(provider: "gcp" | "aws", type: string): boolean {
  if (provider === "aws") return AWS_ARM_FAMILY.test(type);
  return GCP_ARM_SERIES.includes(type.split("-")[0] ?? "");
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What is wrong with one field that is not allowed where it is. */
function unknownField(path: string, key: string, allowed: readonly string[]): TargetProblem {
  if (SECRET_NAME.test(key)) {
    return {
      field: path,
      problem:
        "looks like a secret, and a target file holds none. An API key goes on the encrypted volume " +
        "there (S13.7, D-109); the disk key stays on the machine that unlocks it (D-111). Its value " +
        "was not read into this message",
    };
  }
  return { field: path, problem: `is not a field here — the fields are ${allowed.join(", ")}` };
}

/**
 * Every problem the raw bytes have in the guard scanner's eyes: a private key,
 * a vendor token, a password in a URL. Reported by rule and line, never by text
 * — the scanner's own promise, kept here.
 */
function secretsIn(text: string, path: string): TargetProblem[] {
  const findings = scanStaged([{ path, bytes: new TextEncoder().encode(text) }]);
  return findings.map((finding) => ({
    field: "(file)",
    problem:
      `line ${finding.line} holds ${finding.says} (rule ${finding.rule}). A target file holds no ` +
      `secrets; move it out, and rotate it if this file was ever shared`,
  }));
}

/**
 * What one parse accumulates, in one value rather than three arguments.
 *
 * `quote` is the part that matters: a problem normally names the value it
 * refused (`"Not_A_Name" is not a machine name`), which is what makes a typo
 * findable. When the scanner found anything secret-shaped in the file, no value
 * is quoted at all — the token pasted into `ssh.user` would otherwise come back
 * out in the very message refusing it.
 */
interface Parse {
  readonly problems: TargetProblem[];
  readonly defaulted: string[];
  readonly quote: boolean;
}

/** A string field: present, a string, and passing `check`. */
function stringField(
  ctx: Parse,
  block: JsonObject,
  path: string,
  key: string,
  check: (value: string) => string | undefined,
): string | undefined {
  const value = block[key];
  if (value === undefined) {
    ctx.problems.push({ field: `${path}${key}`, problem: "is required" });
    return undefined;
  }
  if (typeof value !== "string") {
    ctx.problems.push({ field: `${path}${key}`, problem: "must be a string" });
    return undefined;
  }
  const wrong = check(value);
  if (wrong !== undefined) {
    ctx.problems.push({ field: `${path}${key}`, problem: `${ctx.quote ? JSON.stringify(value) : "the value"} ${wrong}` });
    return undefined;
  }
  return value;
}

/** An optional whole number between `min` and `max`, or its default. */
function numberField(
  ctx: Parse,
  block: JsonObject,
  path: string,
  key: string,
  bounds: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  const value = block[key];
  if (value === undefined) {
    ctx.defaulted.push(`${path}${key}`);
    return bounds.fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    ctx.problems.push({ field: `${path}${key}`, problem: `must be a whole number from ${bounds.min} to ${bounds.max}` });
    return bounds.fallback;
  }
  return value;
}

/** An optional string with a default, checked when given. */
function optionalString(
  ctx: Parse,
  block: JsonObject,
  path: string,
  key: string,
  fallback: string,
  check: (value: string) => string | undefined,
): string {
  if (block[key] === undefined) {
    ctx.defaulted.push(`${path}${key}`);
    return fallback;
  }
  return stringField(ctx, block, path, key, check) ?? fallback;
}

const pattern = (re: RegExp, says: string) => (value: string) => (re.test(value) ? undefined : says);

function unknownIn(ctx: Parse, block: JsonObject, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(block)) {
    if (!allowed.includes(key)) ctx.problems.push(unknownField(`${path}${key}`, key, allowed));
  }
}

function parseSsh(ctx: Parse, block: JsonObject): SshBlock | undefined {
  unknownIn(ctx, block, "ssh.", BLOCK_FIELDS.ssh);
  const host = stringField(ctx, block, "ssh.", "host", hostProblem);
  const user = stringField(
    ctx,
    block,
    "ssh.",
    "user",
    pattern(USER, "is not a user name (letters, digits, _ . -, not starting with - or a digit)"),
  );
  const port = numberField(ctx, block, "ssh.", "port", { min: 1, max: 65535, fallback: DEFAULT_SSH_PORT });
  return host === undefined || user === undefined ? undefined : { host, user, port };
}

/**
 * A machine type whose CPU disagrees with `arch`, said both ways round.
 *
 * The binary is built for one CPU, and a wrong one fails on the first exec there
 * — after a VM was created and billed. Known families only: a family this list
 * does not know is refused under `arm64` rather than guessed at.
 */
function archCheck(provider: "gcp" | "aws", type: string, arch: Arch, archGiven: boolean): string | undefined {
  const arm = isArmType(provider, type);
  if (arm && arch === "x64") {
    return archGiven
      ? `is an Arm type and arch is x64 — set arch to arm64, or pick an x64 type`
      : `is an Arm type — set arch to arm64 (it defaults to x64)`;
  }
  if (!arm && arch === "arm64") {
    const families = provider === "gcp" ? GCP_ARM_SERIES.join(", ") : "Graviton types such as t4g, m7g, c7gn";
    return `is not an Arm type this plan knows (${families}), and arch is arm64`;
  }
  return undefined;
}

const DISK = { min: MIN_DISK_GB, max: MAX_DISK_GB, fallback: DEFAULT_DISK_GB } as const;

function parseGcp(ctx: Parse, block: JsonObject, arch: Arch, archGiven: boolean): GcpBlock | undefined {
  unknownIn(ctx, block, "gcp.", BLOCK_FIELDS.gcp);
  const project = stringField(ctx, block, "gcp.", "project", pattern(GCP_PROJECT, "is not a GCP project id (6–30 characters: a-z, 0-9, -)"));
  const zone = stringField(ctx, block, "gcp.", "zone", pattern(GCP_ZONE, "is not a GCP zone, such as asia-southeast1-b"));
  const machineType = optionalString(ctx, block, "gcp.", "machineType", DEFAULT_MACHINE_TYPE[arch], (value) =>
    GCP_MACHINE_TYPE.test(value) ? archCheck("gcp", value, arch, archGiven) : "is not a GCP machine type, such as e2-small",
  );
  const diskGb = numberField(ctx, block, "gcp.", "diskGb", DISK);
  return project === undefined || zone === undefined ? undefined : { project, zone, machineType, diskGb };
}

function parseAws(ctx: Parse, block: JsonObject, arch: Arch, archGiven: boolean): AwsBlock | undefined {
  unknownIn(ctx, block, "aws.", BLOCK_FIELDS.aws);
  const region = stringField(ctx, block, "aws.", "region", pattern(AWS_REGION, "is not an AWS region, such as ap-southeast-1"));
  const instanceType = optionalString(ctx, block, "aws.", "instanceType", DEFAULT_INSTANCE_TYPE[arch], (value) =>
    AWS_INSTANCE_TYPE.test(value) ? archCheck("aws", value, arch, archGiven) : "is not an EC2 instance type, such as t3.small",
  );
  const diskGb = numberField(ctx, block, "aws.", "diskGb", DISK);
  return region === undefined ? undefined : { region, instanceType, diskGb };
}

/**
 * Read a target file's text into a {@link Target}, or say everything wrong with it.
 *
 * @param text The file's contents.
 * @param path How to name the file to the secret scanner (its path rules look at the name too).
 */
export function parseTarget(text: string, path = "target.json"): TargetParse {
  const secrets = secretsIn(text, path);
  const ctx: Parse = { problems: [...secrets], defaulted: [], quote: secrets.length === 0 };
  const { problems, defaulted } = ctx;

  let root: Json;
  try {
    root = JSON.parse(text) as Json;
  } catch {
    // The parser's own message can quote the file, and the file may be the
    // one with a key pasted into it. Where it failed is not worth that.
    problems.push({ field: "(file)", problem: "is not valid JSON (the parser's message is not repeated: it can quote the file)" });
    return { ok: false, problems };
  }
  if (!isObject(root)) {
    problems.push({ field: "(file)", problem: "must be one JSON object" });
    return { ok: false, problems };
  }

  unknownIn(ctx, root, "", TOP_FIELDS);
  const name = stringField(ctx, root, "", "name", pattern(NAME, "is not a machine name (a-z, 0-9 and -, starting with a letter, 63 at most)"));
  const provider = stringField(ctx, root, "", "provider", (value) =>
    (PROVIDERS as readonly string[]).includes(value) ? undefined : `is not one of ${PROVIDERS.join(", ")}`,
  ) as Provider | undefined;
  const archGiven = root["arch"] !== undefined;
  const arch = optionalString(ctx, root, "", "arch", "x64", (value) =>
    (ARCHES as readonly string[]).includes(value) ? undefined : `is not one of ${ARCHES.join(", ")}`,
  ) as Arch;
  const home = root["home"] === undefined ? null : (stringField(ctx, root, "", "home", homeProblem) ?? null);

  for (const other of PROVIDERS) {
    if (other !== provider && root[other] !== undefined) {
      problems.push({
        field: other,
        problem: provider === undefined ? "is given, and provider is not" : `is given, and the provider is ${provider} — one target, one provider`,
      });
    }
  }

  if (provider === undefined) return { ok: false, problems };
  const block = root[provider];
  if (!isObject(block)) {
    problems.push({ field: provider, problem: block === undefined ? `is required for provider ${provider}` : "must be an object" });
    return { ok: false, problems };
  }

  // The block is read even when `name` was wrong, so one run names every problem.
  const target = targetOf(ctx, provider, block, { name: name ?? "", arch, home }, archGiven);
  if (problems.length > 0 || name === undefined || target === undefined) return { ok: false, problems };
  return { ok: true, target, defaulted };
}

/** The provider's block, read, and joined to the fields every target has. */
function targetOf(ctx: Parse, provider: Provider, block: JsonObject, common: Common, archGiven: boolean): Target | undefined {
  if (provider === "ssh") {
    const ssh = parseSsh(ctx, block);
    return ssh === undefined ? undefined : { ...common, provider, ssh };
  }
  if (provider === "gcp") {
    const gcp = parseGcp(ctx, block, common.arch, archGiven);
    return gcp === undefined ? undefined : { ...common, provider, gcp };
  }
  const aws = parseAws(ctx, block, common.arch, archGiven);
  return aws === undefined ? undefined : { ...common, provider, aws };
}

/** One line per problem, as the command prints them. */
export function formatProblem(problem: TargetProblem): string {
  return `${problem.field}: ${problem.problem}`;
}
