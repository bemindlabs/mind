# ADR 0002 — Agent repository layout: what `.mind/` may hold, and what may not

- **Status:** Accepted
- **Date:** 2026-09-21
- **Extends:** [ADR 0001](0001-engine-shape.md) §3 (one agent, one git repository)

## Context

ADR 0001 decided that an agent is a git repository and that derived state lives
in a single ignored directory. Building that directory raised three questions
that decision did not answer, all of which are cheaper to settle now than after
something has been written into the wrong layer.

## Decision

### 1. `.mind/` holds only what a register knows how to rebuild

Every file under `.mind/` is produced by a named entry in a derivation register
(`src/agent/derive.ts`), each of which is a pure function of files git holds:
same repository in, same bytes out, with no clock, no hostname and no
randomness. A rebuild sweeps out anything the register does not claim, and says
what it swept.

That is what makes `rm -rf .mind` a safe thing to type — which is the whole
content of I-2. A file that survived a rebuild because nothing knew how to
remove it would make the invariant false in the one way nobody would notice.

**Consequence:** anything that cannot be derived does not go in `.mind/`. It
goes into git, or — if it is personal — outside the repository entirely
(D-014). There is no third option, and §3 below is the first thing that hits.

### 2. `built_at` is the only field a rebuild may change

AC6 wants `.mind/manifest.json` to record *when* it was built. AC7 wants a
rebuild to come out identical. Both are kept by making exactly one field
exempt: the manifest records a build time, and everything else in it — schema,
subject, generator, and every artefact and source hash — is a function of what
git holds.

The test does not skip `built_at`. It advances an injected clock between two
builds and asserts that the build-time line is the only line that moved, which
is the difference between a property and a claim.

**Alternative not chosen:** dating the build from the source commit, which
would make the manifest byte-identical across rebuilds. Rejected because it is
wrong exactly when it matters — a working tree with uncommitted edits would be
dated by a commit that does not contain them.

**Consequence:** "identical after a rebuild" holds *within one engine version*.
The manifest records its generator, and a manifest written by a different one
reports stale rather than pretending the guarantee reaches across versions.

### 3. The turn ledger lives outside `.mind/` **and** outside git

D-014's sketch put `ledger.sqlite` under `.mind/`. That is superseded here: the
turn ledger (S2.2, B2) goes under
`$XDG_STATE_HOME/mind/ledger/<subject>/YYYY-MM.jsonl`, in the same tree
`soul apply` already keeps its backups in, partitioned by subject.

Two reasons, and they point at different directories:

- **Not `.mind/`.** The ledger is a record of what happened. It cannot be
  derived from anything, which is the one rule §1 does not bend — and a
  non-derivable file in the rebuildable layer is a file a rebuild would delete.
- **Not git.** A ledger is conversation, and conversation is data the owner has
  to be able to withdraw (I-4). Git remembers everything it has ever been asked
  to commit, so a ledger in git is a promise of deletion that cannot be kept.

**Amended 2026-09-21, implementing S2.2:** this section first said
`mind/<subject>/`, without the `ledger/` segment. That was a bug, not a
preference. `backups` is a valid `SubjectId`, so a subject named `backups`
would have written its conversations straight into the tree `soul apply` keeps
originals in — and the collision would have surfaced as a restore command that
quietly pointed at the wrong file. `ledger/<subject>/` sits beside
`backups/<subject>/` instead, and every future writer under the state root gets
its own segment for the same reason.

One file per month rather than one per subject, for the operation that is not
append-only: a `forget` rewrites only the months it touched, so the blast
radius of a deletion is as small as the request that caused it.

**Consequence, and it is the right one:** `git clone` of an agent onto a new
machine does not carry the old machine's conversations with it. Portability is
the identity, not the transcript.

### 3a. S2.2 AC5's "rebuildable index" half is withdrawn

Backlog §S2.2 AC5 read *"เป็น index ที่สร้างใหม่ได้ ไม่ใช่แหล่งความจริง (I-2)"* — a
rebuildable index, not a source of truth. The first half of that sentence
contradicts §3 above: a ledger records what happened, and nothing can
reconstruct what happened from anything else. An AC that asks for both is an AC
one of whose halves must be wrong, and it is the rebuildable half.

**Decided by the owner, 2026-09-21 (D-022).** AC5 keeps the half that is true
and still worth checking, which is the half I-2 was actually protecting:

