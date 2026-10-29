/**
 * `mind grant` — standing grants for a task's browser (S22.11, D-197): see `src/task/grants.ts`.
 *
 * Given by a person at a terminal, never from inside a turn: a bot that could run `mind grant give` in its own shell
 * would be answering its own questions. The same refusal `task new` makes.
 */

import { dirname, join } from "node:path";
import { agentAncestor } from "../../src/task/index.ts";
import { tasksDir } from "../../src/task/store.ts";
import {
  GRANTABLE,
  GRANTS_DIR,
  giveGrant,
  grantReport,
  isActive,
  makeGrant,
  newGrantId,
  readGrants,
  revokeGrant,
  type Grant,
} from "../../src/task/grants.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { dialEnv } from "../dial.ts";
import { parseArgs, usageError } from "../shared.ts";

const USAGE =
  "usage: mind grant give <dir> --subject <id> --category send|delete|terms|payment --origin <origin> --for <90m|24h|7d> [--task <id>]\n" +
  "       mind grant list <dir> --subject <id> [--json]\n" +
  "       mind grant revoke <grant> <dir> --subject <id>\n" +
  "       mind grant report <dir> --subject <id> [--json]";

/** One flag list per subcommand, so the help and the tree agree on who takes --json (test/cli/json-stdout.test.ts). */
const LIST_BOOLEANS: readonly string[] = ["json"];
const REPORT_BOOLEANS: readonly string[] = ["json"];

async function where(dir: string | undefined, raw: string | undefined): Promise<{ ok: true; subject: SubjectId; grants: string; tasks: string } | { ok: false; code: number }> {
  if (dir === undefined || raw === undefined || raw === "") return { ok: false, code: usageError(USAGE) };
  let subject: SubjectId;
  try {
    subject = subjectId(raw);
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
  const tasks = await tasksDir(dialEnv(), subject);
  if (!tasks.ok) {
    console.error(`mind grant: ${tasks.reason}`);
    return { ok: false, code: 1 };
  }
  return { ok: true, subject, tasks: tasks.path, grants: join(dirname(tasks.path), GRANTS_DIR) };
}

/** A grant is given or taken back by a person: refused from inside a turn, with nothing written. */
async function underTurn(w: { subject: SubjectId; tasks: string }): Promise<number | undefined> {
  const above = await agentAncestor(dialEnv(), w.tasks, w.subject);
  if (above === undefined) return undefined;
  console.error(`mind grant: nothing was written — this command runs under ${above}. A grant is given by a person at a terminal, not from inside a turn.`);
  return 4;
}

function line(grant: Grant, now: number): string {
  const state = grant.revokedAt !== null ? "revoked" : isActive(grant, now) ? "active" : "expired";
  return `${grant.id}  ${state}  ${grant.category}  ${grant.origin}  ${grant.task === null ? "any task" : grant.task}  until ${grant.expiresAt}`;
}

export async function cmdGrant(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "give":
      return give(rest);
    case "list":
      return list(rest);
    case "revoke":
      return revoke(rest);
    case "report":
      return report(rest);
    default:
      return usageError(USAGE);
  }
}

async function give(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, []);
  if (positional.length !== 1) return usageError(USAGE);
  const w = await where(positional[0], options.get("subject"));
  if (!w.ok) return w.code;
  const nested = await underTurn(w);
  if (nested !== undefined) return nested;
  const made = makeGrant({
    subject: w.subject,
    category: options.get("category") ?? "",
    origin: options.get("origin") ?? "",
    lifetime: options.get("for") ?? "",
    ...(options.get("task") === undefined ? {} : { task: options.get("task") }),
    now: new Date(),
    id: newGrantId(),
  });
  if (!made.ok) return usageError(`${made.reason}. Nothing was written.`);
  await giveGrant(w.grants, made.grant, new Date());
  console.log(made.grant.id);
  console.error(
    `mind grant: ${made.grant.id} — ${made.grant.category} on ${made.grant.origin} for ${w.subject}, ${made.grant.task === null ? "any task" : `task ${made.grant.task}`}, until ${made.grant.expiresAt}. ` +
      `\`mind grant revoke ${made.grant.id}\` takes it back at once; \`mind stop\` switches every grant off. It never covers a credential or personal data leaving this machine.`,
  );
  return 0;
}

async function list(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, LIST_BOOLEANS);
  if (positional.length !== 1) return usageError(USAGE);
  const w = await where(positional[0], options.get("subject"));
  if (!w.ok) return w.code;
  const grants = (await readGrants(w.grants)).map((entry) => entry.grant).filter((grant) => grant.subject === w.subject);
  if (options.has("json")) {
    console.log(JSON.stringify({ grants }));
    return 0;
  }
  if (grants.length === 0) console.log("no grants");
  const now = Date.now();
  for (const grant of grants) console.log(line(grant, now));
  return 0;
}

async function revoke(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, []);
  if (positional.length !== 2) return usageError(USAGE);
  const w = await where(positional[1], options.get("subject"));
  if (!w.ok) return w.code;
  const nested = await underTurn(w);
  if (nested !== undefined) return nested;
  const revoked = await revokeGrant(w.grants, positional[0]!, new Date());
  if (!revoked.ok) {
    console.error(`mind grant: ${revoked.reason}`);
    return 2;
  }
  console.log(`${revoked.grant.id}  revoked`);
  return 0;
}

async function report(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, REPORT_BOOLEANS);
  if (positional.length !== 1) return usageError(USAGE);
  const w = await where(positional[0], options.get("subject"));
  if (!w.ok) return w.code;
  const result = await grantReport(w.grants);
  if (options.has("json")) {
    console.log(JSON.stringify(result));
    return 0;
  }
  console.log(`${result.answered} held action(s) answered by a grant, so ${result.answered} request(s) that did not wait for you`);
  console.log(`${result.given} grant(s) given, ${result.revoked} revoked`);
  for (const [id, n] of Object.entries(result.byGrant)) console.log(`  ${id}: ${n} use(s)`);
  console.log(`Counted from the grant record (${GRANTS_DIR}/events.jsonl), not estimated. Grantable categories: ${GRANTABLE.join(", ")}; never credentials.`);
  return 0;
}
