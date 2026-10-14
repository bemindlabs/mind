/**
 * Where an agent's own signing key lives (S15.8, D-108, D-138) — the address alone.
 *
 * Apart from `key.ts` on purpose, the way `src/web/push-dir.ts` is apart from `push.ts`: the data map
 * (`src/erase/map.ts`) names this directory, and everything the map imports is read by `erase` and by
 * `deploy plan`, whose import closures hold no process, no socket and no key material. A `join` is all
 * either of them needs.
 *
 * `$XDG_DATA_HOME/mind/<subject>/identity/` — under the data root, beside `personal/` rather than in it
 * (D-138). The data root because a key cannot be made again: a new one is a different agent to everyone who
 * knew the old public key, which is the test D-014 uses for "data, not state". Beside `personal/` because
 * that tree is the owner's personal data — capture, proposals, needles — and a credential is not; the map
 * lists it as its own entry, so erase and deploy each name it.
 */

import { join } from "node:path";
import { dataRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

export const IDENTITY_DIR = "identity";

/** The private key: PKCS#8 PEM, mode 600, in a 700 directory. `openssl pkey -in <it> -pubout` reads it. */
export const KEY_FILE = "ed25519.pem";

/** This subject's identity directory. `erase` removes it whole; pure, so deploy can ask it of the remote's roots. */
export function identityDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(dataRoot(env.home, env.env), subject, IDENTITY_DIR);
}

export function keyPath(identityDir: string): string {
  return join(identityDir, KEY_FILE);
}

/**
 * What erasing the key cannot reach (I-4's second half), printed with the `soul` place.
 *
 * The key goes; what it signed does not come back. A signed report is meant to be checkable by whoever holds
 * it without asking this machine, so there is nothing here to revoke it with.
 *
 * Worded without the word "private": `mind new` prints this, and there that word is kept for what git
 * cannot see about a remote (`test/cli/guard.test.ts`).
 */
export const IDENTITY_UNDELETABLE: readonly string[] = [
  "the agent's public key wherever it was published — the agent card a peer fetched, a marketplace " +
    "listing — and every usage report its signing key signed, wherever it was sent or saved. Those stay " +
    "verifiable by anyone who has them; erasing the key here only means nothing new can be signed with it.",
];
