/**
 * `mind key` — the agent's own ed25519 key (S15.8, D-108, D-138), and proof that it holds it (S15.4, D-141).
 *
 *   key <agent-dir> --subject <id>          make it the first time; show the public half every time after
 *   key prove <agent-dir> --subject <id> …  sign a market's challenge with it, so the market can register it
 *   key verify-proof <file|-> --key <pk> …  check such a proof the way the market does
 *
 * The private half stays in its file — never printed, never on a command line, never in the agent's
 * repository — and nothing but the bare `key` ever makes one. The key parts are in `src/identity/`, where a
 * test calls them; this is the parsing and the printing. Everything printed that came from a file or from
 * the command line goes through `printable`, as in S15.8.
 */

import { readFile } from "node:fs/promises";
import { identityDirFor } from "../../src/identity/dir.ts";
import { ensureAgentKey, readAgentKey } from "../../src/identity/key.ts";
import { keyProofPayload, targetProblem, verifyKeyProof, type ProofTarget } from "../../src/identity/proof.ts";
import { printable } from "../../src/identity/shapes.ts";
import { publicKeyProblem } from "../../src/identity/sign.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { subjectId } from "../../src/types.ts";
import { dialEnv } from "../dial.ts";
import { bold, dim, ERR, OUT, parseArgs, report, usageError } from "../shared.ts";

const USAGE =
  "usage: mind key <agent-dir> --subject <id>\n" +
  "       mind key prove <agent-dir> --subject <id> --market <origin> --listing <slug> --nonce <nonce> [--json]\n" +
  "       mind key verify-proof <file|-> --key <public-key> --market <origin> --listing <slug> --nonce <nonce>";

const TARGET = ["market", "listing", "nonce"] as const;

async function cmdMake(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const dir = positional[0];
  const raw = options.get("subject");
  if (dir === undefined || positional.length > 1 || raw === undefined || raw === "") return usageError(USAGE);
  let id;
  try {
    id = subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  // A key for a subject with no soul is a typo waiting to be signed with.
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);

  const result = await ensureAgentKey(identityDirFor(dialEnv(), id));
  if (result.state === "refused") {
    console.error(`mind: no key was used: ${result.reason}`);
    return 1;
  }
  const { key, created } = result;
  console.log(bold(`${loaded.soul.role.name}'s signing key (ed25519) — ${created ? "made just now" : "already made; nothing was changed"}.`));
  console.log(`  public key   ${key.publicKey}`);
  console.log(`  fingerprint  ${key.fingerprint}`);
  console.log(`  private key  ${key.path}`);
  console.log(dim("               mode 600 in a 700 directory, outside git — Mind never prints it"));
  console.log(
    dim(
      "The public key is on the agent card (`soul card`, `a2a serve`) and signs `usage report`. " +
        "Replacing it makes a different signer to everyone who knew this one, so Mind never does; " +
        "`erase` removes it.",
    ),
  );
  return 0;
}

/**
 * The market, listing and nonce from the command line, each present and in its shape — or the exit code of
 * the usage error that says which is not. A nonce may begin with `--` (base64url has `-`), which the option
 * parser would take for a flag; the error for an empty one says how to write it.
 */
function targetFrom(options: ReadonlyMap<string, string>, allowed: readonly string[], usage: string): ProofTarget | number {
  for (const name of TARGET) {
    const value = options.get(name);
    if (value === undefined) return usageError(`--${name} is required\n${usage}`);
    if (value === "") {
      return usageError(name === "nonce" ? "--nonce has no value — a nonce that begins with -- is written --nonce=<nonce>" : `--${name} has no value`);
    }
  }
  const stray = [...options.keys()].find((name) => !allowed.includes(name));
  if (stray !== undefined) return usageError(`it takes ${allowed.map((name) => `--${name}`).join(", ")} and nothing else, not --${printable(stray)}\n${usage}`);
  const target = { market: options.get("market")!, listing: options.get("listing")!, nonce: options.get("nonce")! };
  const problem = targetProblem(target);
  return problem === undefined ? target : usageError(`--${printable(problem)}`);
}

