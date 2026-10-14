/**
 * Who answered, in the owner's words — the per-turn facts S12.4 puts under
 * every assistant bubble and in the Engine box.
 *
 * "Local" here is a statement about where a backend *runs*, made from its id
 * alone, for a page that renders ids. The rule: `ollama` — the HTTP backend on
 * this machine — and any id ending in `-local`, the ids S12.1 gives the vendor
 * CLIs chained over LiteLLM on this machine (`claude-local`, `grok-local`).
 * Everything else is a cloud backend: a vendor CLI whose whole purpose is to
 * reach a service somewhere else.
 *
 * ## Why an id rule, and not `asLocal`
 *
 * `src/exec/local.ts` already answers "is this backend local" — by `instanceof`
 * and a loopback-literal host check, because it is deciding whether *personal
 * data* may be handed over, where a copied id is a forged passport. This file
 * is rendering a badge. The badge's question is coarser — "did this turn run
 * on this machine or leave it" — and its only input is the backend id a turn
 * result, a ledger line or a settings choice carries. Re-running the runtime
 * check here would need the backend object, which none of those places keep;
 * and the ids S12.1 adds (`claude-local`, `grok-local`) are `CliExec`s that
 * talk to a loopback LiteLLM, which `asLocal` refuses outright. So the display
 * rule is its own one-line function, tested on its own, and it is deliberately
 * *not* reused by the personal-data door: a badge that is wrong by a corner
 * case misleads one reading; that door being wrong by one leaks.
 *
 * The same rule is written once more, by hand, in the page script in
 * `page.ts` — a template literal cannot import this module — and the two are
 * kept in agreement by the tests of both (`test/web/turninfo.test.ts` and the
 * page pins in `test/web/web.test.ts`).
 */

/**
 * Whether a backend id names a backend that runs on this machine: `ollama`,
 * or any id ending in `-local` (S12.1's `claude-local`, `grok-local`).
 */
export function isLocalBackend(id: string): boolean {
  return id === "ollama" || id.endsWith("-local");
}