- the ledger is **not the source of truth for anything the agent uses**. No code
  reads it back into a prompt, a memory or a decision;
- **deleting it changes no behaviour.** An agent whose ledger is missing, empty
  or truncated runs exactly as before;
- it is **readable without mind** — JSON Lines, one object per line, `jq` and
  `grep` and nothing else required (which is I-2's real content: data that
  outlives the program).

What is withdrawn is the claim that it can be *rebuilt*. It cannot, and a
system that said otherwise would be inviting someone to delete it on the
assumption that a rebuild would bring it back.

**Consequence:** the ledger is the first thing mind writes that is neither in
git nor reconstructible. That is exactly why it goes where `mind erase`
(S7.2) can find all of it in one directory, and why `ledger forget` exists in
S2.2 rather than waiting for E7.

### 4. `src/agent/` is a sixth directory under `src/`, and `src/ledger/` a seventh

D-002 named five: `soul`, `memory`, `observer`, `decide`, `exec`. Those are the
parts of an agent's *mind* and the seam through which it acts. `src/agent/` is
none of them: it is the container those parts are stored in — repository layout,
the derived directory, and the manifest that dates it.

Folding it into `soul/` was considered and rejected: `soul/` would then own the
layout of `memory/` and `consent/` as well, which is a wider responsibility than
the name admits and would put `memory/`'s directory shape in a module that E4 is
not going to look in.

**Consequence:** nothing under `src/agent/` may reach `src/exec/`. `new` and
`rebuild` finish with no model and no vendor CLI anywhere in the picture (I-1),
and a test walks the import graph to keep it that way — including transitively,
since `src/soul/index.ts` re-exports `verify.ts`, which does reach `exec`. The
agent layer therefore imports the soul modules it needs and never the barrel.

**`src/ledger/` (S2.2) is the seventh, by the same argument.** It is not part
of the mind and not the container the mind is stored in: it is the record of
what the mind did. It is a directory rather than `src/exec/ledger.ts` because
`turn` is only its first writer — S5.2 records proposals there and S8.2/S9.1
every message in and out, none of which are execution.

It carries the mirror image of `src/agent/`'s rule. S2.2 AC4 says the ledger
path makes no network call, and a test walks *its* import closure looking for
`fetch`, the node socket modules and anything that spawns a process — with a
control that points the same scanner at `src/exec/` and requires it to find
both. So `src/ledger/` imports `src/exec/backend.ts` for its types and nothing
else from that layer; the wrapper that records a turn is a `ExecBackend`
decorator, and the backend it wraps is handed to it.

### 5. The repository guard is three layers, and it proves a narrow claim

**Added 2026-09-21, implementing S0.4 (w1).**

Before this story the engine had two `Bun.spawn` call sites and no helper
between them, and the test that was supposed to keep `src/agent/` honest matched
the literal text `Bun.spawn(["…"`. It therefore could not see the second call
site at all: `src/exec/cli-exec.ts` builds its argv at run time and passes a
variable. A gate that reads like a proof and is in fact a search for one shape
of one call is worse than no gate, because it is quoted in an ADR.

So: **every subprocess in `src/` and `bin/` goes through `src/spawn.ts`**, which
refuses an argv before starting it, and AC2 is checked three ways, each with a
control that proves the check bites (`test/guard/no-push.test.ts`):

1. **Static, over the syntax tree** — not a regular expression. `Bun.spawn`
   appears in `src/spawn.ts` and nowhere else; `child_process`, `bun:ffi`,
   `eval`, computed access on `Bun` or `globalThis` appear nowhere. The control
   feeds the checker source it must catch (`const b = Bun`, `Bun["spawn"]`) and
   source it must not (the same words in a comment).
2. **Policy** — `refusal(argv)` is pure and exported. `git` may only be run with
   a closed list of local verbs (`init`, `rev-parse`, `ls-files`, `diff`,
   `cat-file`, `rev-list`, `config`, the last reading only), every global option
   before the verb is refused because `-c alias.x=push` is a push spelled
   differently, and the binaries that reach a remote without the word `git` —
   `gh`, `ssh`, `rsync`, a shell — are refused outright.
