/**
 * Where the two local CLI backends keep what the vendor CLI writes (S7.1, S7.2, I-4) — as a path, and nothing else.
 *
 * A turn on `claude-local` or `grok-local` runs the real vendor binary with `HOME` pointing at a home of Mind's own
 * (`<state root>/vendors/<backend>`). Everything the vendor writes while it runs — its session transcripts, its
 * prompt history, its tool output, its scratch directory — lands in that home, and a transcript holds the text of
 * the turn: the question, the soul that was sent with it, what the model said. That is a copy of a subject's text
 * outside every directory the data map names per subject, and until this file `erase` neither planned it nor
 * removed it (only its final search, which reads the whole state root, could trip over it).
 *
 * ## Why this lives here and not in `src/exec/local-cli.ts`
 *
 * Nothing under `src/erase/` may reach `src/exec/` (see `index.ts`): erasing needs no model, and a layer that could
 * reach one could send what it read on its way to deleting it (I-6). So the one rule that decides where the home is
 * — `<state root>/vendors/<id>` — is spelled here as well, and `test/erase/local-cli.test.ts` holds the two
 * spellings to each other by asking the real `LocalCliExec` where it told the vendor to write, and by running a
 * turn through it. A change to either one turns that test red.
 *
 * ## Pure
 *
 * A `join` over the roots it is handed, like every resolver of the data map. The data map (`map.ts`) lists these
 * homes, and `mind deploy plan` and erase's remote half read the same list with another machine's roots.
 */

import { join } from "node:path";
import { stateRoot } from "../state.ts";

/** The backends whose vendor CLI runs in a home of Mind's own. Equal to `LOCAL_BACKENDS` in `src/exec/local-cli.ts`; a test says so. */
export const LOCAL_CLI_HOMES = ["claude-local", "grok-local"] as const;

export type LocalCliHomeId = (typeof LOCAL_CLI_HOMES)[number];

/** The roots a home is resolved under: this machine's, or another machine's. */
export interface HomeRoots {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** `<state root>/vendors/<backend>` — the `HOME` of the vendor CLI a local turn runs. */
export function localCliHomeDir(roots: HomeRoots, id: LocalCliHomeId): string {
  return join(stateRoot(roots.home, roots.env), "vendors", id);
}
