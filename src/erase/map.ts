/**
 * The data map (S7.1, D-050) as one list: every place a SubjectId resolves to.
 *
 * `planErase` built this list inline, and until S13.1 that was the only
 * reader. `mind deploy plan` needs the same list — *what of this subject's
 * is on this machine, and where would it be on another* — and a second copy of
 * it in `src/deploy/` would be the drift D-042's confirmations already showed:
 * a place one list knows and the other does not. So the list lives here, erase
 * removes what it names, and deploy moves what it names. `test/erase/data-map.test.ts`
 * holds the two readers to the same entries.
 *
 * ## Every entry says how it travels
 *
 * D-100 widened "on this machine" to "on a machine the owner controls", with
 * the condition that the data map includes the remote (#2). So each entry
 * carries a required {@link Travel}: whether it goes inside the agent's git
 * repository, is copied to the encrypted volume there, is rebuilt there from
 * git, or stays here — with the reason. Required, not defaulted, so a place
 * added to this file cannot be added without somebody deciding whether it
 * leaves the machine.
 *
 * ## Places that are not one subject's
 *
 * The local backends' homes (`vendors/claude-local`, `vendors/grok-local`) hold the vendor CLI's transcripts of every
 * subject that ran a turn there, and nothing in them says whose is whose. They are listed in {@link DataMap.shared},
 * apart from the subject's own trees, because erase asks a question about them that it never asks about a tree of
 * the subject's: *is this subject tied to this home?* (`local-cli-plan.ts`). A place missing from this list is a place
 * `erase` neither plans nor removes, and `test/erase/local-cli.test.ts` runs a real local turn to see that none is.
 *
 * ## Pure
 *
 * Nothing here touches the filesystem: every resolver is a `join` over the
 * roots it is handed. That is what lets deploy evaluate the same list with the
 * remote's roots and get the remote's paths — by construction the ones the
 * engine there will resolve, because they are the same functions. The one
 * question with I/O in it — is the personal directory inside a git repository?
 * — stays with `personalDir`, and erase asks it.
 *
 * Its import closure reaches no subprocess and no socket, and `test/deploy/
 * no-network.test.ts` checks that, because `src/deploy/` reads this file.
 */

import { a2aDirFor } from "../a2a/peers.ts";
import { browserDirFor } from "../browser/paths.ts";
import { botsDirFor } from "../connectors/bot-consent.ts";
import { chatDirFor } from "../connectors/users.ts";
import { basisDirFor } from "../consent/basis.ts";
import { confirmationsDirFor } from "../decide/confirm.ts";
import { runsDirFor } from "../decide/runs.ts";
import { triggersDirFor } from "../decide/triggers.ts";
import { personalPath } from "../guard/personal.ts";
import { identityDirFor } from "../identity/dir.ts";
import { ledgerDir } from "../ledger/store.ts";
import { collectionFor } from "../memory/collection.ts";
import { ragDirFor } from "../memory/marker.ts";
import type { SubjectId } from "../types.ts";
import { pushDirFor } from "../web/push-dir.ts";
import { localCliHomeDir, type LocalCliHomeId } from "./local-cli-homes.ts";
import type { PlaceId } from "./place-id.ts";
import { backupTree, derivedTree, soulTree } from "./soul.ts";

/** The roots a resolver reads. This machine's, or the remote's. */
export interface MapEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** What happens to one place when the agent moves to a machine the owner controls (D-100). */
export type Travel =
  /** It is inside the agent's repository, and a clone carries it. */
  | { readonly kind: "in-git" }
  /** Copied onto the encrypted volume there, at the same resolver evaluated with the remote's roots. */
  | { readonly kind: "copied" }
  /** Not copied: the engine there makes its own from what git holds. */
  | { readonly kind: "rebuilt"; readonly how: string }
  /** Not copied, and not made there either: it describes this machine. */
  | { readonly kind: "stays"; readonly why: string };

/** One name per entry, stable, so a reader can find an entry without matching its label. */
export type MapKey =
  | "soul"
  | "derived"
  | "backups"
  | "confirmations"
  | "rag-marker"
  | "runs"
  | "browser"
  | "triggers"
  | "a2a"
  | "chat"
  | "bots"
  | "push"
  | "basis"
  | "personal"
  | "identity"
  | "ledger"
  | "local-claude"
  | "local-grok";

/** One directory of the map. */
export interface MapTree {
  readonly key: MapKey;
  readonly place: PlaceId;
  /** The words erase's plan and certificate print for it. */
  readonly label: string;
  readonly dir: string;
  readonly travel: Travel;
}

/**
 * A place that holds text of whichever subjects used it, and is not keyed by any of them.
 *
 * The vendor CLI behind a local backend runs in one home of Mind's own per backend, for every subject: its session
 * transcripts, prompt history and scratch files are filed by the vendor's own ids and the directory a turn ran in,
 * and neither says who asked (S7.1, I-4). So it cannot sit in {@link DataMap.trees}, whose every entry
 * is one subject's and is removed for that subject without a question. Erase asks one first — is this subject tied
 * to this home? — and removes it whole when it is, and says so (`local-cli-plan.ts`).
 */
