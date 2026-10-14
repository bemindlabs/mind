/**
 * `mind basis` — the record of why a subject's data may come in (S7.3, D-077).
 *
 *   record <basis> --subject <id> --uses <memory,persona,…> [--expires YYYY-MM-DD|never] [--approved-by <name>] [--note <text>]
 *   show --subject <id>
 *   revoke <record-id> --subject <id>
 *
 * Recording is typed at a terminal, like a peer or a chat user: an agent acting
 * on its own cannot give itself a basis to read somebody in.
 */

import { isatty } from "node:tty";
import { BASES, basisDirFor, basisProblem, readBasis, recordPhrase, recordState, USES, writeBasis, type Basis, type Use } from "../../src/consent/basis.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { dialEnv, whoIsSetting } from "../dial.ts";
import { bold, dim, parseArgs, readPhrase, usageError } from "../shared.ts";

const USAGE =
  `usage: mind basis record <${BASES.join("|")}> --subject <id> --uses <${USES.join(",")}> [--expires YYYY-MM-DD|never] [--approved-by <name>] [--note <text>]\n` +
  "       mind basis show --subject <id>\n" +
  "       mind basis revoke <record-id> --subject <id>";

function subjectOf(options: ReadonlyMap<string, string>): { ok: true; id: SubjectId } | { ok: false; code: number } {
  const raw = options.get("subject");
  if (raw === undefined || raw === "") return { ok: false, code: usageError(USAGE) };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

async function cmdRecord(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const basis = positional[0];
  const uses = (options.get("uses") ?? "").split(",").map((u) => u.trim()).filter((u) => u !== "");
  const expiresRaw = options.get("expires") ?? "never";
  const expires = expiresRaw === "never" ? null : expiresRaw;
  if (basis === undefined) return usageError(USAGE);
  const problem = basisProblem(basis, uses, expires, new Date());
  if (problem !== undefined) return usageError(problem);
  const phrase = recordPhrase(s.id);
  if (!(process.stdin.isTTY === true && isatty(1))) {
    console.error(`mind: a basis is recorded at a terminal, where you can type: ${phrase}`);
    return 1;
  }
  const approvedBy = options.get("approved-by") ?? (await whoIsSetting(process.cwd()));
  console.error(`${s.id}'s data may come in for ${uses.join(", ")}, on the basis "${basis}", approved by ${approvedBy}, ${expires === null ? "with no end date" : `until ${expires}`}.`);
  console.error("This records a decision; it does not make it lawful. That is the approver's to know.");
  console.error(`To record it, type exactly:  ${phrase}`);
  const typed = await readPhrase();
  if (typed !== phrase) {
    console.error(`mind: read ${JSON.stringify(typed)} — not ${JSON.stringify(phrase)}, so nothing was recorded.`);
    return 1;
  }
  const dir = basisDirFor(dialEnv(), s.id);
  const records = await readBasis(dir);
  const record = {
    id: crypto.randomUUID().slice(0, 8),
    subject: s.id,
    basis: basis as Basis,
    approvedBy,
    at: new Date().toISOString(),
    uses: uses as Use[],
    expires,
    note: options.get("note") ?? "",
    revokedAt: null,
  };
  await writeBasis(dir, [...records, record]);
  console.log(bold(`recorded ${record.id}: ${basis} for ${uses.join(", ")}`));
  return 0;
}

async function cmdShow(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const records = await readBasis(basisDirFor(dialEnv(), s.id));
  if (records.length === 0) {
    console.log(`no basis on record for ${s.id} — nothing of theirs can be taken in (S7.3).`);
    return 0;
  }
  const now = new Date();
  for (const r of records) {
    console.log(`${r.id}  ${recordState(r, now).padEnd(8)} ${r.basis.padEnd(20)} ${r.uses.join(",").padEnd(22)} by ${r.approvedBy} at ${r.at.slice(0, 10)} · ${r.expires === null ? "no end date" : `until ${r.expires}`}${r.revokedAt === null ? "" : ` · revoked ${r.revokedAt.slice(0, 10)}`}${r.note === "" ? "" : ` · ${r.note}`}`);
  }
  console.log(dim("Revoking stops what comes in next; to remove what already came in, use `mind erase` or `memory forget`."));
  return 0;
}

async function cmdRevoke(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const id = positional[0];
  if (id === undefined) return usageError(USAGE);
  const dir = basisDirFor(dialEnv(), s.id);
  const records = await readBasis(dir);
  const found = records.find((r) => r.id === id);
  if (found === undefined || found.revokedAt !== null) {
    console.error(`mind: ${found === undefined ? `no record ${id}` : `${id} is already revoked`}.`);
    return 1;
  }
  // Narrowing is never gated: anyone may stop data coming in.
  await writeBasis(dir, records.map((r) => (r.id === id ? { ...r, revokedAt: new Date().toISOString() } : r)));
  console.log(`${id} revoked — nothing more of ${s.id}'s comes in on it. What already came in stays until erased.`);
  return 0;
}

export async function cmdBasis(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "record":
      return cmdRecord(rest);
    case "show":
      return cmdShow(rest);
    case "revoke":
      return cmdRevoke(rest);
    default:
      return usageError(`unknown basis subcommand ${JSON.stringify(sub ?? "")}\n${USAGE}`);
  }
}
