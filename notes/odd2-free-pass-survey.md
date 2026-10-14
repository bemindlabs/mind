# odd2 — the free pass: what each checker says when it has looked at nothing

Measured 2026-09-22, bun 1.4.2, on the tree at `fa46ad6`. One question, put to
everything in this repository that decides a pass:

> If the thing it checks were missing entirely, or had never existed, what would
> it answer?

Five real bugs on 2026-09-21 had that shape. The one worth keeping in mind while
reading this note is `doctor` printing `ok clean · 0 file(s)` from the compiled
binary: `import.meta.dir` resolves inside the executable, the walk read nothing,
and three green gates and a parity harness all agreed with it.

**This round surveys and proves. It fixes nothing.** No file under `src/`,
`bin/`, `scripts/` or any existing test was changed. Two files were added: the
probe suite and the driver.

---

## How to re-run every number below

```bash
npm run typecheck
npm test -- test/odd2                    # 45 probes · the holes are `test.failing`
npm exec -- bun run notes/odd2-driver.ts # 9 rows · the probes that spawn `bun test`
npm test && npm run coverage             # the existing gates, unchanged
git status                               # the working tree, untouched
```

Two instruments, because the questions split in two:

- **`test/odd2/free-pass.test.ts`** — function calls and short CLI runs. A
  checker that holds gets an ordinary assertion and stays on as a permanent
  regression guard. A proven hole gets `test.failing` with the assertion written
  the way the checker *should* behave, so the suite is green today and goes red
  the day somebody repairs it.
- **`notes/odd2-driver.ts`** — the probes that have to run `bun test`, which
  G4-3 keeps out of the suite. It copies `git ls-files` into a `mkdtemp`, mutates
  the **copy**, and never writes to the checkout. Tracked files only, which is
  why its whole-suite rows report 1224 tests rather than this tree's 1269: until
  the two files above are committed, the copy is the suite as it stands without
  them.

Both of these files are themselves watched. `notes/` opens with the repository,
and a survey *of this machine* is exactly the document somebody types a path into
afterwards — so the suite asserts the same three things about this note and the
driver that `test/notes/sp1-note.test.ts` asserts about the SP-1 note: no home
path, no tilde path, no session id.

`bun` is not reachable directly from this session's shell, so the driver is run
through `npm exec -- bun run …`. It is TypeScript and needs no `package.json`
entry. One limit, stated rather than left to be found: `tsconfig.json`'s
`include` is `bin`, `src`, `test`, so **`notes/odd2-driver.ts` is not covered by
`npm run typecheck`**. Bun type-strips it at run time either way.

### The control the instrument needed first

`test.failing` only pins a hole if it really runs the body. Both halves are
asserted before anything else in the file, because a `test.failing` that quietly
skipped would report a pass for every hole below without executing a line of
them — the free pass, wearing the costume of the tool that hunts it.