export interface SharedTree extends MapTree {
  readonly key: "local-claude" | "local-grok";
  /** The backend whose turns write here. A ledger line naming it is what ties a subject to the home. */
  readonly backend: LocalCliHomeId;
}

/** The whole map for one subject: the trees, and the places that are not a tree of that subject's. */
export interface DataMap {
  /** What erase removes whole, in the order it lists them. */
  readonly trees: readonly MapTree[];
  /**
   * The local backends' homes: every subject's turns write there, so none is this subject's alone. Listed so the map
   * is every place a subject's text can be; erase removes one only when the subject is tied to it.
   */
  readonly shared: readonly SharedTree[];
  /** The turn ledger. Erase empties it line by line (`planForget`); here it is one directory. */
  readonly ledger: MapTree;
  /** The subject's vector collection — in Qdrant, by name, not on this disk (D-038). */
  readonly collection: { readonly place: PlaceId; readonly name: string; readonly travel: Travel };
  /** Mind's blocks inside vendor instruction files — somebody else's files (S1.2). */
  readonly blocks: { readonly place: PlaceId; readonly label: string; readonly travel: Travel };
}

const IN_GIT: Travel = { kind: "in-git" };
const COPIED: Travel = { kind: "copied" };

/**
 * The trees erase removes whole, in its order.
 *
 * `withSoul` is false for `erase --personal`, which keeps `soul/` in git and
 * takes `person.md` alone — a file, which erase plans itself. It keeps the
 * agent's signing key too, for the same reason it keeps `role.md`: the key is
 * the agent's identity, not the person's data (S15.8 review; D-138).
 */
export function subjectTrees(
  env: MapEnv,
  subject: SubjectId,
  agentDir: string | null,
  withSoul: boolean,
): readonly MapTree[] {
  const trees: MapTree[] = [];

  if (agentDir !== null) {
    if (withSoul) {
      trees.push({ key: "soul", place: "soul", label: "the soul in git", dir: soulTree(agentDir), travel: IN_GIT });
    }
    trees.push({
      key: "derived",
      place: "soul",
      label: "the derived directory",
      dir: derivedTree(agentDir),
      travel: {
        kind: "rebuilt",
        how:
          "`mind rebuild` and `memory index` there, from what git holds — derived, never the " +
          "source (I-2)",
      },
    });
  }

  trees.push({
    key: "backups",
    place: "soul",
    label: "the apply backups",
    dir: backupTree(env, subject),
    travel: {
      kind: "stays",
      why:
        "the originals of this machine's vendor instruction files, copied before `soul apply` wrote " +
        "to them. No vendor file goes from here (vendor logins stay, D-109), so there is nothing " +
        "there for them to restore",
    },
  });
  // Who confirmed level 3 for this subject's dial, and when (D-042).
  trees.push({
    key: "confirmations",
    place: "soul",
    label: "the level-3 confirmations",
    dir: confirmationsDirFor(env, subject),
    travel: {
      kind: "stays",
      why:
        "level 3 counts only where a person confirmed it on that machine (D-042), and each record " +
        "is keyed by this machine's path to the soul, so a copy would not count there anyway. " +
        "Confirm again on the remote",
    },
  });
  // The record that a vector collection was written for this subject. It names
  // the subject, so it goes like any other tree; erase reads it first.
  trees.push({
    key: "rag-marker",
    place: "rag",
    label: "the record of where vectors were written",
    dir: ragDirFor(env.home, env.env, subject),
    travel: {
      kind: "rebuilt",
      how:
        "written there by `memory index` when it reaches a vector store there. It records where " +
        "*this* machine wrote vectors; a copy would send erase on the remote to a store it never " +
        "wrote to",
    },
  });
  // The run records (S5.4). Under `ledger`: the same fact the ledger holds, a
  // turn, keyed by the same turn id — only still in flight.
  trees.push({
    key: "runs",
    place: "ledger",
    label: "run records for turns that were in flight",
    dir: runsDirFor(env, subject),
    travel: {
      kind: "stays",
      why:
        "turns in flight on this machine, by process id. A pid means nothing on another machine, " +
        "and `mind stop` there must not act on one",
    },
  });
  // Browser tasks (D-151): each one's record (the container, its port and token, the allowlist) and the
  // vendors' MCP config files pointing at it. The recording itself is under personal/. `erase` docker-kills
  // the containers first (plan.ts).
  trees.push({
    key: "browser",
    place: "ledger",
    label: "browser task records and their MCP config (containers are docker-killed first)",
    dir: browserDirFor(env, subject),
    travel: {
      kind: "stays",
      why:
        "a record names a container on this machine and a loopback port on it; there it means nothing, and " +
        "`mind stop` there must not act on one",
    },
  });
  // When each scheduled trigger last fired (S5.3 AC6).
  trees.push({
    key: "triggers",
    place: "ledger",
    label: "when each trigger last fired",
    dir: triggersDirFor(env, subject),
    travel: {
      kind: "stays",
      why:
        "keyed by this machine's path to the agent: a clone elsewhere starts with nothing fired " +
        "(S5.3), so the first tick there runs whatever is due",
    },
  });
  // The A2A peer list (D-063), with the tokens issued to them.
  trees.push({ key: "a2a", place: "ledger", label: "the A2A peers and their tokens", dir: a2aDirFor(env, subject), travel: COPIED });
  // Who the agent answers in chat apps, and who has been told it is an AI (D-066).
  trees.push({ key: "chat", place: "ledger", label: "the chat allowlist and who has been told", dir: chatDirFor(env, subject), travel: COPIED });
  // Which bots Mind may answer, and the approval typed for each (S9 AC5, p5).
  trees.push({ key: "bots", place: "ledger", label: "the bots Mind may answer, and the approval for each", dir: botsDirFor(env, subject), travel: COPIED });
  // D-130: the relay handles of the phones told when something waits.
  trees.push({ key: "push", place: "ledger", label: "the phones told when something is waiting (push handles)", dir: pushDirFor(env, subject), travel: COPIED });
  // Who approved this subject's data coming in, and for what (S7.3, D-077).
  // It has to go where the data goes, or ingest there reads nothing.
  trees.push({ key: "basis", place: "ledger", label: "the basis records for taking this subject's data in", dir: basisDirFor(env, subject), travel: COPIED });
  // Raw capture, the proposal store, the egress needles, the A2A inbox.
  trees.push({
    key: "personal",
    place: "observer",
    // Named for what goes, not for the place id it is counted under: a
    // certificate that said "observer record" while removing somebody's
    // proposals would be claiming to have deleted less than it deleted.
    label: "the personal directory (raw capture and the proposal store live under it)",
    dir: personalPath(env, subject),
    travel: COPIED,
  });
  // The agent's own ed25519 key (S15.8, D-108, D-138) — beside personal/, not in it: a credential, not
  // somebody's personal data. Copied, because the agent there is the same agent: a new key would be a
  // different signer to everyone who knew this one. On the encrypted volume, like everything copied.
  // Gated like `soul/`: a full erase of the subject takes it, `--personal` keeps it and says so.
  if (withSoul) {
    trees.push({
      key: "identity",
      place: "soul",
      label: "the agent's own ed25519 signing key",
      dir: identityDirFor(env, subject),
      travel: COPIED,
    });
  }

  return trees;
}

