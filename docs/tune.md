# Harness tuning: `mind soul tune` (S21.5, D-193; the proof S21.7, D-195; reflection and lessons S21.6, D-196)

`mind soul tune` is one round of propose, probe, select over an agent's task set (`evals.md`, see
[eval.md](eval.md)). It asks the agent's own backend for two rewrites of the `role.md` body, runs the
same tasks on each, and judges them on tasks the proposer never saw. It adopts nothing: adoption is shut
until the tuner has a valid proof (S21.7, below).

```
mind soul tune <dir> --subject <id> [--repeat k] [--backend b] [--model m] [--dry-run]
mind soul tune adopt <runId> <dir> --subject <id>      # refused unless the tuner has a valid proof
mind soul tune undo <dir> --subject <id>               # revert the last tune commit
mind soul tune --selftest [--subject <id>]             # prove the tuner; with a subject, write the proof
mind soul tune proof --subject <id>                    # is there a valid proof for this build, and why not
mind soul tune lessons --subject <id> [--all]          # the lessons the reflection proposed (writes nothing)
mind soul tune lessons accept <runId> <dir> --subject <id>   # yours, at a terminal: append to <dir>/lessons.md
mind soul tune lessons reject <runId> --subject <id>         # yours, at a terminal: not proposed again
```

## What it refuses to start

- the soul does not load, `evals.md` has no train task or no held-out task (`mind eval split` proposes one);
- the brake is on (`STOP`, `mind stop`; `mind autonomy resume` clears it);
- the soul has edits that are not committed: the base of a round is a commit;
- `personal/evals/` would be inside git.

## One round

1. **Base run.** The task set (train and held-out) on the committed soul, `--repeat k` times, recorded
   with its answers (`personal/evals/`, outside git, 0600).
2. **Two proposer calls**, INV (how the agent works) and DOM (what a practitioner knows), through
   `mind turn` on the agent's own backend (`--backend`/`--model` override it), at level 1, with no recall
   and no proposals. The egress notice, the ledger and the fence apply as to any turn. The mission is
   built by `src/soul/tune/prompts.ts` from the **train failures only**: the ask, one answer, pass or
   fail. It never holds an `expect` or `reject` phrase, a held-out ask or answer, or anything from
   `person.md`. The leak guard checks the finished text before every send, in the relaxed mode (a
   passing answer may hold its own phrase; a held-out ask is looked for everywhere); a mission that leaks
   is refused and no model is asked.
3. **Validation.** An invalid answer gets one retry with the issues listed, then that dimension keeps the
   base. A candidate is the base `role.md` with its body replaced: the frontmatter is the base's byte
   for byte, the soul loads through `parseSoul`, name, role, prohibitions, scope and extra are
   unchanged, and the body is within the size budget (D-190). `person.md`, `autonomy.md` and
   `triggers.md` are the base's own bytes.
4. **Branches.** `tune/<runId>-inv` and `tune/<runId>-dom`, made with git plumbing from the base's
   tree (`hash-object`, a throwaway index, `commit-tree`, `update-ref`). No checkout, no stash, no
   worktree, no hook; HEAD, the index and the working tree are not touched. The agent is the author.
5. **Probe.** The same tasks on each candidate (`mind eval --compare <branch> --base-run <base>`, so the
   base is not asked twice), then T6 on the held-out set: adopt only if the held-out pass rate rises and
   no held-out task loses a pass. Under **6 held-out tasks the verdict is always keep-base**. If both
   pass, the larger held-out gain wins; a tie keeps the base.
6. **Reflection** (next section): what each edit did, and at most one lesson, kept as a proposal.
7. **Report and record.** Per candidate: train and held-out deltas, every task that changed, the verdict,
   the body diff, the reflection; the turns and tokens the ledger counted since the round began. The record is
   `mind/tune-run@1` in `personal/evals/tn-<time>-<hex>.json` (0600), linking the base run, the candidate
   runs, the branches and the verdict.

The brake is asked between every step, the reflection included. When it is on the round ends, the branches it made are deleted
and no record is written.

`--dry-run` builds both missions from the newest recorded run of this soul and task set (or from
placeholders when there is none), checks the leak guard, prints them, and calls no model.

## Reflection and lessons (S21.6, D-196)