/**
 * `key prove` — the challenge signed (D-141 §1). Reads the key and never makes one: a proof for a key that
 * came into being a moment ago proves only that this command ran.
 */
async function cmdProve(argv: readonly string[]): Promise<number> {
  const flags = ["json"];
  const { positional, options } = parseArgs(argv, flags);
  const json = options.has("json");
  const dir = positional[0];
  const raw = options.get("subject");
  if (dir === undefined || positional.length > 1 || raw === undefined || raw === "") return usageError(USAGE);
  const target = targetFrom(options, ["subject", ...flags, ...TARGET], USAGE);
  if (typeof target === "number") return target;
  let id;
  try {
    id = subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);

  const read = await readAgentKey(identityDirFor(dialEnv(), id));
  if (read.state !== "present") {
    console.error(
      read.state === "absent"
        ? `mind: ${printable(loaded.soul.role.name)} has no signing key yet, so there is nothing to prove — \`mind key ${printable(dir)} --subject ${id}\` makes one.`
        : `mind: the signing key cannot be used: ${printable(read.reason)}`,
    );
    return 1;
  }
  const envelope = read.key.sign(keyProofPayload(target, new Date()));

  // Under --json the proof is stdout, alone; everything a person reads goes to stderr.
  const say = json ? ERR : OUT;
  say.line(say.bold(`${printable(loaded.soul.role.name)}'s key proof — signed by ed25519 key ${envelope.fingerprint}`));
  say.line(`  public key  ${envelope.publicKey}`);
  say.line(`  market      ${printable(target.market)}`);
  say.line(`  listing     ${printable(target.listing)}`);
  say.line(`  nonce       ${printable(target.nonce)}`);
  say.line(`  signed at   ${printable(String(envelope.payload["at"]))}`);
  say.line(
    say.dim(
      "It says that this agent's key signed this market's challenge for this listing, and nothing else: no private " +
        "key, no subject id. It is good once, until the challenge expires." +
        (json ? "" : " Give the market the public key and the line below; `--json` prints that line alone."),
    ),
  );
  console.log(JSON.stringify(envelope));
  return 0;
}

/** `key verify-proof` — what the platform checks, but the nonce's freshness, which only it can know. */
async function cmdVerifyProof(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const file = positional[0];
  if (file === undefined || positional.length > 1) return usageError(USAGE);
  const key = options.get("key");
  if (key === undefined || key === "") return usageError(`--key is required: a proof is checked against the key it should prove\n${USAGE}`);
  const target = targetFrom(options, ["key", ...TARGET], USAGE);
  if (typeof target === "number") return target;
  const keyProblem = publicKeyProblem(key);
  if (keyProblem !== undefined) return usageError(`--key is not an ed25519 public key a signature may be checked against: ${keyProblem}`);
  let text: string;
  try {
    text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
  } catch (error) {
    console.error(`mind: NOT valid — ${printable(file)} could not be read: ${printable(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
  const checked = verifyKeyProof(text, key, target);
  if (!checked.ok) {
    console.error(`mind: NOT valid — ${printable(checked.reason)}`);
    return 1;
  }
  const { envelope, payload } = checked;
  console.log(`valid — a key proof signed by ed25519 key ${envelope.fingerprint}`);
  console.log(`  public key  ${envelope.publicKey}`);
  console.log(`  market      ${printable(payload.market)}`);
  console.log(`  listing     ${printable(payload.listing)}`);
  console.log(`  nonce       ${printable(payload.nonce)}`);
  console.log(`  signed at   ${printable(payload.at)}`);
  console.log("It proves the key you named, for this market, listing and nonce. Whether the nonce is unexpired and unused only the market that issued it can say.");
  return 0;
}

export async function cmdKey(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "prove":
      return cmdProve(rest);
    case "verify-proof":
      return cmdVerifyProof(rest);
    default:
      // `key <agent-dir>`: the bare verb is a command of its own, and the first word is the agent's directory.
      return cmdMake(argv);
  }
}
