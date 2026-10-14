/**
 * `mind update [--check] [--yes]` — find a newer release and install it
 * (D-065). Also the once-a-day automatic check the entry point runs after a
 * command.
 *
 * `--check` only asks. Without `--yes` the update says what it would replace
 * and stops, the way `soul apply` and `erase` do. With `--yes` it downloads the
 * build for this machine, checks the cosign signature on the release's SHA256SUMS
 * and then the build against that list, and renames it over the running binary.
 * From the first signed release on a missing or failing signature refuses
 * (`src/update/signature.ts`; the same rules as `install.sh`). Running from a
 * checkout, it says to use git instead: replacing `bun` would be a disaster,
 * and the source is not a binary to swap.
 */

import { homedir, tmpdir } from "node:os";
import { engineCommand } from "../../src/guard/hooks.ts";
import { runGuarded } from "../../src/spawn.ts";
import { stateRoot } from "../../src/state.ts";
import { fetchLatest, installRelease } from "../../src/update/install.ts";
import { findCosign, requirementLine, signatureLine, type SignatureEvent } from "../../src/update/signature.ts";
import { assetFor, autoCheckDue, compareVersions, newerLine, parseVersion, readCheck, RELEASE_REPO, writeCheck } from "../../src/update/version.ts";
import { VERSION } from "../../src/version.ts";
import { bold, dim, dimErr, parseArgs, usageError } from "../shared.ts";

const USAGE = "usage: mind update [--check] [--yes]";

export async function cmdUpdate(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["check", "yes"]);
  if (positional.length > 0) return usageError(USAGE);
  const state = stateRoot(homedir(), process.env);

  const asked = await fetchLatest(VERSION);
  if (!asked.ok) {
    console.error(`mind: could not ask ${RELEASE_REPO} for releases: ${asked.reason}`);
    return 1;
  }
  const release = asked.release;
  await writeCheck(state, { at: new Date().toISOString(), latest: release?.version.text ?? null }).catch(() => undefined);
  const current = parseVersion(VERSION)!;
  if (release === undefined || compareVersions(release.version, current) <= 0) {
    console.log(`mind ${VERSION} is the newest release${release === undefined ? "" : ` (latest published: ${release.tag})`}.`);
    return 0;
  }
  console.log(bold(`mind ${release.version.text} is available — you have ${VERSION}.`));
  if (release.url !== "") console.log(`  ${release.url}`);
  if (options.has("check")) return 0;

  const command = engineCommand().argv;
  if (command.length > 1) {
    console.log(`This is running from a checkout (${command.slice(1).join(" ")}), not an installed binary. Update it with git:`);
    console.log("  git pull && bun install");
    return 0;
  }
  const target = process.execPath;
  const asset = assetFor(process.platform, process.arch);
  if (asset === undefined) {
    console.error(`mind: there is no release build for ${process.platform}/${process.arch}.`);
    return 1;
  }
  console.log(`  would replace ${target}`);
  console.log(`  with ${asset} from ${release.tag}, after checking it against the release's SHA256SUMS`);
  console.log(`  ${requirementLine(release.tag, process.env, findCosign(process.env))}`);
  if (!options.has("yes")) {
    console.log(dim("Nothing was changed. Run `mind update --yes` to install it."));
    return 0;
  }
  const say = (event: SignatureEvent): void => (event.verified ? console.log(signatureLine(event)) : console.error(signatureLine(event)));
  const done = await installRelease(release, asset, target, VERSION, fetch, { env: process.env, scratch: tmpdir(), onSignature: say });
  if (!done.ok) {
    console.error(`mind: not updated — ${done.reason}. ${target} is unchanged.`);
    return 1;
  }
  if (process.platform === "darwin") {
    // A replaced Mach-O keeps no signature; an ad hoc one is what lets it run.
    await runGuarded(["codesign", "--force", "--sign", "-", target]).catch(() => undefined);
  }
  console.log(`Updated to ${release.version.text} (sha256 ${done.sha256.slice(0, 16)}…). Run \`mind --version\` to see it.`);
  return 0;
}

/**
 * After a command: at most once a day, when a person is at the terminal, ask
 * whether a newer release exists and say so in one line. Never throws, never
 * changes the exit code, and never runs where its line would be in the way.
 */
export async function autoCheck(argv: readonly string[]): Promise<void> {
  try {
    const state = stateRoot(homedir(), process.env);
    const due = autoCheckDue({
      env: process.env,
      interactive: process.stdin.isTTY === true,
      verb: argv[0],
      argv,
      last: await readCheck(state),
      now: new Date(),
    });
    if (!due) return;
    const asked = await fetchLatest(VERSION, fetch, 1500);
    if (!asked.ok) return;
    await writeCheck(state, { at: new Date().toISOString(), latest: asked.release?.version.text ?? null });
    const line = newerLine(VERSION, asked.release?.version.text ?? null);
    if (line !== undefined) console.error(dimErr(`mind: ${line}`));
  } catch {
    // A check that fails is a check that did not happen; the command already did.
  }
}