3. **Behaviour** — every CLI command that takes an agent directory runs with a
   `git` that records its argv first on `PATH` and a `file://` bare repository
   configured as a remote. Afterwards the log holds no network verb and the bare
   repository holds no ref. The controls are a push through the trap (caught)
   and a push without it (which really does land a ref, so "the bare repository
   is empty" is falsifiable).

Layer 3 is only evidence because layer 1 pins `dependencies` to empty: with no
libgit in the tree, writing a ref means executing the `git` binary.

#### What the guard does not reach

Stated here, in `GUARD_LIMITS`, and in the guard's own output — three places,
because an acceptance criterion that promises more than it checks gets ticked
and then misleads whoever read the tick.

- **A vendor CLI can push.** `cli-exec` spawns agents with their own shell
  tools. One of them running `git push` inside its own process is invisible to
  every layer above. What is proven is *mind's code has no path that pushes*,
  which is not the same claim as *a push cannot happen on this machine*.

  Narrowed, not closed, by `w1b`: every vendor now declares in
  `VendorSpec.readOnly` what mind passes to keep its turns read-only, and the
  declaration builds the argv rather than sitting beside it. Five of six pass
  something; four of those were watched holding it against a real turn, one
  (gemini) is believed on the vendor's own `--help`, and one (kimi) passes
  nothing because 2.0.2 offers nothing to pass. The measurement that earned
  this paragraph also found the previous version of it optimistic: grok's deny
  list named two tools the vendor had renamed, and a probe wrote a file through
  a flag that read like a fence in the registry, in the tests and in
  `mind backends`. So the machine-level claim stays exactly where it was —
  *mind's code has no path that pushes* — and what changed is that the gap
  is now per-vendor, printed by `readonlyLimits()` on every `backends` run, and
  falsifiable by `MIND_REAL_READONLY=1 bun test test/exec/readonly.real.test.ts`.

  Two things it still does not reach: MCP servers and session-start hooks in the
  operator's own vendor settings, which are in front of the model before mind's
  argv is read; and any turn mind did not start.
- **`--no-verify` skips the hooks**, and so does anything that writes objects
  without running them. `test/cli/guard.test.ts` commits a refused file that way
  on purpose: the hole is measured rather than described.
- **A clone has no guard.** `.git/hooks` is not cloned, so `mind guard install`
  exists and `mind guard status` exits 1 until it has been run.
- **Visibility is unknowable from here.** Whether a remote is private is a
  question only the host can answer and mind asks hosts nothing. It never
  creates a remote, and it says "I cannot see" rather than "this is private".
  That is the whole of what AC1 can honestly deliver.
- **The scan cannot see prose.** Its rules are prefixes and checksums; a name,
  an address, a diagnosis or a salary has none. `SCAN_BLIND_SPOTS` leads with
  this and is printed when the scan *passes* as well as when it blocks, because
  the person reading "passed" is the person about to believe it is safe.

#### What is left for later

AC5 is half closed. The text of what git keeps, the facts beside it, and the two
moments it is printed — `mind new`, before there is anything to keep, and
`mind guard status` — are here. `mind erase` is S7.2, and when it lands it
must print this same list rather than a second copy of it.

**Closed 2026-09-21 by S7.2 (w3):** `mind erase` prints `GIT_UNDELETABLE` by
holding it *by reference* on the `soul` place in `src/erase/places.ts`, and
`test/erase/places.test.ts` asserts that with `toBe`. There is one copy of those
words and three commands that print them.

The shape of the `personal` flag is S3.5. w1 enforces the *place* — a directory
outside every repository, refused if `XDG_DATA_HOME` points inside a checkout,
and refused by the scan if anything under a `personal/` directory is staged.

### 6. `src/erase/` is the eighth directory, and it only composes

**Added 2026-09-21, implementing S7.2 (w3).**

D-002 named five directories; §4 added `agent` (the container the mind is stored
in) and `ledger` (the record of what the mind did). `src/erase/` is neither: it
is the operation that runs **across** all of them for one subject. It cannot
live inside any one of them, because putting it in `src/soul/` would give the
soul layer a reason to import the observer and the ledger.

**It writes no new deletion logic.** Every removal goes through a deleter that
already existed: `planPurgeDir`/`commitPurge` (factored out of `planPurge` so
one walker serves four trees), `planForget`/`commitForget`/`removeLedgerDirAt`,
and `strip` from `src/soul/block.ts`. A second answer to "what does removing a
block mean" is the thing this design exists to avoid — **S1.5 `soul revoke` must
reuse `strip` as well**, and it owns the half erase deliberately does not do:
restoring a backup and verifying it against the manifest hash.

**Its import rule is the mirror of `src/ledger/`'s.** Nothing under
`src/erase/` may reach `src/exec/`: erasing somebody's data needs no model, and
a layer that could reach one could send what it read somewhere on the way to
deleting it (I-6). The consequence is visible in the signature — `planErase`
takes the vendor instruction file paths as an **argument**, because
`resolveTargets` lives in `src/soul/targets.ts` and imports the vendor registry.
`bin/commands/erase.ts` resolves them and hands over strings, and `src/erase/soul.ts`
unions that list with every `files[].path` in every backup manifest, which is
how a CLI uninstalled since still gets its block removed.

The closure *does* contain `src/spawn.ts`, through `src/guard/history.ts`:
erase counts commits with `git rev-list`, a local verb on the allowlist. That is
stated in `test/erase/no-network.test.ts` rather than exempted quietly, and
`test/guard/no-push.test.ts` runs the real command under a `git` that records
its argv.

#### Two rulings worth recording

**An identity lives in three places, not one.** `<agent>/soul/` in git, mind's
block inside every vendor instruction file `soul apply` wrote to, and
`$XDG_STATE_HOME/mind/backups/<subject>/` — where a backup taken before the
*second* apply contains the block the *first* one wrote. An erase that removed
only the first would leave two working copies of the identity, one of them
created by mind itself. All three go, and a test proves all three rather than
asserting the first and trusting the rest.

**AC1's five places carry three statuses, and the output never says "5".** A
closed registry (`PLACES satisfies Record<PlaceId, Place>`) marks `rag` and
`lora` `not-built`, names the story that owes each one (S4.1, S6.3), the address
D-014 reserves for it, and the five things it must bring when it registers. A
run probes that address: **something there with no deleter for it exits 1 and
issues no certificate.** A tripwire test fails if a derivation starts writing
under those addresses, if `src/memory/` grows a file, or if anything in `src/`
names a vector store or an adapter path while the matching place still says
`not-built` — so "register it later" is enforced rather than remembered.
*Amended (S4.1, D-038):* `rag` has since registered as `implemented`, with its deleter, in the same
commit that added the vector store; `lora` is still `not-built` (S6.3), and the output now reads
"4 of 4 places that exist · 1 of 5 are not built".

#### What erase does not claim

- **The certificate is issued, never kept.** Printed to stdout, written only to
  `--out`, and `--out` inside either root is refused: a stored certificate is a
  record that the subject existed, sitting in the tree the next run searches, so
  it would fail the check it certifies. No content hashes either, for
  `--private`'s reason — a digest of a name or a short prompt is guessable.
- **"ทั้งระบบ" has a definition and it is printed.** Searched: the whole state
  root, the whole data root, the instruction files, and the agent's working tree
  minus `.git`. `NOT_SEARCHED` — vendor transcripts, shell history, any network
  service, clones and remotes, git objects, freed blocks — is printed on every
  run including the dry one.
  **Proposed wording for `.scrum/backlog.md` S7.2 AC3**, written to match what
  the code does rather than what was hoped for — the owner's to lift or reject:
  *"ค้นตัวระบุใน stateRoot · dataRoot · ไฟล์ instruction ที่ apply เคยเขียน ·
  working tree ของ agent (ไม่รวม `.git`) ได้ 0 — ขอบเขตที่ไม่ได้ค้นต้องพิมพ์ทุกครั้ง
  (`NOT_SEARCHED`) และผลที่เจอในไฟล์ที่ git ถืออยู่ รายงานเป็น `file:line` ไม่ลบให้"*.
- **The search is coarse for text without word boundaries.** The subject id is
  matched on the subject alphabet; everything else is a substring, so Thai
  over-reports. That errs towards finding too much, which is the safe side for a
  deletion check and is not the same thing as being accurate. `SEARCH_LIMITS`
  says so where the number is printed.
- **Nothing found is its own verdict, and it is not a certificate.** *(fix1,
  2026-09-22.)* `erased-and-verified` now also requires that something was
  *removed*: every other arm of the check — remaining files, failed deletions,
  hits — reads zero for a clean run and zero for a machine that held nothing, so
  a subject this machine had never heard of used to earn the full verdict having
  read no file at all. The discriminator is **not** how much was read: a
  mistyped id on a machine holding somebody else's data reads plenty, finds
  nothing, removes nothing, and is the dangerous shape — a confident certificate
  while the real data sits one character away. So the verdict turns on what the
  plan found before the deletion and what the result removed, `filesRead` goes
  on the document per scope as evidence of how much was looked at, and the
  exit code is **3** — not 0, which `&&` would read as a completed withdrawal,
  and not 1, which from this command means something survived.
  An empty directory named for the subject counts as removed: a census cannot
  see one at all (empty and absent are both zero), so the only evidence it was
  there is that `rmdir` succeeded, and it is the identifier AC3 says must be
  findable nowhere.
- **"Never existed here" and "erased earlier" are the same fact on disk, and
  mind does not pretend otherwise.** Certificates are issued and never kept,
  `commitForget` leaves no tombstone, and `src/erase/search.ts` says a missing
  root and a deleted one are one thing. The only record that could separate them
  is one saying *subject X was erased*, which is itself a trace of X and which
  the next run's AC3 search would find. So there is one verdict, the certificate
  states the limit in words, and the evidence of an earlier erasure is the
  certificate *that* run issued under `--out`.
- **A scope that could not be read is not a scope that was found clean.**
  `searchTree` answers zero hits for a root it could not open, exactly as it
  does for one that is not there, and only `unreadable` separates them. Any
  unreadable scope keeps the verdict away from `erased-and-verified` *and* from
  `nothing-found`, and is named on the document.
- **A hit in a git-tracked file is a remainder, not a deletion.** `memory/`
  naming its own subject is ordinary; it is reported as `file:line`, never
  removed, and the verdict becomes `erased-with-remainder`. A real agent may
  never get a clean verdict, and that is the honest answer rather than a gate
  that opens by not looking.
- **`--personal` removes the whole ledger because it cannot be split.** No
  ledger line carries a per-record personal flag, so there is no query that
  keeps the work turns and drops the rest; D-022 records that nothing reads the
  ledger back into behaviour, so no work knowledge is lost. The output says that
  in those words rather than implying the whole ledger was personal.
- **`CaptureNotice` proves a call, not a reading.** `ensureObserverDir` now
  requires a value only `announceCapture` can mint, so w4 cannot create the
  capture tree without having written `OBSERVER_UNDELETABLE` somewhere first.
  Whether a human read it is not a thing a type can witness, and
  `OBSERVER_LIMITS` says so.

### 7. Capture is off by default, and the consent for it is not a flag

**Added 2026-09-21, implementing S3.1 (w4).**

D-024 turned E3 from a dig into a capture, and §5's last bullet left
`CaptureNotice` waiting for the story that would fill the directory. Four
things were settled while filling it.

**mind builds the receiving end and connects nothing.** `mind observe
capture` reads one hook event from standard input; `mind observe hook
--print` prints a settings fragment and writes no file. mind does not edit
another program's configuration, and the reason is not difficulty — a program
that wired a recorder into your own tools would have made the consent below a
formality. grok offers no hook mechanism at all, so grok can be seeded and
never captured, and the output says that rather than implying parity.

**Consent to record the owner's behaviour is the one decision mind does not
take from an argument.** Every other writing command here has a `--yes`;
`observe enable` deliberately has none, because a program running as the owner
can type one and a program is exactly who would. It requires a terminal and an
exact phrase naming the subject. That proves a terminal, not a person —
`script(1)` gives any process a pty — and `CAPTURE_LIMITS` says so in the same
screen the owner agrees on.

The consent is to **a sentence, not to a program**: `consent.json` holds one
grant per scope, each carrying a sha256 of the words that were shown for it —
built from `CAPTURE_FIELDS` and `CAPTURE_LIMITS` — so a release that changes
what is captured changes the digest and capture stops until the new list has
been read. Nothing has to remember to ask. Per scope rather than per file
because the two scopes are shown different text, and one hash could only ever
have satisfied one of them; the other would have been a permission that
silently never worked. And the file lives *inside* the observer directory, so `observe purge` and
`mind erase` remove it with the records: **deleting the data is withdrawing
the consent**, and capture stops by itself. Nothing on the capture path may
create a directory — that is why `appendRecord` and `saveSessionState` take an
existing tree and fail without one, and a test walks the syntax tree of every
file under `bin/` to check the capture code names neither `ensureObserverDir`
nor `announceCapture`.

**A `target` is split by kind rather than capped by length.** The plan proposed
keeping a whole command line at 512 characters with the pre-commit scan as the
safety net. The owner refused it, and the reasoning belongs here: a command
line is where secrets and personal data most often sit — a header carrying a
token, a path carrying a name, a prompt passed as an argument — and
`SCAN_BLIND_SPOTS` states in its own first line that no rule there sees prose.
So a file edit keeps its path relative to the project (the behavioural signal
S3.2 AC2 wants), a command keeps its program and first subcommand (`git
commit`), and everything else keeps nothing. **Resolution was traded for leak
surface**, and anybody who needs full argv has to design a separate consent for
it rather than receiving it as a side effect of this one.

**A seed happens once per vendor, and a repeat says the word.** Because the
reader de-duplicates by key, re-running a seed is harmless and therefore
tempting — put it on a timer and grok keeps producing records. That is a
backfill, which is precisely the shape D-024 found does not work: the window
does not widen by waiting, because the limit is the vendor deleting its own
files. So the seed is recorded in `seeds.json`, a second run is refused, and
`--again` prints `BACKFILL_NOTE` before proceeding.

#### The gate S3.2 will hit, recorded before it does

`readCaptured()` returns a `Personal<T>`, and `unwrapPersonal` is callable in
exactly one file — `src/exec/local.ts`, enforced by the AST gate in
`test/guard/personal-type.test.ts`. That is what §5's `personal` flag is for,
and it means **S3.2 cannot read a field off a capture record to extract from it
without going through a model.** w4 does not hit this: counting and
de-duplicating happen before the flag goes on, and `observe status` reports
from `census` and a count.

S3.2 will hit it, and the answer is **a door, not a hole**. Whatever S3.2 needs
— a local extractor that takes `Personal<T>` and returns `Personal<T>`, a
second minted capability beside `asLocal()`, a narrowing of what the box hides
— has to be designed as an entrance with its own proof. Adding
`src/observer/` or `src/decide/` to the gate's allowlist would turn the check
off for the layer it exists to guard, in one line, with nothing in review to
catch the eye.

#### Measured, not remembered

Every hook field name `src/observer/adapters/claude-hook.ts` reads was taken off
the installed binary rather than recalled, and is written into
`docs/cli-matrix.md` beside the version it came from — the same rule the usage
table follows, for the same reason: these move between releases and the failures
are silent. One reading changed the design. **A tool that fails does not fire
`PostToolUse`**; it fires `PostToolUseFailure`. The plan asked for two events,
which would have recorded a world in which nothing the owner does ever fails,
with `outcome` a column of `ok` that meant "this reader cannot see failures".

### 8. The door S3.2 walked through, and the line it drew around git

§7 recorded a gate before S3.2 reached it: `readCaptured()` hands back a
`Personal<T>`, `unwrapPersonal` is callable in one file, and S3.2 therefore
could not read a field off a capture record. This is what it did instead.

**The door is `countPersonal`, and it takes no function.** The obvious
combinator was `mapPersonal(value, fn)` — compute inside, keep the result boxed
— and it was refused. A door that takes a function is a hole with a guard on it:
`fn` decides what comes back, an AST rule can see the call site and not the body,
and the closure `fn` is written inside can copy the boxed value to an outer
variable without ever saying the word the gate watches for. The owner's ruling
was the one this project has been using all night — *make it impossible to write
wrongly, rather than catchable* — so the door takes **data**: a list of tallies
saying how to compose a key out of an item's string fields, and a vocabulary of
every key that may appear. A composed key is *looked up*, never inserted, so no
string from inside the box can become one. One sentence is the whole proof
obligation: **every key in the output came from the vocabulary, and every value is
a count the function did.**

That is asserted rather than described: `test/guard/personal-type.test.ts` reads
`src/types.ts` as a syntax tree and fails if any parameter of `countPersonal`
becomes a function type, with a control proving the walk really catches one. The
gate's allowlist is still two files, and there is a test that says so by name —
the cheap answer to S3.2 would have been a third line for `src/observer/`.

**What may enter git, decided:** integers, keyed by words mind holds in its own
source — the month, the kind, the outcome, the origin, the vendor, and tool or
program names from a built-in list (`BUILTIN_TOOLS` in
`src/observer/adapters/vocabulary.ts`, `SUMMARY_PROGRAMS` in
`src/observer/actions.ts`). Anything else is counted as `other`. Never: a path,
a `project`, a `session`, an instant, an MCP server's name (a server name is a
company and often a person — SP-1 guard 1), or any per-action row. Those stay in
the personal store, where `observe purge` and `erase` delete them.