After the verdict (which it never changes) the round asks the agent's own backend one more question, through the
same path as the proposer (`mind turn` at level 1, no recall: the egress notice, the ledger, the fence and the
brake apply, T8). `reflectMission` (D-190) gets the base soul, the body diff and notes of every candidate, the train
answers of base and each probed candidate, and per run **held-out as numbers only**: how many tasks, the pass rate,
how many flipped from pass to fail. No `expect` or `reject` phrase and no held-out ask is in it: the leak guard runs on
every prompt before it is sent, in the same relaxed mode as the proposer's, and a mission that leaks is not sent (the
record says "skipped"; the round is unaffected). Nothing is asked when no candidate changed the body.

The answer is `parseReflection`: one row per edited passage (`helped`, `hurt`, `no observed effect`, `confounded`;
a candidate run once per task can only be `confounded`) and at most one lesson `{cue, lesson, evidence}` citing rows.
An invalid answer is retried once with the issues listed; after that there is no lesson. A lesson that rests only on
`confounded` rows is declined (the rows are kept). A lesson is also refused when it holds an `expect` or `reject`
phrase of any task, a held-out ask, a line of `person.md` or anything the egress filter flags as personal or secret
(I-6), or runs over 600 characters a field; the retry says which kind, never the text. It is not proposed again when
the owner refused it before, or when `lessons.md` already holds it.

Rows and the proposed lesson are stored in the `mind/tune-run@1` record under `reflection` (outside git, 0600;
`status` is `done`, `skipped` or `failed`, with `reason`). **Nothing is written to the agent repository.**

```
mind soul tune lessons --subject <id> [--all]                 # cue, lesson, evidence rows, run; writes nothing
mind soul tune lessons accept <runId> <dir> --subject <id>    # the owner's, at a terminal, then a typed yes
mind soul tune lessons reject <runId> --subject <id>          # the owner's, at a terminal
```

`accept` and `reject` refuse without a terminal (no `--yes`: a program running as the owner could pass it). `accept`
runs the leak check again against the task set as it is now, shows the lesson, and on a typed `yes` appends one entry
to `<dir>/lessons.md`, a git-tracked file at the agent root beside `evals.md`; **Mind never commits it**, the owner
does. `reject` records the refusal in `personal/evals/lessons-decisions.json` (0600) by a normalised key of cue and
lesson, as a refused proposal is kept (D-029), so the same lesson is not proposed again.

```
+++
schema = "mind/lessons@1"
+++

## Lesson: A question about restarting a service after a deploy

- cue: A question about restarting a service after a deploy
- lesson: Check the unit's status before restarting it, and name the unit.
- evidence: rows 1, 2: t1 passed once the check was named
- run: tn-20261020T101500Z-ab12
- date: 2026-10-20
- soul: <the base commit of the round>
```

Per T7 only what is in `lessons.md` exists for the next proposer and for recall:

- **The proposer.** `selectLessons` (`src/soul/lessons.ts`): a lesson matches when its **cue** shares words with the
  asks of the **failed train tasks** (Unicode word segments, Thai included; words under 3 characters and a short
  stop list dropped). The score is the number of distinct shared words; a lesson needs 2, or 1 when its cue is a
  single word. Best score first, then file order; at most 3 lessons and 1500 characters of them in all (one that would
  pass the cap is skipped, a smaller one after it may fit). A lesson that no longer passes the guard (a hand-edited
  file) is left out, with a line. The mission shows them under "Lessons accepted earlier" as hypotheses, in the
  fenced evidence; the record's `lessonsShown` names their runs.
- **Recall.** `readMemory` reads `lessons.md` at the agent root as the second source outside `memory/`, one piece per
  entry (heading `Lesson: <cue>`), so it is indexed, forgotten-from and rebuilt like a note, and a matching lesson
  reaches a turn **inside the existing cap** (4500 characters, 12 hits, D-075), which is unchanged. A file that is
  not a lessons file is reported as unreadable and indexes nothing. `mind eval --recall-only` prints
  `lesson pulled: "<cue>" (<run>)` under a task that had one attached, and `--json` rows carry `lessons`, so the
  effect of a lesson stays measurable: run it before and after accepting.

Changing the tuner voids the proof (next section): after S21.6 lands, run `mind soul tune --selftest --subject <id>`
again. The selftest's leak control (d) now also scans, in strict mode, what the reflection receives, and its twin
leaks through the reflection as well as the proposer.

## Adopt and undo

