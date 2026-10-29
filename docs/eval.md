# mind eval

`mind eval <dir> --subject <id>` runs the job's task set (`evals.md`, schema `mind/evals@2`, at least 20 real tasks; `mind/evals@1` still reads) and says how much of the job the agent does: once with the soul alone (`--no-recall`) and once with recall (soul + RAG). Each task is a real `turn`, held at level 1, and in the ledger like any other. The grade is mechanical: every `expect` phrase present and no `reject` phrase present (D-073). No model grades a model.

`--recall-only` asks no model: it checks whether what recall would attach already holds every `expect` phrase.

## Train and held-out (S21.2, D-191)

A task may say which side of a split it is on:

```toml
[disk-alarm]
kind = "incidents"
ask = "What broke on Tuesday?"
expect = ["disk full"]
split = "heldout"   # or "train", the default
```

`split` needs schema `mind/evals@2`. A `mind/evals@1` set still parses, every task train, and a `split` under @1 is refused. Any other value is refused by line.

`--split train|heldout|all` (default `all`) runs one side. The report adds a block per side, always both:

```
by split
  train       18 task(s)   soul 55.6%   soul+rag 66.7%   both 61.1%
  heldout      6 task(s)   soul 50%   soul+rag 66.7%   both 58.3%
Held-out numbers are what a tuning decision is judged on; train numbers are what a tuner may look at.
```

**Held-out numbers are what a tuning decision is judged on.** A held-out set of fewer than 6 tasks is flagged as too small to judge: at 6, one task moves the held-out rate by 16.7 points; at 5 it is 20, and one flaky task decides the verdict. 6 is also a quarter of the 24-task set the harness-tuning plan costs. A run with no held-out tasks says it cannot judge a tuning decision at all.

### Proposing a split

`mind eval split <dir> --subject <id> --heldout <n> [--seed <s>] [--set <file>] [--write]` picks n held-out tasks (1 to tasks − 1) stratified by `kind`: each kind gets its share of n by largest remainder. Inside a kind the draw is sha256(seed, task id), so the same seed gives the same split whatever order the file lists its tasks in (the default seed is `mind`). It prints the proposal; `--write` puts `split = "heldout"` under exactly those tasks, removes other `split` lines, raises the schema to @2, and checks the result parses back to that split before it writes. A set written in a shape it cannot edit (inline tables) is refused with the reason. `evals.md` is the owner's file in git: Mind changes it only on `--write` and never commits it.

## Repeats

`--repeat <k>` (a whole number from 1 to 10, default 1) answers each task k times in each configuration. A task then counts as its pass rate, passes / k, and every percentage is passes over tasks × k. When k > 1 the report adds one line per task and configuration:

| Verdict | Meaning |
|---|---|
| `stable pass` | passed all k times |
| `stable fail` | failed all k times |
| `flaky` | passed some of the k times |

A flaky task is noise. A change to the soul that moves only flaky tasks has not been shown to do anything. With k = 1 the report is the same as before repeats existed.

## Recorded runs (D-189)

Every run is kept as one file, `$XDG_DATA_HOME/mind/<subject>/personal/evals/<runId>.json` (directory 0700, file 0600, written whole). It is under the subject's personal directory, outside git, because an answer can hold personal data (owner ruling T1 of the harness-tuning plan). Mind refuses to record when that directory resolves inside a git checkout; `--no-record` runs without keeping anything. `mind erase` removes the runs with the rest of the personal directory.

The record, schema `mind/eval-run@2` (`@1` records, from before the split, are still read as runs in which every task was train):

| Field | What |
|---|---|
| `runId` | `ev-<UTC time>-<4 hex>` |
| `startedAt`, `finishedAt` | ISO times |
| `subject` | the subject id |
| `soul.gitTree` | `git rev-parse HEAD:<soul dir>`, or null outside git, before a first commit, or when the soul is not committed |
| `soul.dirty` | the soul files differ from HEAD or are not in it; null outside git |
| `soul.contentSha256` | sha256 over each soul file's name, size and bytes, in name order; always present |
| `soul.files` | the files hashed: everything under a `soul/` directory, or only `role.md`, `person.md`, `autonomy.md` and `triggers.md` when the soul sits in the given directory itself |
| `evalsSha256` | sha256 of the task-set file |
| `backend`, `model` | as passed, or null for the default |
| `recallChars`, `repeat`, `modes`, `tasks`, `split` | how the run was made (`split` is the `--split` given: `train`, `heldout` or `all`) |
| `keptAnswers` | whether `results[].answer` is present |
| `results` | one row per attempt: task, kind, mode, attempt, split, pass, missing, rejected, route |
| `report` | the printed report: per mode, per kind, per split (`bySplit`), per task (`byTask`), and the flaky count |
| `compare` | only on the two runs of a `--compare`: `{ id, role: "base" \| "candidate", ref, commit }` |

Answers are not kept by default. `--keep-answers` stores each answer in its row; they are in the ledger already, but the record then holds them too.

## Listing runs

`mind eval runs [<dir>] --subject <id> [--json]` lists the recorded runs, newest first. The directory is optional; runs are found by subject.

```
ev-20261019T090000Z-bbbb  2026-10-19 09:00  sha abababab    default/default       soul 50%  soul+rag 50%  ×2  3 task(s) · 2 flaky
ev-20261018T080000Z-cccc  2026-10-18 08:00  tree 77777777*  ollama/stub           soul 0%  soul+rag 0%  ×1  1 task(s)
```