/** One local backend's home as a map entry. */
function localHome(env: MapEnv, backend: LocalCliHomeId, key: SharedTree["key"], what: string): SharedTree {
  return {
    key,
    place: "ledger",
    label: `the ${backend} home — ${what} its turns left (shared by every subject, so removed whole)`,
    dir: localCliHomeDir(env, backend),
    backend,
    travel: {
      kind: "stays",
      why:
        "the vendor CLI's own home on this machine. Vendor CLIs and what they keep do not go (D-109, S13.7): " +
        "a local turn there makes its own home, and a copy would carry other subjects' text along with this " +
        "one's, since nothing in it says whose it is",
    },
  };
}

/** The homes of the local backends (S7.1): where a vendor CLI writes the transcript of a turn Mind ran on it. */
function sharedTrees(env: MapEnv): readonly SharedTree[] {
  return [
    localHome(env, "claude-local", "local-claude", "the vendor session transcripts, prompt history and tool output"),
    localHome(env, "grok-local", "local-grok", "the vendor session logs, history and scratch files"),
  ];
}

/** Every place this subject's data lives, under `env`'s roots and in `agentDir`. */
export function dataMap(env: MapEnv, subject: SubjectId, agentDir: string | null): DataMap {
  return {
    trees: subjectTrees(env, subject, agentDir, true),
    shared: sharedTrees(env),
    ledger: {
      key: "ledger",
      place: "ledger",
      label: "the turn ledger",
      dir: ledgerDir(env, subject),
      travel: COPIED,
    },
    collection: {
      place: "rag",
      name: collectionFor(subject),
      travel: {
        kind: "rebuilt",
        how:
          "`memory index` there embeds memory/ again when bge-m3 and a Qdrant answer there. A VPS " +
          "has no GPU (D-100); until S13.6 reaches the model at home, recall there is full-text only",
      },
    },
    blocks: {
      place: "soul",
      label: "Mind's block in each vendor instruction file `soul apply` wrote to",
      travel: {
        kind: "stays",
        why:
          "they sit inside this machine's vendor files. Vendor CLIs and their logins do not go " +
          "(D-109, S13.7), so there is no file there to put one in",
      },
    },
  };
}
