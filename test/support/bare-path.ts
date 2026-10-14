/**
 * "The vendor CLIs are off PATH" — as one piece of code, checked rather than
 * assumed.
 *
 * Two test files need the same condition for I-1 / S2.1 AC6, and they had two
 * copies of it that had already drifted apart: one built a directory holding a
 * single symlink to `bun`, the other handed the child the directory `bun`
 * itself lives in — which is where `bun add -g` installs global packages, so
 * `bun add -g @anthropic-ai/claude-code` would have made "off PATH" quietly
 * false and the test would have gone on passing.
 *
 * So the PATH is built here, and the claim about it is *asserted* here, for
 * every vendor in the registry rather than the two anybody happened to think
 * of. A precondition that is not checked is not a precondition; it is a hope.
 */

import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { VENDORS } from "../../src/exec/registry.ts";

/** The `bun` this test run is using, which the child processes need too. */
export const BUN = Bun.which("bun") ?? "bun";

/**
 * A PATH holding one symlink to `bun` and nothing else.
 *
 * Deliberately *not* `dirname(BUN)`: that directory is shared with whatever
 * else has been installed globally, and the whole point is a directory whose
 * contents this test wrote.
 *
 * Idempotent, so a caller that needs the path again does not have to keep a
 * copy of it — two copies of a path is how the two copies of this helper
 * drifted apart in the first place.
 *
 * @param home directory to build it under — a temporary one in every caller.
 */
export async function barePath(home: string): Promise<string> {
  const bare = join(home, "bare-bin");
  await mkdir(bare, { recursive: true });
  try {
    await symlink(BUN, join(bare, "bun"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  return bare;
}

/**
 * Assert that no vendor CLI Mind knows about is reachable from `path`.
 *
 * Throws with the vendor's name and the path that was found, because "some
 * binary was reachable" is not actionable and "grok is at /usr/local/bin/grok"
 * is. Call it before asserting anything that depends on the absence.
 */
export function expectNoVendorOn(path: string): void {
  const found = VENDORS.map((spec) => [spec.binary, Bun.which(spec.binary, { PATH: path })] as const)
    .filter(([, resolved]) => resolved !== null)
    .map(([binary, resolved]) => `${binary} → ${resolved}`);

  if (found.length > 0) {
    throw new Error(
      `PATH ${JSON.stringify(path)} was supposed to hold no vendor CLI, but ` +
        `${found.length} of ${VENDORS.length} resolved: ${found.join(", ")}`,
    );
  }
}
