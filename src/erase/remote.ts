/**
 * `erase --remote` — what is on the machine the agent was deployed to (S13.5 AC2, D-100 #2).
 *
 * Step 1 only reads the target and says where the remote's data would be. It
 * sends nothing. Every path is `dataMap` evaluated with the remote's roots
 * (D-134) — the same resolver `deploy plan` uses — so there is no second list of
 * places here to drift from the first.
 *
 * Not re-exported from `index.ts`: that barrel is what `deploy`'s import
 * closure must stay out of, and this file reaches `deploy/plan.ts`.
 */

import { remoteEnv, remoteLayout, type RemoteLayout } from "../deploy/plan.ts";
import { formatProblem, parseTarget, type Target } from "../deploy/target.ts";
import type { SubjectId } from "../types.ts";
import { dataMap, type DataMap } from "./map.ts";

/** One directory the remote half looks at or removes, and what it is. */
export interface RemoteTree {
  readonly label: string;
  readonly dir: string;
}

/** The remote half of an erase: where it is, and every place that would be there. */
export interface RemoteErasePlan {
  readonly subject: SubjectId;
  readonly target: Target;
  /** One line a person can check against the machine they meant. */
  readonly machine: string;
  readonly layout: RemoteLayout;
  readonly map: DataMap;
}

export type RemoteTargetResult =
  | { readonly ok: true; readonly plan: RemoteErasePlan }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Where the machine is, in the words the target file used. No key, no secret: the target holds none. */
export function describeMachine(target: Target): string {
  switch (target.provider) {
    case "ssh":
      return `${target.name} — ssh ${target.ssh.user}@${target.ssh.host}:${target.ssh.port}`;
    case "gcp":
      return `${target.name} — gcp ${target.gcp.project}/${target.gcp.zone}`;
    case "aws":
      return `${target.name} — aws ${target.aws.region}`;
  }
}

/** The remote half for `subject`, from a target already parsed. */
export function remoteErasePlan(target: Target, subject: SubjectId): RemoteErasePlan {
  const layout = remoteLayout(subject);
  const env = remoteEnv(layout);
  const map = dataMap(env, subject, layout.agentDir);
  return {
    subject,
    target,
    machine: describeMachine(target),
    layout,
    map,
  };
}

/** The remote half from the text of a target file — the same file `deploy plan` reads. */
export function parseRemoteTarget(text: string, path: string, subject: SubjectId): RemoteTargetResult {
  const parsed = parseTarget(text, path);
  if (!parsed.ok) return { ok: false, problems: parsed.problems.map((problem) => `${path}: ${formatProblem(problem)}`) };
  return { ok: true, plan: remoteErasePlan(parsed.target, subject) };
}

/** The directories that would be removed there, in erase's order. */
export function remoteTrees(plan: RemoteErasePlan): readonly RemoteTree[] {
  return [...plan.map.trees, plan.map.ledger].map((tree) => ({ label: tree.label, dir: tree.dir }));
}

/** The lines the dry run prints for the remote half. */
export function formatRemotePlan(plan: RemoteErasePlan): string[] {
  const lines = [`remote — ${plan.machine}`, `  volume ${plan.layout.volume} · agent ${plan.layout.agentDir}`];
  for (const tree of remoteTrees(plan)) lines.push(`  ${tree.label}`, `    ${tree.dir}`);
  lines.push(
    "  Nothing on the remote has been looked at or changed: this is where erase will look, from the " +
      "same resolver as the local half evaluated with the remote's roots.",
  );
  return lines;
}
