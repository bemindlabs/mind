/**
 * `deploy plan` for a person: the plan as plain lines, in the order the
 * decision is made — what goes, what does not, what it would take to meet
 * D-100, what would be run — and last, what this plan does not check.
 *
 * Separate from printing so a test can read it, the same split `doctor` makes
 * (`renderDoctor`). No colour: this is output people paste into an issue or a
 * review, and a page of escape codes survives neither.
 */

import type { Step } from "./commands.ts";
import type { DeployPlan, PlanEntry } from "./plan.ts";
import type { Target } from "./target.ts";

/** Bytes as a person reads them: 0 B, 812 B, 3.4 KB, 1.2 MB. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** One line naming the machine, the way the target file does. */
export function describeTarget(target: Target): string {
  if (target.provider === "ssh") {
    const { user, host, port } = target.ssh;
    return `ssh ${user}@${host}:${port}, ${target.arch}`;
  }
  if (target.provider === "gcp") {
    const { project, zone, machineType, diskGb } = target.gcp;
    return `gcp ${project}/${zone}, ${machineType}, ${diskGb} GB data disk, ${target.arch}`;
  }
  const { region, instanceType, diskGb } = target.aws;
  return `aws ${region}, ${instanceType}, ${diskGb} GB volume, ${target.arch}`;
}

/** How much is in one entry, or why there is no number. */
function sizeOf(entry: PlanEntry): string {
  if (entry.size === null) return entry.here === null ? "" : "not there";
  const links = entry.size.symlinks > 0 ? `, ${entry.size.symlinks} link(s)` : "";
  return `${entry.size.files} file(s), ${humanBytes(entry.size.bytes)}${links}`;
}

/** An entry: the label and its size, where it would be, and the reason under it. */
function entryLines(entry: PlanEntry, arrow: boolean): string[] {
  const size = sizeOf(entry);
  const lines = [`  ${entry.label}${size === "" ? "" : ` — ${size}`}`];
  if (entry.here !== null) lines.push(`      here:  ${entry.here}`);
  if (arrow && entry.there !== null) {
    lines.push(`      there: ${entry.there}${entry.encrypted ? "  (encrypted volume)" : "  (boot disk)"}`);
  }
  if (entry.note !== null) lines.push(`      ${entry.note}`);
  return lines;
}

/**
 * An argv as a line somebody could read — and, for a plain one, paste.
 *
 * Quoted only where a shell would need it. The argv itself is the truth; this
 * is the reading of it.
 */
export function shellLine(argv: readonly string[]): string {
  return argv.map((word) => (/^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function stepLines(step: Step, index: number): string[] {
  const lines = [`  ${String(index + 1).padStart(2)}. ${step.what}`];
  const command = shellLine(step.argv);
  lines.push(step.pipeFrom === undefined ? `      $ ${command}` : `      $ ${shellLine(step.pipeFrom)} | ${command}`);
  if (step.stdin !== undefined) lines.push(`        stdin: ${step.stdin}`);
  return lines;
}

/** The whole plan, as lines. */
export function renderPlan(plan: DeployPlan): readonly string[] {
  const lines: string[] = [];
  lines.push(`deploy plan — subject ${plan.subject} · ${plan.agentDir}`);
  lines.push(`  to ${plan.target.name}: ${describeTarget(plan.target)}`);
  lines.push(`  engine ${plan.engine} · nothing was done: no command below has run, nothing was written, nothing was sent`);
  lines.push("");

  if (plan.refusals.length > 0) {
    lines.push(`apply would refuse — ${plan.refusals.length} reason(s):`);
    for (const refusal of plan.refusals) lines.push(`  - ${refusal}`);
    lines.push("");
  }

  lines.push("What goes");
  for (const entry of plan.goes) lines.push(...entryLines(entry, true));
  lines.push(
    `  in all: ${plan.totals.files} file(s), ${humanBytes(plan.totals.bytes)} of yours onto the encrypted volume ` +
      `at ${plan.remote.volume}`,
  );
  lines.push("");

  lines.push("Made there, not copied");
  for (const entry of plan.rebuilt) lines.push(...entryLines(entry, true));
  lines.push("");

  lines.push("Stays on this machine");
  for (const entry of plan.stays) lines.push(...entryLines(entry, false));
  lines.push("");

  lines.push("Does not go, and is not in the data map");
  for (const item of plan.notGoing) lines.push(`  - ${item}`);
  lines.push("");

  lines.push(`Services it would install (as ${plan.remote.user}, starting only once the volume is open)`);
  for (const service of plan.services) {
    lines.push(`  ${service.name} — ${service.what}`);
    lines.push(`      $ ${shellLine(service.exec)}`);
    lines.push(`      listens: ${service.listens ?? "nothing — it opens no port"}`);
    for (const unit of service.units) {
      lines.push(`      ${unit.path}:`);
      for (const text of unit.text.trimEnd().split("\n")) lines.push(`        ${text}`);
    }
  }
  lines.push("");

  lines.push("What `apply` will require first — D-100's four conditions, for this provider");
  plan.gates.forEach((gate, index) => {
    lines.push(`  ${index + 1}. ${gate.condition}`);
    lines.push(`     ${gate.canBeMet ? "can be met" : "cannot be met"} · waits on ${gate.waitsOn.join(", ")}`);
    lines.push(`     ${gate.how}`);
  });
  lines.push(`  The keys stay here: ${plan.keys.volume}${plan.target.provider === "gcp" ? ` and ${plan.keys.disk}` : ""}.`);
  lines.push("");

  lines.push(`Commands it would run, in order — shown, not run (${plan.steps.length})`);
  plan.steps.forEach((step, index) => lines.push(...stepLines(step, index)));
  if (plan.placeholders.length > 0) {
    lines.push("  In braces, filled in at apply time:");
    for (const placeholder of plan.placeholders) lines.push(`    ${placeholder.name}  ${placeholder.means}`);
  }
  lines.push("");

  if (plan.notes.length > 0) {
    lines.push("Notes");
    for (const note of plan.notes) lines.push(`  - ${note}`);
    lines.push("");
  }

  lines.push(
    plan.refusals.length === 0
      ? `plan ready — \`deploy apply\` (not built yet) would ask for "${plan.phrase}" before its first command`
      : `not ready — ${plan.refusals.length} thing(s) above would stop \`deploy apply\` before its first command`,
  );
  lines.push("");
  lines.push("What this plan does not check:");
  for (const limit of plan.limits) lines.push(`  - ${limit}`);
  return lines;
}
