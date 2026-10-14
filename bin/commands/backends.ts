/** `mind backends` — what this machine can reach, and how identity lands. */

import {
  EGRESS_LIMITS,
  VENDORS,
  allBackends,
  expandPath,
  isProjectScopedOnly,
  readOnlySummary,
  readonlyLimits,
  vendor,
} from "../../src/exec/index.ts";
import { isLocalCliId, localBaseVendor } from "../../src/exec/local-cli.ts";
import { bold, dim } from "../shared.ts";

const MARK: Record<string, string> = { ok: "OK", no: "--" };

export async function cmdBackends(): Promise<number> {
  const backends = allBackends();
  const checks = await Promise.all(
    backends.map(async (b) => ({ b, availability: await b.available() })),
  );

  console.log(bold("backend      reach    identity  writes?          where the identity lives"));
  for (const { b, availability } of checks) {
    // A local backend (claude-local, grok-local — E12) is a vendor CLI on the local model: its flags are that
    // vendor's, and its identity file is in a home of its own under the state root, never yours (D-117).
    const local = isLocalCliId(b.id);
    const spec = b.id === "ollama" ? undefined : vendor(local ? localBaseVendor(b.id) : b.id);
    const where =
      spec === undefined
        ? "system prompt field (no file needed)"
        : local
          ? `${spec.id}'s file, in a home of its own under the state root — not yours; every turn fenced (D-118)`
          : spec.identity.instructionFiles
              .map((f) => expandPath(f))
              .join(", ") + (isProjectScopedOnly(spec) ? "  [per project only]" : "");

    console.log(
      `${b.id.padEnd(12)} ${(availability.ok ? MARK["ok"] : MARK["no"])!.padEnd(8)} ` +
        `${b.identityStrength.padEnd(9)} ` +
        // The local backend is an HTTP model with no tool loop to filter, so
        // it is not "guarded" — there is nothing there to guard.
        `${(spec === undefined ? "no (no tools)" : readOnlySummary(spec)).padEnd(16)} ${where}`,
    );
    if (!availability.ok) console.log(dim(`             ${availability.detail}`));
  }

  const reachable = checks.filter((c) => c.availability.ok).length;
  console.log();
  console.log(dim(`${reachable}/${checks.length} reachable.`));

  // The distinction this whole project turns on, stated where someone will
  // actually read it.
  const weak = VENDORS.filter((v) => v.identity.strength !== "system");
  if (weak.length > 0) {
    console.log(
      dim(
        `${weak.length} of ${VENDORS.length} vendor CLIs take an identity only as ` +
          `user-level text (${weak.map((v) => v.id).join(", ")}) — weaker than a ` +
          `system prompt. Mind reports that rather than flattening it.`,
      ),
    );
  }

  // The `writes?` column above is the short answer, and a short answer about
  // somebody else's program needs its limits beside it — the same rule the
  // guard and the scan already follow. Derived from the registry, so a vendor
  // whose hole is closed stops being named here without anyone editing prose.
  console.log();
  console.log(dim("What the read-only flags do not cover:"));
  for (const note of readonlyLimits()) console.log(dim(`  - ${note}`));

  // The table above is a list of places a prompt can be sent, so this is where
  // the limits of the one-line notice `turn` prints before each send belong.
  // Every limits list in this repo has a command that prints it; this one is
  // no exception, and the notice itself stays one line because of it.
  console.log();
  console.log(dim("What the notice before each cloud turn does not do:"));
  for (const note of EGRESS_LIMITS) console.log(dim(`  - ${note}`));

  // Reachability is information, not a verdict: a machine with only a local
  // model is a supported machine, not a broken one.
  return 0;
}