| control | measured |
|---|---|
| `test.failing` exists in bun 1.4.2 | yes |
| a failing body is reported as a pass | yes |
| the body actually ran (flag set inside it, read by the next test) | yes |
| an **async** body is awaited before the next test begins | yes (a 50 ms sleep inside it moves the suite's wall clock) |

Two CLI probes were still moved out of `test.failing` and into `beforeAll`. A
`test.failing` whose body throws *before reaching its assertion* reports exactly
the same pass as one whose assertion failed, so the measurement is taken once in
a hook and the assertion that pins the hole is synchronous — with a separate
ordinary test asserting the probe ran at all.

### The driver's own controls

| control | required | measured |
|---|---|---|
| an unmutated copy runs `test/agent/no-vendor.test.ts` green | green, > 0 tests | green, 3 tests, 23 ms |
| the mutation reaches the **assertions**, not only the imports | red | red — the failure is the third test's `spawn.ts`-in-closure check |
| every run reports `Ran N tests` with N > 0 | else driver failure | held on every row |
| the checkout is never written | `git status` clean | clean |

---

## The count, plainly

**9 free passes** proven by measurement, **1 inverted case** (a check that would
*fail* for free), and **15 checkers that hold**, each with the guard clause that
makes them hold pinned by a test.

Counting rule, per your ruling: a pass issued over nothing is a hole **whether
or not today's code can reach that state**. Reachability is recorded as a
measured field and orders the list; it does not decide membership.

---

## 1 · Holes, grouped by the invariant each checker guards

### I-4 — the owner can always withdraw

#### H1 · `erase` certifies a subject that never existed — exit 0

The largest thing found this round, and the only one that issues a document.

```
$ mind erase never-existed --no-agent --by odd2 --yes      # in a fresh home
verdict      erased-and-verified
places       3 of 3 places that exist were visited · 2 of 5 are not built (…)
verification remaining 0 file(s) · 0 failure(s) · 0 hit(s) where there must be
             none · 0 hit(s) in git-tracked files
$ echo $?
0
```

`verifyErase` (`src/erase/plan.ts:530`) decides `clean` from five counts:
remaining files, failed deletions, deletable hits, git hits, personal hits.
Every one of them reads zero for "it was cleaned" **and** zero for "there was
never anything to clean", and there is no sixth arm for "could not look". ADR
0001 §2 is the rule being broken: `silent` must not collapse into `failed`, and
here "nothing was scanned" collapses into "nothing is there".

The evidence the function threw away is in its own hands. `ScopeResult` carries
`filesRead`, and on this run every scope came back **0** — measured, not
inferred (`the run that earns the verdict reads no file at all`).

- **Reachability: full, one command, no repository needed.** `--no-agent` is on
  the usage line; the two roots searched are `$XDG_STATE_HOME/mind` and
  `$XDG_DATA_HOME/mind`, both absent in a fresh home.
- **Who is fooled:** whoever is handed the certificate. This is the document
  that answers "did you delete my data?", and exit 0 is what a script sees.
- **Proof:** `a verdict is not erased-and-verified when nothing was read`,
  `the CLI does not issue that certificate either`, `and the exit code a script
  reads is not a success`.

#### H2 · the certificate drops the one number that would tell them apart

`certificate()` copies four counts and `ran: verification !== null` out of the
verification. `ran` is true whenever the function was **called**. `filesRead`
never reaches the document, so the certificate for a real erase and the
certificate above are, in their verification section, the same four zeros.

- **Reachability:** same as H1.
- **Proof:** `the certificate says how much was read, not only what was found`.

#### H1 and H2 · closed by fix1, 2026-09-22

Appended rather than rewritten: what a survey recorded is worth keeping beside
what was done about it. The four `test.failing` probes for H1 and H2 are
ordinary tests now, and `verifyErase` grew the arm it was missing — though not
the one this note would have predicted.

**The rule is not `filesRead === 0`.** That number turns all four probes green
and leaves the worst case open: an id **mistyped by one character**, on a
machine holding somebody else's data under the correct spelling, reads plenty of
files, finds nothing, removes nothing, and used to collect the same certificate.
`erased-and-verified` therefore requires that something was *removed*, and a run
that found nothing and removed nothing is `nothing-found` — its own verdict,
exit **3**, with a document that says in words that it is not a certificate of
erasure. `filesRead` is on that document per scope as evidence of how much was
looked at, which is what H2 asked for; it is not what decides.

Two more arms of the same family went with it: a scope that could not be read no
longer counts as clean, and an empty directory named for the subject counts as
something removed (measured — a census cannot see one at all, so `rmdir`
succeeding is the only evidence it was there).

H3 is still open, and its `test.failing` still pins it.

#### H3 · `planErase` reports a commit count for a directory that is no repository

`historyFacts` has no "could not look" arm — `git rev-list` failing yields
`commits: 0, remotes: []` — and it never claimed one. The question odd2 asks is
what each caller does with that, and the three callers disagree:

| caller | what it does | verdict |
|---|---|---|
| `doctor` (`src/doctor.ts:905`) | asks `enclosingGitRepo` **first**, and warns that "a commit count and a remote list read out of it would both come back empty whether or not that was true" | **tight** |
| `guard status` | nothing — but `hookStatus` throws on a non-repository before the count is reached | tight **by accident** |
| `planErase` (`src/erase/plan.ts:350`) | `historyFacts(agentDir).catch(() => null)` — which never fires, because `runGuarded` returns a non-zero code rather than throwing | **hole** |

So the certificate prints `git 0 commit(s) · no remote configured` about a
repository that does not exist, and `agent.examined` is `true` beside it.

- **Reachability: measured, and it needs a contrivance.** `--agent <dir>` is
  refused unless `<dir>/soul/role.md` parses, and `mind new` always makes a git
  repository — so the state needs a soul copied somewhere that is not one. The
  probe builds exactly that.
- **Who is fooled:** a reader of the certificate, told that a history was
  counted. Also worth flagging on its own: `guard status` is protected by a
  function unrelated to the thing it protects, so reordering two lines moves it.
- **Proof:** `planErase does not report a history for a directory with no
  repository`, plus the two ordinary tests beside it that pin the callers which
  hold.

### I-3 — identities never bleed · I-1 — the local route works

#### H4 · `verify` reports `stable: true` when no backend answered

`verifySoul` writes `stable: true` into the silent arm directly, and the report
is `stable: reports.every((r) => r.stable)`. A machine with no vendor CLI on
PATH and no daemon therefore produces, per backend, `level: "silent"`,
`runs: []`, `flipped: 0`, `stable: true` — and a report-level `stable: true` over
zero probe runs.

The level itself is honest (`levelFor([])` returns `"silent"`, pinned below), and
the exit code is 1. The **field** is the free pass, and `--json` hands it to
whoever reads it with `flipped: 0` beside it, looking like a measurement.

- **Reachability: full.** It is the ordinary state of a machine with only a local
  model, before ollama is up.
- **Who is fooled:** anything parsing `--json` on `stable`, and any reader of
  AC5's "at most one of three questions may move".
- **Proof:** `stable is not true of a report in which nothing was measured`,
  `a silent backend's own row is not marked stable`.

#### H5 · `soul verify`'s exit rule is vacuously true on an empty backend list

`bin/commands/soul.ts:487`:

```ts
const allConfirmed = result.backends.every((b) => b.level === "confirmed");
return allConfirmed && result.stable ? 0 : 1;
```

Both sides are true of nothing: `every` on `[]` is `true`, and H4 makes
`stable` true. An empty list would exit **0** with no backend asked.

- **Reachability: none today, measured.** Two things stand in the way, and the
  probe asserts both so it goes red if either is removed: `PHASE_A_BACKENDS` is
  non-empty (and `test/exec/registry.test.ts` holds it so), and both
  `cmdSoulApply` and `cmdSoulVerify` fall back to it with
  `named.length > 0 ? named : [...PHASE_A_BACKENDS]`. `--backend ",,,"` parses to
  `[]` and takes the fallback.
- Counted as a hole under your ruling: the doctor bug was unreachable until a
  binary existed, and this one is one argument away.
- **Proof:** `soul verify's exit rule is not satisfied by an empty backend list`
  (the expression, transcribed), `that empty list is not reachable from the
  command line today` (the reachability field).

#### H6 · `rebuild --check` says `fresh` on an engine that derives nothing

`derivedStatus` compares recorded and expected derivations by joining both sorted
lists — and `"" === ""`. With `DERIVATIONS = []` the manifest agrees, the
artefact loop iterates over nothing, and the answer is:

```
fresh — 0 artefact(s) match what the repository holds · built <timestamp>   # exit 0
```

Measured end to end through the CLI in a mutated copy (`D-P4b`): `mind new`,
`mind rebuild`, `mind rebuild --check` → exit 0.

- **Reachability: needs a registry edit.** `DERIVATIONS = []` typechecks clean
  and the suite does go red elsewhere — 11 failures out of 1224 (`D-P4`) — but
  none of them is this, and `rebuild --check` is the command a CI job runs.
- **Second-order:** `doctor --agent` would then emit `agent.derived` as an **`ok`**
  whose detail carries `0 artefact(s)`, which is the same shape
  `test/cli/binary.test.ts` forbids. See §2.
- **Proof:** driver row `D-P4b`; `derivedStatus over a directory with nothing built
  is missing, not fresh` pins the near-miss case that does hold.

### I-6 — nothing leaves this machine unasked

#### H7 · `guard scan` reports a pass to the hook over an empty index

```
$ mind guard scan --staged <repo>      # after `git rm`, nothing else staged
mind guard: 0 staged file(s) passed 18 rules. That is not the same as "there
is nothing personal in this commit".
$ echo $?
0
```

The sentence is honest. The exit code is not, and **the exit code is the only
part a pre-commit hook can see.** This is the one place in the command where
"nothing was scanned" and "nothing was found" produce the same answer; every
other failure mode — `stagedFiles` throwing — is already handled with *"Nothing
was scanned, so this is a block rather than a pass."*

Per your ruling on point 3, this is **not** filed as intended. It is a hole
documented in prose only.

- **Reachability: full, and ordinary.** `stagedPaths` uses
  `--diff-filter=ACMR`, which drops deletions on purpose, so **a commit that only
  deletes files reaches the scanner with an empty list** — measured on a real
  repository, not argued from the flag. `git commit --allow-empty` is the other
  route.
- **Who is fooled:** `.git/hooks/pre-commit`, and anything doing
  `mind guard scan --staged && …`.
- **Proof:** `a commit that only deletes files stages no bytes for the scan to
  read` (reachability, ordinary test), `a scan that read no file does not report
  a pass to the hook` (`test.failing`).

#### H10 · `commitApply` reports success over a plan that writes nothing

`src/soul/apply.ts:339` returns `{ ok: true, written: [], refused: [] }` when
nothing is pending, **before** the pre-flight re-read that is the function's
whole safety property. "Every target was written" and "there was no target" are
the same answer.

- **Reachability: none today, measured.** `resolveTargets` over a non-empty
  backend list always yields at least one target, and every caller passes
  `PHASE_A_BACKENDS` or an explicit list the parser has already validated. The
  probe asserts that, so it goes red the day it stops being true.
- **Proof:** `commitApply does not report success over a plan that writes
  nothing`, `resolving any known backend yields at least one target`.

### The guards that are themselves tests

#### H8 · a structural scan passes over a closure of zero files

`test/agent/no-vendor.test.ts` walks the import closure of `src/agent/` and
asserts nothing in it reaches `src/exec/`. Empty the directory in a copy and:

| run | result |
|---|---|
| the whole file | **red** — the third test's "it does reach the chokepoint" catches it |
| `-t "nothing under src/agent/ can reach src/exec/, at any depth"` | **green**, over a closure of 0 files |

This is the case you ruled on directly in point 2, and the measurement agrees
with your reasoning rather than with mine: the floor lives in a *different test*
of the same file, so running that one test by name passes for free. That is a
second list, kept beside the thing it describes, free to drift. Recorded, not
fixed.

- **Reachability: full** — a directory disappearing is the state, and `-t` is
  how anybody debugs one test.
- **Proof:** driver rows `D-C2` (the file goes red — the control) and `D-P1`
  (the test alone goes green — the hole), on the same mutated tree.

The same shape one directory over is **out of reach**, and what puts it out of
reach is not a floor: `test/ledger/local-only.test.ts` does
`import … from "../../src/ledger/index.ts"`, so an emptied `src/ledger/` takes
the module down before an assertion runs (`D-P2`, red at import, 0 pass). Same
for `test/erase/no-network.test.ts`, which namespace-imports its barrel. The
protection is an import written for another purpose.

#### H9 · `cli-parity` over two empty directories prints `PARITY-OK`

```
$ bun run scripts/cli-parity.ts --base <empty dir> --head <another empty dir> \
      --only 02-unknown --work <tmp>
… PARITY-OK   # exit 0
```

Two engines that both fail identically are, by this harness's definition, at
parity — which is correct for what it measures and is still an `OK` earned by
neither side working. Worth saying beside `PROVED_OTHERWISE`'s own sentence:
*"the number that matters is … whether its controls still bite"*. The full
`--selftest` was **not** run this round (0 times, as asked); the mini-run inside
`bun test` is untouched.

- **Reachability: full** — it is two arguments.
- **Proof:** driver row `D-P6`.

---

## 2 · The inverted one — a check that would *fail* for free

You were right, and the mechanism is not the one you assumed.

`test/cli/binary.test.ts:120` forbids, with no exception:

```ts
const zeroed = findings(report.stdout).filter(
  (f) => f.severity === "ok" && /(^|\s)0\s+\S/.test(f.detail),
);
expect(zeroed).toEqual([]);
```

`checkQdrant` emits, when the store answers:

```ts
ok("qdrant.reachable", "store", `${env.qdrantHost} · ${names.length} collection(s)`)
```

Measured against the rule, with the store answering and holding no collection:
exactly one finding trips it — `qdrant.reachable :: http://127.0.0.1:59995 · 0
collection(s)` — and nothing else. What that `ok` certifies *was* measured: the
store answered `/collections` and the list parsed. The number is an extra, and a
reachable store with no collection yet is the ordinary state of a machine that
has just installed one. **The rule is wider than its own reasoning**, and
`checkGpu`'s comment states the narrower version it was written from: *"No row
here begins with a zero."* `qdrant.reachable`'s does not begin with one.

Why it is green today — three machine states, measured:

| state of the store at the default host | finding | the rule |
|---|---|---|
| nothing listening | `qdrant.unreachable` (warn) | never reaches a finding — green (what you assumed) |
| answering, ≥ 1 collection | `· 1 collection(s)` | no match — green (**this machine, today**) |
| answering, 0 collections | `· 0 collection(s)` | **red**, over a correct `ok` |

`binary.test.ts` passes `--ollama <dead port>` and leaves the store at
`DEFAULT_QDRANT_HOST`. On this machine that port *is* answering and does hold one
collection, so the test reaches the finding and passes on the count rather than
on the rule. On a freshly installed store it would go red. Not fixed this round.

- **Proof:** `no ok finding carries a count of zero, when the store answers`
  (`test.failing`, with the regex copied character for character).

---

## 3 · The checkers that hold — and how that was checked

Most of this repository is tight, and tight on purpose. Each row below is an
ordinary assertion in `test/odd2/free-pass.test.ts`, so it stays on as a guard
and goes red the day the clause that makes it hold is deleted as redundant.

| checker | the empty case | why it holds |
|---|---|---|
| `levelFor` (`verify.ts:192`) | `[]` → `silent` | an explicit early return in front of two vacuous `every` calls |
| `isolationHeld` (`isolation.ts:230`) | no runs → `false`; all-silent → `false` | both halves written down, with the reason in the docblock |
| `auditClears` (`audit.ts:308`) | `[]` → `false`; 0 judged → `false` | `answered.length > 0 &&` before the `every` |
| `checkEngine` (`doctor.ts:1003`) | three separate gates → `not checked`, never `clean` | the 2026-09-21 bug, repaired and pinned |
| `doctor` + `historyFacts` | `agent.notrepo` warn, no `agent.commits` | asks `enclosingGitRepo` before counting |
| `wornReport([])` | `none`, and `wearsOnly` false | `subjects.length === 0 ? "none"` |
| `FallbackExec([])` | throws | a constructor refusal, not a result |
| `derivedStatus` on an unbuilt dir | `missing` | no manifest is its own arm |
| `judge()` on an empty repository | exit 1 | **see below** |
| `verdict()` | absence reported before the floor | `unseen` short-circuits `below` |
| `sizeVerdict` | a recorded path not on disk → `missing` | the third arm, added for this reason |
| `parseOllamaTags` | unreadable body → `undefined`, not `[]` | the two are kept apart on purpose |
| `hookStatus` on a non-repository | throws | `git rev-parse` failure is raised, not absorbed |
| `bun test <path matching no file>` | **exit 1** | the headwater of every gate in this repo; measured (`D-P5`), and it refuses |
| `VENDORS = []` | 152 of 1224 tests red, `tsc` clean | the registry is loudly load-bearing (`D-P3`) |

One of these was measured to hold **for a reason other than the one predicted**,
and it is worth knowing before anybody tidies it:

> **`judge()` over an empty repository exits 1 through the `stray` clause.**
> `verdict([], …)` is vacuously clean and `sizeVerdict`'s `missing` is checked
> last, so the branch that actually refuses is the one that notices
> `PROVED_OTHERWISE` naming two files under `scripts/` that are not on disk. The
> gate holds. It holds through a clause written for a different purpose.

The mutation controls behind the last two rows are in the driver: emptying
`src/agent/` **must** turn `test/agent/no-vendor.test.ts` red, and it does, at
the third test rather than at an import.

---

## 4 · What was not measured, and why

**Bug #5's family — a name that points at nothing.** A different shape from the
rest: not an empty input, but a deny list naming a tool the vendor has renamed.
The real probe layer would mean spending a turn on each vendor CLI, which writes
that vendor's cache and config into whatever home it is given — so **it was not
run**. Only the static half was done, by reading installed package manifests and
one vendor's own help text off disk. No vendor CLI was executed.

- The grok case from 2026-09-21 is already repaired in the registry: it now
  carries an **allow** list (`read_file,grep,list_dir`), and the trap is written
  out beside it — *"a typo in an allow list costs the turn its tools quietly, and
  a typo in a deny list costs the turn its limits quietly."*
- The one deny list left is copilot's `--deny-tool shell write`. Read out of the
  installed bundle's own help text: `--deny-tool` takes `kind(argument)`, and
  both `shell(command:*?)` and `write` are current kinds. **The registry's
  copilot row is still true on this machine, statically.**
- Version drift, read from package manifests rather than by running anything:

  | vendor | registry `measuredAgainst` | installed | |
  |---|---|---|---|
  | codex | 0.153.4 | 0.155.1 | **drifted** |
  | gemini | 0.38.2 | 0.38.2 | same |
  | copilot | 0.0.367 | 0.0.367 | same |
  | claude, grok, kimi | 2.1.278 / 1.0.40 / 2.0.2 | not readable this way | **not measured** |

  Worth one line on its own: the registry's *prose* beside `CODEX_READONLY`
  already says *"measured 2026-09-21 on 0.155.1"*, while its `measuredAgainst`
  field says `0.153.4`. The comment and the field disagree, and the field is what
  `doctor` compares against — so `doctor` reports drift for codex today against
  a version the registry's own note says was the one measured.

If you run this with `MIND_REAL_READONLY=1` yourself, the behavioural half can
be had.

**Also not done, as agreed:** `npm run demo` (0 runs), the full `cli-parity
--selftest` (0 runs), and `measure()` / `main()` in `scripts/check-coverage.ts`
(never called from a probe — a test that called `measure` would fork the suite
inside itself).

**Did the probes mask the coverage gate?** No. `npm run coverage -- --report`
before and after moves exactly one line: `src/erase/plan.ts` 95.71% (223/233) →
95.73% (224/234). Every gated file was already above the 85% floor before these
probes existed — the lowest is `src/agent/new.ts` at 85.90% — so no file clears
the floor because of one.

---

## 5 · Where I would still like you to disagree

1. **H5 and H6 are counted as full holes and neither is reachable today.** That
   is your ruling applied as written, and it puts two rows in the table that
   nobody can trigger without editing `src/`. If the table would read better with
   them in an appendix, say so — the reachability field is measured either way.
2. **H7's "should" is written as a non-zero exit code.** That is one of at least
   two honest repairs; the other is a third exit code, or a `--require-files`
   flag. The `test.failing` is pinned to the exit code because that is what you
   said hooks read, but a fix that kept exit 0 and added a distinguishable signal
   would leave that probe passing forever without telling anybody.
3. **§2 says your rule is too wide and does not propose narrowing it.** The
   alternative repair is to leave the rule and reword the finding — `· no
   collection yet` rather than `· 0 collection(s)`, which is what `checkAgent`
   already does for `no commit yet`. That is probably the better fix and it is
   not mine to make this round.
4. **`historyFacts` is reported as three callers rather than one function.** I
   have not filed the function itself as a hole, on the grounds that it never
   claimed an arm it does not have. You may prefer it filed at the source, where
   one fix would cover all three.

---

## Appendix — predictions registered before measuring, and what happened

| prediction (from the plan) | measured | |
|---|---|---|
| `soul.ts:487` exits 0 free if the CLI can reach `[]` | true of the expression; the CLI cannot reach `[]` | as predicted, both halves |
| `verifyErase` → `erased-and-verified` for a subject that never existed | exit 0, verdict as predicted | **as predicted** |
| `verifySoul` → `stable: true`, exit still 1 | both true | as predicted |
| `judge()` green on `src: []` | **wrong** — exit 1, via `stray` | missed |
| `cli-parity` on two empty dirs → `PARITY-OK` | `PARITY-OK`, exit 0 | as predicted |
| `local-only.test.ts` floorless test green when emptied | **wrong** — the file cannot load at all | missed |
| `no-vendor.test.ts` floorless test green when emptied | green; the file red | as predicted |
| `VENDORS = []` → the file's own tests green, others red | 152 red of 1224, `tsc` clean | as predicted |
| `DERIVATIONS = []` → `fresh` over 0 artefacts | exit 0, `fresh — 0 artefact(s) match` | as predicted |
| `commitApply` with nothing pending → `{ok: true}` | measured — `{ ok: true, written: [] }`, and unreachable through `resolveTargets` | as predicted (H10) |
| `guard scan` 0 files → exit 0 | measured, and reachable via a delete-only commit | as predicted |
| `isProjectScopedOnly([])` → `true`, unreachable | true; unreachable while `VENDORS` is non-empty | appendix, not a row |
| eight `try { readdir } catch { return [] }` sites | judged per caller rather than as a group; only `searchTree`'s is pinned here | **partly read only** |
| grok deny-list (bug #5) | different shape; static half only, see §4 | **not measured** |

Two predictions were wrong and are written down as wrong. One thing I did not
predict at all turned up in the instrument rather than in the engine: a
`test.failing` whose body throws before its assertion reports the same pass as
one whose assertion failed, which is why two probes moved into `beforeAll`.

---

## Appendix B — what `fix2` did, and where this survey was wrong

Appended 2026-09-22, after the work. Nothing above is rewritten: what a survey
recorded is worth keeping beside what was done about it, including the parts it
got wrong.

`fix1` closed H1 and H2. `fix2` closed H3, H4, H5, H6, H7, H9, H10 and §2's
inverted row. H8 was out of scope and is still open — `D-P1` still reports it.

### The finding that matters more than any single hole

**Four of the seven `test.failing` assertions in this file named the wrong
repair.** Written as *"the way the checker should behave"*, each of them would
have gone green on a change that left the danger in place, or introduced the
opposite lie. This is the same shape as D-026 item 3, found again, in the
instrument this survey built:

| row | what the probe asked for | why that was the wrong repair |
|---|---|---|
| H3 | `plan.git === null` for a directory that is no repository | The dangerous case is the **mirror** of it: a repository *with* history and a remote that git refuses to read. `.git` is present, so every "is this a repository?" test passes, and the certificate printed `git 0 commit(s) · no remote configured` over a history holding both. And `null` is already the value `--no-agent` uses for "nobody looked". |
| H4 | `stable: false` when nothing was measured | `false` is the claim that these backends **were asked and wavered** — ADR 0001 §2's `silent` collapsed into `failed`, over a backend that never ran. `null` is the third state, with `unmeasured` naming the rows it came from. |
| H7 | a non-zero exit over an empty index | The reachable way to stage no bytes is a commit that **only deletes files**. Blocking those blocks the person removing a secret, and the answer to a hook that blocks correct work is `--no-verify`, which turns the guard off for everything. |
| H10 | `ok: false` over a plan that writes nothing | Writing nothing is the ordinary result of applying twice, and the **only** result on a machine whose one backend is ollama. Failing it punishes the local route (I-1). |

Each rewritten assertion was run **red against the unrepaired engine first** —
H4 two, H5's coupling one, H3 five, including the unreadable-repository case
this survey did not think to ask for. Rewriting a "should" without that is
moving the goalposts, and it is the only guard against it. D-027 records the
reasoning per hole.

### What the measurements found that this survey had not

**`--diff-filter=ACMR` drops `T`.** Looking for *why* the staged list is empty
rather than *what to do about an empty list*, the real question turned out to be
what the filter throws away. Measured, `git` 2.x, 2026-09-22: commit a symlink,
replace it with a regular file holding a token, `git add -A` — and `git diff
--cached --name-only --diff-filter=ACMR` returns **nothing**, while `git
cat-file blob :link.md` hands the token straight back. Eighteen scan rules over
an empty list. The filter is `ACMRT` now, and a by-hand run blocks that commit
with one finding. This is a bigger and more ordinary bug than the one H7 named,
and H7 is how it was found.

**Every exit code `historyFacts` needed was distinguishable, and none of them
was being read.** The table is in `src/guard/history.ts`; the two columns that
matter are `rev-parse --verify HEAD` answering **1** for an unborn branch and
**128** when git could not look, and `config --get-regexp` answering **1** for
"no remote configured" and **128** for a config it could not read. Collapsing
either pair is how one shape reported zero for both.

**`doctor` had H3's dangerous direction too.** This survey recorded `doctor` as
**tight**, because `enclosingGitRepo` runs before the count. It is a `stat`
walk: a repository with a corrupt `.git/config` passes it, and `checkAgent` then
printed `ok commits: no commit yet` and `ok remotes: none configured`. Fixing
`historyFacts` at the source closed all three callers at once, which is what
§5's fourth question asked for.

### The two rows that changed answers

| row | before | after |
|---|---|---|
| `D-P6` | `PARITY-OK`, exit 0, over two empty directories | **exit 3, `PARITY-UNDECIDED`** — a refusal to judge |
| `D-P3` / `D-P4` | `tsc clean` beside a red suite | **`tsc refused`** — `VENDORS` and `DERIVATIONS` are `NonEmpty` |

`D-P4b` is unchanged and says so: `rebuild --check` still answers `fresh — 0
artefact(s) match` on a tree where `DERIVATIONS = []`, because bun strips types
rather than checking them. The state is closed at the compiler, not in
`derivedStatus` — **a guard that lives in a type is a guard somebody gets past by
not running the typechecker**, and that is worth one line here rather than a
comfortable claim that the row is gone.

### §2's inverted row: the rule was right and the finding was wrong

This survey wrote that *the rule as written is wider than its own reasoning* and
suggested narrowing it. §5 item 3 then said the better fix was probably the
wording, and that was the right call: `qdrant.reachable` now reads `· no
collection yet`, in the words `checkAgent` already used for `no commit yet`, and
**not one character of the regex in `test/cli/binary.test.ts` was touched** —
`test/odd2/free-pass.test.ts` asserts that it is still exactly what it was.

### What is still open

- **H8** — running `test/agent/no-vendor.test.ts`'s floorless test by name still
  passes over a closure of zero files (`D-P1`). Out of scope for `fix2`.
- **Two engines that both run and fail the same way** are still reported as
  parity. `cli-parity`'s liveness check narrows this; it cannot close it, and
  the file's header says so. A harness that compares two sides cannot see a
  fault both sides share.
- **`scripts/demo-bare-container.sh`** was not run (it needs docker, a GPU and a
  pulled model). What was measured instead is that the row it reads —
  `backends.find(b => b.backend === "ollama")` — does **not** become `null`: that
  backend runs its three probes and gets three silent answers, so its stability
  was measured. Only a backend whose `available()` says no is `null`.
- **Version drift** for codex is unchanged, and the registry's comment and its
  `measuredAgainst` field still disagree (§4).