The reason is w3's finding, not caution: **what enters git cannot be taken back
out** (`GIT_UNDELETABLE`), so what enters git must not identify anybody in the
first place — by construction, not by filtering, because `SCAN_BLIND_SPOTS` says
in its own first line that no scan sees personal data written as prose. AC5's
"เข้า git ได้" is therefore met by a counted summary and not by the action rows:
proposed rewording for the backlog, which this task did not edit, *"ผลสรุปแบบนับ
(ไม่มี path · ไม่มีชื่อโปรเจกต์) เข้า git ได้เมื่อสั่งชัดเจนต่อครั้ง · รายการ
action รายตัวอยู่ใน store ส่วนตัวและลบได้"*.

Three consequences of that line are worth writing down because each cost
something:

- **Months come from capture *file names*, never from records.** A month read off
  a record would be a string from inside the box, and there is no way to let one
  out. The cost: a record whose timestamp disagrees with the file it sits in
  belongs to no column, so the totals do not add up — and the run prints how many
  that was rather than balancing them.
- **`--write` is the only path into a working tree**, one run at a time, and it
  prints `GIT_UNDELETABLE` *before* the file exists. D-013 #4 ("ไม่เข้า git
  โดยค่าเริ่มต้น") holds. mind still never stages and never commits.
- **An empty `owner-prompted` row is explained in words.** Every seeded record is
  `origin: "unknown"` — hard-coded in both transcript adapters, because the field
  that would decide it is not in a transcript — so before capture is ever enabled
  the owner's row is 0 by construction. `OWNER_ROW_EMPTY` says that in the file
  and on the terminal: an empty row with no sentence beside it reads as "the
  owner did nothing", which is a kind of lie.

