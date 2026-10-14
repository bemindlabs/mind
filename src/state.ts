/**
 * The one place Mind is allowed to keep state outside a repository.
 *
 * Two things now live out here — the originals `soul apply` copies before it
 * writes, and the turn ledger (ADR 0002 §3) — and they landed here for the
 * same two reasons. Neither can be derived from what git holds, so `.mind/`
 * would delete them on the next rebuild (I-2); and both are the owner's to
 * withdraw, so git, which remembers what it is asked to forget, is the one
 * place they must not go (I-4).
 *
 * The rule this file exists to enforce is narrower than "share a helper": the
 * two callers must agree on *the same root*, because `mind erase` (S7.2) has
 * to be able to name one directory and mean all of it. When the XDG logic was
 * written twice, the second copy was one typo away from a tree nothing would
 * ever look in again.
 *
 * Nothing here reads `process.env` or `homedir()`. Both arrive as arguments so
 * a test can point the whole tree at a temporary directory and be certain it
 * did — the same reason `ApplyEnv` exists.
 */

import { isAbsolute, join } from "node:path";

/** Mode for directories under the state root. Nobody else's business. */
export const STATE_DIR_MODE = 0o700;
/** Mode for files under the state root. Identity and conversation, not world-readable. */
export const STATE_FILE_MODE = 0o600;

/**
 * `$XDG_STATE_HOME/mind`, or `~/.local/state/mind` when it is unset.
 *
 * An empty or relative `XDG_STATE_HOME` counts as unset ({@link xdgBase}).
 *
 * @param home Absolute path to the home directory to resolve against.
 * @param env Environment to read `XDG_STATE_HOME` from.
 */
export function stateRoot(home: string, env: Readonly<Record<string, string | undefined>>): string {
  return join(xdgBase(env["XDG_STATE_HOME"], join(home, ".local", "state")), "mind");
}

/**
 * An XDG base directory, or the default when the variable may not be used.
 *
 * The spec: *"All paths set in these environment variables must be absolute. If an implementation
 * encounters a relative path in any of these variables it should consider the path invalid and ignore
 * it."* Until S15.8's review this file honoured a relative value, so `XDG_DATA_HOME=data mind key …`
 * wrote a private key under whatever directory the command ran in — and `erase`, run from anywhere
 * else, resolved a different tree and never found it. Empty counts as unset too: it is the shape an
 * unset variable takes when a shell script that meant to set it exported it anyway.
 */
export function xdgBase(configured: string | undefined, fallback: string): string {
  return configured !== undefined && configured !== "" && isAbsolute(configured) ? configured : fallback;
}

/**
 * `$XDG_DATA_HOME/mind`, or `~/.local/share/mind` when it is unset.
 *
 * The second root, and the one S0.4 AC4 is about. State is what Mind writes
 * about itself — backups, the ledger, things a fresh machine can live without.
 * Data is the owner's: what lands under here is flagged `personal`, which is
 * the one category that must not be inside an agent's repository at all, not
 * even ignored (D-014). `.gitignore` is a request; a different filesystem tree
 * is a fact, and `git clean -fdx` and `cp -r .` both prove the difference.
 *
 * Same rule as {@link stateRoot}: empty or relative is unset ({@link xdgBase}).
 */
export function dataRoot(home: string, env: Readonly<Record<string, string | undefined>>): string {
  return join(xdgBase(env["XDG_DATA_HOME"], join(home, ".local", "share")), "mind");
}

/**
 * The two things no `forget` and no `purge` under either root can reach,
 * because they are facts about the medium rather than about Mind.
 *
 * I-4 has two halves and the second is the one that is usually skipped: *do
 * not claim to delete what cannot be deleted*. `ledger forget` printed these
 * two lines first; S3.5's `observe purge` has to print the same two, because
 * they are true for exactly the same reason — and a second copy of the words
 * would be two copies to keep honest instead of one. The wording that differs
 * between callers is the only part that is a parameter.
 *
 * What Mind deliberately does **not** do is overwrite the old bytes. On an
 * SSD, a journalling filesystem or a snapshotting one, a `shred` rewrites a
 * different block and leaves the original where it was: it buys no safety and
 * sells a great deal of confidence. What Mind will say instead is what it
 * can actually check — search the tree afterwards and the text is not there.
 *
 * @param occupant What the freed blocks held, in the caller's own words —
 *   `"these lines"` for a ledger, `"these records"` for the observer.
 * @param tree The directory a snapshot would have copied, named the way the
 *   caller names it elsewhere in the same output.
 */
export function mediaUndeletable(occupant: string, tree: string): readonly string[] {
  return [
    `the blocks ${occupant} occupied — a rename frees space without overwriting it, and on an ` +
      `SSD, a journal or a filesystem snapshot (btrfs, zfs) the original bytes may survive. ` +
      `Mind does not run shred, because on this kind of media shred cannot keep the promise ` +
      `either.`,
    `backups or snapshots of ${tree} taken by anything else on this machine.`,
  ];
}