`adopt` is shut by `personal/evals/tuner-proof.json`, a valid proof for this build (next section). With one, `adopt` makes one commit on the current branch, authored by
the agent (never the owner), whose tree is the current one with the candidate's `role.md`; the message
carries the run id, the base and candidate SHAs and the held-out numbers. It refuses when the brake is on,
when HEAD is not the round's base, when the soul has edits, or when the branch no longer names the
recorded commit. The owner is told after each adoption (printed; the record keeps it). `undo` makes a
revert commit of the last tune commit that is not undone, unless `role.md` has changed since.

Cost: tasks × 2 modes × `k` turns for the base and for each candidate, plus 2 to 4 proposer turns; at 24
tasks and `k` = 2 that is about 144 turns. `--dry-run` costs none.

## The proof (S21.7, D-195)

The owner's condition for T5 is that Mind commits an adopted candidate on its own only once the tuner is
proved. `mind soul tune --selftest` is that proof. It needs no model and no network: it makes a throwaway
agent repository in a temp directory under the state root (removed on every exit, signals included) and runs
the real round on it, with only two things scripted: the proposer, and an eval engine that grades by what the
role body says (`RULE-<id>` passes a task, `BREAK-<id>` fails it, `FLAKY-<id>` passes it once in two). The leak
guard, the T4 check, the git plumbing, the T6 rule and `adopt` are the code a real round runs.

| control | what must hold |
|---|---|
| (a) noop | a proposer that returns the body unchanged, one that says KEEP_BASE and one that changes only wording all end in KEEP_BASE; HEAD does not move; `adopt` refuses ("has no winner") |
| (b) good | a planted edit that makes held-out tasks pass is selected (held-out rises, no pass→fail); `adopt` first refuses with no proof, then, with a proof sealed for the throwaway, commits as the agent (not the owner), the message names the run id, both SHAs and the held-out numbers, only `role.md` changes, the owner notice is printed |
| (c) harmful | a held-out regression (h3 pass→fail while two others pass), an overfit (train up, held-out down) and a stable pass turned flaky are each rejected, and the reason names the task or `pass→flaky` |
| (d) leak | expect and reject phrases, held-out asks and `person.md` text are planted; the real mission path runs in **strict** leak-guard mode (relaxed in a real round); what the fake proposer actually received is captured as bytes and scanned for every planted string; the train asks must be in it, so an empty capture cannot pass |

**A control that cannot discriminate is a failure.** Each control is also run against a sabotaged twin and
must fail there, and fail for the sabotage's own reason: a selector that adopts on a tie (a), one that never
adopts (b), one that always adopts (c), a mission builder that leaks with its guard off (d). The twin swaps
one part of the round (`TuneParts` in `round.ts`); nothing else differs. A control that passes its twin is
blind and the selftest fails. This is the style of `scripts/cli-parity.ts --selftest`: controls that run.
Exit 0 only when all four controls pass and all four twins are caught; the output gives an evidence line per
control and per twin.

With `--subject <id>` and a passing run, the selftest writes `personal/evals/tuner-proof.json`
(`mind/tuner-proof@2`, 0600). It binds to:

- the engine's **version** and **git commit** (D-193); a build that is not a source checkout has neither a
  commit nor sources to digest, so it can neither make nor honour a proof;
- **`sourceSha256`**, a digest of every `.ts` file under `src/soul/tune/`, of `src/soul/eval-compare.ts`
  (T6, `selectByRule`) and of `src/soul/evals.ts` (the split and the held-out minimum). Changing the tuner
  voids the proof even before it is committed;
- **`digest`**, a sha256 over every other field (the controls, the twins, the evidence lines, the time), so
  a record edited by hand fails validation.

`mind soul tune proof --subject <id>` prints whether the proof is valid for this build, when it was made,
what each control saw, and otherwise why not (no record, an older or hand-made file, the digest, another
version or commit, a changed tuner, a failed control, a twin not caught). `adopt` runs the same check.

**What this is not.** It is tamper-evidence against accidents and careless edits, not security. The owner, or
an agent running as the owner, can read the sources, compute the digests and write a record that validates:
nothing in it is secret. It shows that the controls were run on this code, not that nobody could forge them.
The proof also does not cover code outside the files above (the eval runner, `mind turn`, the spawn guard);
the real-model behaviour of the proposer is the owner's own check (the plan's release check on a machine with
a local model).