**AC4 is not answered, and this release does not pretend otherwise.** `mind
observe audit --vendor claude --root <dir>` is the instrument: it samples twenty
transcript files, derives records through the same adapters a seed uses, shows
each derivation beside the line it came from, and takes `y`/`n` per field. It
needs a terminal and has no `--yes`, for the same reason `observe enable` has
none. It writes nothing, so it needs no consent and can be run before capture
exists — which means the **seed** path is answerable the day this lands. The
**hook** path stays unanswered until there are real hook records to sample;
proposed: re-run after the first seven days of capture. `origin` is not among the
judged fields at all, because a transcript cannot answer it. No percentage over
the test suite's fixtures may be quoted as AC4's number — those records were
invented by the tests.

**One AC1 case is deferred.** AC1 withdraws "decisions confirmed or refused"
*except where a vendor provides a structural field*, which today means grok's
`permission_resolved` only. It is not built, and is recorded as task w5b: grok has
no hook, its records can only arrive through a seed, no seed has been run on this
machine, and an extractor for a shape nothing has produced is a mechanism that
cannot be tested. The three kinds AC1 keeps are unaffected. `ACTIONS_LIMITS` says
this where an owner reads it, not only here.

**Erase gains one sentence, not one place.** `PlaceId` stays the five AC1 names;
`actions/summary.json` is not a sixth place but a *derivative* of the observer
place, so that place now carries `GIT_UNDELETABLE` by reference beside its own
list, and its `what` names the path. An erase run searches the agent working tree
for the identifier anyway; the summary holds nothing to find, which is the point
of the line above.