The soul column is `tree <8 hex>` (the git tree) or `sha <8 hex>` (the content hash, outside git); `*` marks a soul that differs from HEAD. A run with held-out tasks ends with `· heldout <n> at <percent>%`, and a run from a compare with `· <compare id> base|candidate`. `--json` prints every record without its `results` rows. A file in the directory that is not a run record is named on stderr and left alone.

## Comparing two souls (S21.3, D-191)

`mind eval <dir> --subject <id> --compare <git-ref> [--split heldout] [--repeat k]` answers the same tasks twice: with the soul in the working tree (the base) and with the soul the agent repository held at `<git-ref>` (the candidate). Both runs are recorded as normal runs, linked by a compare id (`cmp-<UTC time>-<4 hex>`), and the command prints what changed. It is mechanical: no model judges (D-073).

The candidate soul is written out of git's object store with `git cat-file` into a temporary tree under the state root, `$XDG_STATE_HOME/mind/scratch/eval-compare/`, never inside the agent repository. It is not a `git worktree add`: Mind runs only the local, read-only git verbs of its spawn guard, and a checkout would also run the repository's hooks and smudge filters. Only the soul comes from the ref (everything under a `soul/` directory, or `role.md`, `person.md`, `autonomy.md` and `triggers.md` when the soul sits beside other files); the base agent's derived index (`.mind/`) is linked in, so recall finds the same notes on both sides and only the soul differs. The tree is removed on success, on failure and on Ctrl-C (exit 130); the agent repository is left exactly as it was. The candidate's record names the ref's tree (`soul.gitTree`, `dirty: false`).

A sample, from the test fixture (two tasks, the incident held out; the soul at `HEAD~1` answers the incident and gets the port wrong):

```
cmp-20261019T150334Z-a5ff — 2 task(s) × 2 modes, base ×1, candidate ×1
  base       tree d9a2e25b   working tree            ev-20261019T150334Z-d9ca
  candidate  tree 73291054   HEAD~1 = 258f5427       ev-20261019T150334Z-fa15

by split                base   candidate  delta
  train      1 task(s)  100%   0%         -100
  heldout    1 task(s)  0%     100%       +100

changes (task × mode) — 4 changed, 0 the same
  port                     soul      train    pass→fail   1/1 → 0/1
  port                     soul+rag  train    pass→fail   1/1 → 0/1
  incident                 soul      heldout  fail→pass   0/1 → 1/1
  incident                 soul+rag  heldout  fail→pass   0/1 → 1/1

T6 verdict: adopt — held-out pass rate rose 0% → 100% and no held-out task flipped pass→fail
Held-out is 1 task(s): too small to judge a tuning decision (at least 6).
Graded by the task set's phrases, not by a model. Nothing was changed: adopting a candidate is S21.5's.
```

A change is between the two verdicts of a task in one mode: `pass→fail`, `fail→pass`, `pass→flaky`, `fail→flaky`, `flaky→pass`, `flaky→fail`. Two flaky readings are the same, whatever their rates: that is noise.

### The selection rule (owner ruling T6)

The candidate is **`adopt`** only if the held-out pass rate (passes over attempts, both modes) rises **and** no held-out task loses a pass the base had: stable pass → flaky or stable fail, or flaky → stable fail. A tie, a fall, any such loss, or no held-out tasks at all is **`keep-base`**, with the reason. Train changes never decide it. A held-out set under 6 tasks is flagged as too small to judge beside the verdict. `--compare` prints the verdict and changes nothing: adopting a candidate is S21.5's.

### Comparing two recorded runs

`mind eval --compare-runs <runIdA> <runIdB> --subject <id> [--json]` compares two runs already recorded (A is the base) without asking anything. It refuses when the runs answered different task sets (`evalsSha256`), are of different subjects, or asked different tasks or modes, and says which.

`--compare <ref> --base-run <runId>` reuses a recorded run as the base and asks only the candidate; it is refused unless that run answered the same task set, subject, `--split` and `--repeat`. `mind soul tune` uses it so a round asks its base once ([tune.md](tune.md)).

## Coding tasks: `mind eval code` (S22.12 AC3)

`mind eval code <agent-dir> --subject <id> --set evals/code --backend claude,codex` asks each backend to make a repository's gate go green, on a fixed set of small tasks, and prints one line per backend with **n beside the rate**.

A task is a directory in the set: `task.toml` (schema `mind/code-eval@1`: `ask`, `gate` as an argv such as `["bun", "test/check.js"]` and never a shell line, `protect` globs, optional `gate_timeout_s`) and `repo/`, the files the bot starts with. One attempt:

1. a fresh copy of `repo/` in the temp directory; the gate runs on it and **must be red**. A task whose gate starts green, or cannot run, is `invalid`: it is listed apart and is not in n;
2. the bot gets `ask`, the gate command and the protected files, said out loud, and works in the copy through an ordinary `mind turn`;
3. the gate runs again. Which files changed is read from a before/after fingerprint of the tree, not from what the bot says.

Outcomes: `green`; `still-red`; `edited-protected` (the bot touched a protected file, so a green gate does not count: this is the cheat the setup invites, and it is a miss of its own); `no-answer` (the turn gave nothing: quota, refusal, the dial not allowing edits); `invalid`.

The turn is the agent's own, under its own dial: an agent held below the write level will not edit, and its tasks come back `still-red`. Every real run sends the fixture to a cloud backend (it is synthetic, and the egress notice prints as for any turn); nothing is recorded in the ledger by this command beyond those turns, and nothing reads the ledger back (D-022).

`evals/code/` holds three starter tasks (`fix-sum`, `slugify`, `first-word`). Three tasks is a direction, not a ranking, and one task is not equally hard for every backend's habits; the output says so. Not built: running the set automatically when a backend's model changes (S22.15 only tells you to).