### 9. AC4's third address is `turn`, and the notice there has no off switch

**Added 2026-09-21, implementing task w3b.**

S7.2 AC4 — announce what cannot be deleted *before* the data exists at that
address — was answered at two addresses and open at a third. `mind new` prints
`GIT_UNDELETABLE` before the repository exists, `ensureObserverDir` requires a
`CaptureNotice` before the capture tree does (§6's last bullet), and `turn` said
nothing at all before handing the owner's prompt to a cloud CLI. That is the
address mind can never reach afterwards: the vendor's copy.

**The notice is per dispatch, not per turn.** `FallbackExec` decides at run time
who is really handed the text, so the line lives in `AnnouncedExec` — one wrapper
per chain member, the position `RecordingExec` already occupies — and a chain
whose first member is off PATH names nobody, because nobody was told anything.
`turnChain` accepts `AnnouncedExec` and nothing else, and a test refuses `new
FallbackExec(` anywhere under `src/` or `bin/` but `src/exec/egress.ts`, so the
sanctioned door is a `tsc` matter and the unsanctioned one is a gate.

**What counts as leaving is `notLocal`, asked of the raw backend.** An ollama on
a loopback literal prints nothing — a warning on a run where nothing happened is
how a reader learns to skip the one on the run where something does. An ollama
on a *name* (`localhost` included) prints a different line naming the host, not
the vendor sentence, because mind knows nothing about somebody else's machine
and saying otherwise would be inventing a fact.

**There is no way to silence it, and that was the owner's decision over the
plan's.** The plan proposed `--ack-egress`: print until a person acknowledges,
then stop. It was refused on four grounds worth keeping: every limits list in
this repo prints on every run by design, and the first exception is the
precedent for the second; this is the most irreversible fact mind handles, so
it is the worst candidate for silencing; noise is real, but the answer is a
shorter line rather than a quieter one; and a flag an agent can pass in the
owner's name is the failure `observe enable` avoids by having no `--yes`. So the
notice is one line, it prints every time, and `src/exec/egress.ts` reads no
environment and imports no filesystem — there is nothing to set and nowhere to
remember a previous run.

**One sentence, one string.** `UNDELETABLE[2]` became the exported `VENDORS_HOLD`
in `src/ledger/store.ts`: `ledger forget` prints it after a send, `EGRESS_LIMITS`
prints it beside the notice that goes before one, and the tests assert identity
rather than wording twice. `PLACES` stays closed at five (AC1) — a vendor's copy
has no path here to search or delete, so it is `NOT_SEARCHED`, said out loud, not
a sixth place.

**What it still does not prove.** That anybody read the line: it witnesses a
write, and a turn run from a script writes to a stderr nobody opened.
`soul verify` also dispatches to vendors and is not covered here — it sends
mind's probe and the soul rather than the owner's words, and it is reported
rather than fixed. Both limits are in `EGRESS_LIMITS`, which `mind backends`
prints.

## Consequences

- `mind new` creates a repository, installs its guard, and stops. It never
  commits, never adds a remote, and offers no flag that would; the first commit
  is the owner's. S0.4 AC2 ("no path in mind can push") is checked by §5's
  three layers rather than by the absence of code, because absence turned out to
  be exactly what the old check could not see.
- `mind rebuild --check` is the read-only half, and `doctor` (S0.2, built in
  w6) calls the same `derivedStatus` rather than re-implementing "is this stale?" a
  second time. `doctor --agent <dir> --subject <id>` reports it as a warning: a
  stale `.mind/` costs one rebuild and is never a reason for a non-zero exit.
- The template contains no directory for personal data, because a directory is
  an invitation. The `memory/README.md` it ships says where that data lives
  instead — a path mind now resolves in code (`personalDir`) rather than only
  describing — and that nothing should be ingested until the local-only guard
  (S3.5) is done as well.
- The template still contains no `actions/` directory, for the same reason. It is
  created by `observe actions --write` and by nothing else, so a repository that
  has never been asked for a summary does not have a place waiting for one.
- §8's line is what S3.3 (pattern miner) and S3.4 (interest tracker) inherit:
  whatever they compute has to come out of `countPersonal` as integers over a
  vocabulary, or stay in the personal store. Neither may add a callback to that
  door — the test that fails if one appears is in
  `test/guard/personal-type.test.ts`.
  *Amended (S3.3, D-057):* the pattern miner could not work from counts — a routine needs the
  project, the order of events and the hour — so the owner opened exactly one more door:
  `src/observer/patterns.ts` unwraps the box in one function that writes to a writer it is handed
  (the terminal), stores nothing, and is imported only by `bin/commands/observe.ts`; the same test
  file now lists three allowed files and fails if anything else imports the miner. S3.4 still
  inherits the original line.
