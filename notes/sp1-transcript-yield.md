# SP-1 — how much does a transcript really yield?

Measured 2026-09-21 on this machine, by `scripts/sp1-transcript-survey.ts`.
Every number below is that script's output, transcribed. Re-run it — see **How
to reproduce**; the script itself was deleted once this note's decision was
taken — and the counts move by a few dozen records, because one of the four CLIs
is writing transcripts while the survey reads them.

**What this spike can and cannot establish.** It can say whether a signal is
*present*: whether a file parses, whether a call names a target, whether an
answer states success or failure. It cannot say whether an extraction is
*right*, because deciding that means reading the conversations — and an agent
that reads them has already sent them to a model, which is the thing `I-6` and
the MVP-lite hard stop exist to prevent. So `S3.2 AC4` — hand-check twenty
files, be ≥ 80% accurate — is **still open after this note**, and has to be done
by a person or by a local model after `S3.5`. Nothing here discharges it.

Nothing was ingested, copied or cached. No transcript was opened by hand: only
the script touched the files, and only counts came back from it.

---

## The answer, in one paragraph

The material parses perfectly and extracts well — and it is almost all from the
last seven weeks. 100% of 1,506 files and 100% of 356k lines read without a
single error; claude yields an action from 95.1% of its tool-use turns and grok
from 94.3%, both far past the 60% bar. But claude's files on disk start in
August 2026 and grok's start eleven days ago, so the 663 MB is not "the owner's
history", it is *the owner's recent history*, and re-reading all of it takes
five seconds. The pre-registered decision table fires on two rows at once — pass
on two vendors of four, and a backward reach of a few weeks — and the second one
is the one that should change the plan: **build the capture, not the dig.**

---

## 1 · What is actually there

JSONL files, after excluding directories that hold caches, packages and
snapshots rather than conversations:

| vendor | files | bytes | where |
|---|---|---|---|
| claude | 1,079 | 583.1 MB | `projects` (1,077), two strays |
| grok | 303 | 43.9 MB | `sessions` |
| codex | 103 | 34.8 MB | `sessions` (101), two strays |
| kimi | 21 | 1.0 MB | `sessions` (19), `user-history` (2) |
| **total** | **1,506** | **662.9 MB** | |

The exclusion list leaves out 53 further JSONL files (1.9 MB, 0.3%), almost all
grok's, under directories named for logs and temporary state. The survey's
`--discover` mode prints that comparison so the list can be argued with.

**The JSON files beside them are not transcripts.** 1,258 of them, 2.4 MB, and
the survey's `--format json` mode finds in all of them: zero tool calls, zero
records that look like a person typing, and 98–100% with no timestamp. They are
session registries, agent state and telemetry counters. This settles the
question the plan opened — a transcript is a JSONL file, and the file-count
mismatch in earlier measurements was JSON sidecars being counted in.

This also corrects backlog §3, which records "1,054 · 589 MB" for claude.
Measured today: **1,079 files, 583.1 MB**.

gemini and copilot were not surveyed. Four formats was enough to answer the
question this spike asks, and neither is in E3's path.

## 2 · Could it be read at all — bar ≥ 85%

| vendor | files read | files with no bad line | lines | parsed | line % | file % |
|---|---|---|---|---|---|---|
| claude | 1,079 | 1,079 | 274,640 | 274,640 | 100.0% | 100.0% |
| codex | 103 | 103 | 24,227 | 24,227 | 100.0% | 100.0% |
| grok | 303 | 303 | 55,544 | 55,544 | 100.0% | 100.0% |
| kimi | 21 | 21 | 1,444 | 1,444 | 100.0% | 100.0% |

Not one unreadable file and not one unparseable line, across all four vendors.
`S3.1 AC3` is met with room to spare and `S3.1 AC2` — skip and count a bad
schema rather than dying — has nothing to do here yet.

## 3 · Is one reader enough — no, four

Four dialects, sharing almost nothing at the top level:

- **claude** — tool calls are `tool_use` blocks nested inside `message.content`,
  answered by `tool_result` blocks in the following record. 102 printable
  top-level key names. Ids on both sides, ISO timestamps.
- **codex** — every record is `{type, timestamp, payload}`; calls are
  `function_call` inside the payload and **arguments are a JSON string**, so a
  reader has to parse twice. 4 printable top-level key names.
- **grok** — an event stream, not a conversation: 47,389 of 55,544 records
  (85.3%) are `phase_changed`. Calls are untyped objects carrying a name and
  arguments. The outcome is a separate `tool_completed` record **in a different
  file**.
- **kimi** — `TurnBegin` / `StepBegin` / `ContentPart` / `StatusUpdate`, and no
  tool calls at all in any of its 21 files.

What *is* common: every format stamps a record with a time and a session, and
three of four attach an id to a call. That is enough for a thin shared record
plus one adapter per vendor — the shape a neighbouring tool already uses for the
instruction side (backlog §3). It is not enough for a single parser, and a story that
budgets for one will be wrong by three adapters.

## 4 · Extraction — bar ≥ 60% of turns that have tool use

| vendor | tool-use turns | extracted | rate | upper bound |
|---|---|---|---|---|
| claude | 24,523 | 23,318 | **95.1%** | 99.9% |
| codex | 2,883 | 1,529 | **53.0%** | 82.4% |
| grok | 193 | 182 | **94.3%** | 100.0% |
| kimi | 0 | 0 | — | — |
| **weighted** | **27,599** | **25,029** | **90.7%** | |

"Extracted" is strict: the call is named *and* names something to act on.
"Upper bound" is the loosest defensible reading — the call is named and carried
arguments of some kind. The bar is judged on the strict column, as fixed before
the measurement.

codex's shortfall is three things, all visible in the parameter census: 806
`write_stdin` calls whose target is a running shell rather than a file, 221
`apply_patch` calls whose target is inside a patch blob, and 600 calls whose
names this survey's allowlist does not know. A reader written for codex would
recover most of that — but it would be a claim, and this spike did not test it,
so 53.0% is what stands.

The 50-file-per-vendor sample the backlog originally asked for gives the same
picture: claude 94.9%, grok 84.8%, codex 43.8%, kimi none. Whole-file numbers
are reported above because only they answer the cost question in §7.

### The four kinds `S3.2 AC1` asks for

| vendor | file edited | command run | other tool | name unknown | decision recorded |
|---|---|---|---|---|---|
| claude | 1,913 | 16,998 | 4,637 | 975 | **0** |
| codex | 221 | 1,242 | 820 | 600 | **0** |
| grok | 22 | 0 | 459 | 105 | **584** |
| kimi | 0 | 0 | 0 | 0 | 0 |

Three of the four kinds are a tool call wearing different names, and they are
there in quantity. The fourth — "a decision confirmed or refused" — exists as
structure **only in grok**, which writes `permission_requested` and
`permission_resolved` records carrying a `decision` field (`allow` on 565 of
them). claude, codex and kimi record approvals and refusals in prose, if at all.
Since claude is 88% of the bytes, that kind is effectively unavailable without
reading conversations.

### Does the transcript say whether it worked

| vendor | calls | answered in the same file | outcome stated | recoverable by joining files |
|---|---|---|---|---|
| claude | 24,523 | 24,521 | 17,082 (69.7%) — 16,265 ok, 817 failed | — |
| codex | 2,883 | 2,568 | 211 (7.3%) | 0 |
| grok | 586 | 586 | 0 | **565 (96.4%)** |

Three different failure modes, and only one of them is the transcript's fault:

- **claude** answers nearly every call, and states an outcome for 70% of them.
  Good enough to learn from.
- **grok** looks like it states nothing — until you notice that all 565
  `tool_completed` records, every one of which carries an outcome, match a call
  **in another file**. A reader that opens one file at a time reports 0%; one
  that joins across the directory reports 96%. That is a design constraint for
  `S3.1`, discovered here rather than in week three.
- **codex** is the real gap. 794 `item_completed` and 286
  `custom_tool_call_output` answers match no call at all, in their own file or
  any other. Outcome for codex would have to be reconstructed, not read.

## 5 · Whose behaviour is this

`S3.2 AC3` wants the owner's actions separated from the AI's own initiative.
Structurally, that separation is not there. Every tool call in every one of
these files was issued by a model; what varies is whether a person asked for it,
and that lives in prose.

The one handle that *is* structural is whether a human typed in the session at
all:

| vendor | records | look human-typed | sessions | sessions with no human turn |
|---|---|---|---|---|
| claude | 274,640 | 18,910 (6.9%) | 663 | **293 (44%)** |
| codex | 24,227 | 675 (2.8%) | 149 | 48 (32%) |
| grok | 55,544 | 364 (0.7%) | 366 | **292 (80%)** |
| kimi | 1,444 | 27 (1.9%) | 19 | 11 |

"Look human-typed" is an upper bound: hook output and injected system text
arrive as user records too, and telling them apart needs the text.

Two more numbers that matter for an index:

- **claude sub-agent records: 42,415 (15.4%).** Fleet work, not the owner's
  behaviour. Learning from it would teach the agent the habits of the agents.
- **claude duplicate records across files: 14,529 (5.3%).** Resumed sessions
  replay what came before. An ingester without a record-id check would count
  those actions twice. Other vendors: four records in total.

So roughly 44% of claude's sessions and 80% of grok's are work nobody typed in,
and a further 15% of claude's records are sub-agents. Whatever E3 ingests has
to filter on this first, and after filtering the "owner's own behaviour" is a
much smaller pile than 663 MB suggests.

## 6 · How far back, and can the clock be trusted

**This is the finding that should change the plan.**

| vendor | files by month | span of files |
|---|---|---|
| claude | 2026-08: 66 · 2026-09: 1,013 | **~7 weeks** |
| grok | 2026-09: 303 | **11 days** |
| codex | 2025-12: 19 · 2026-01: 39 · 2026-06: 5 · 2026-08: 19 · 2026-09: 21 | 9.5 months, 103 files |
| kimi | 2026-01: 4 · 2026-02: 1 · 2026-09: 16 | sparse |

Record timestamps reach back further than the files do — claude's earliest is
2025-12-28 — but only 1,730 of its 230,417 timestamped records (0.75%) predate
August 2026. Those are older material quoted inside recent files, not older
sessions. The files themselves are seven weeks old at most.

Nobody deleted anything: `cleanupPeriodDays` is unset, so this is vendor
retention doing its job. Which means the window does not grow by waiting, and a
backfill run next month reaches back exactly as far as one run today.

Records carrying no usable timestamp: claude 16.1%, codex 0.0%, grok 2.9%,
kimi 39.2%. claude's 16% are mostly attachment and hook records, which carry no
action either, so the overlap with the useful part is small.

## 7 · What a pass costs

| | files | bytes | time |
|---|---|---|---|
| everything | 1,506 | 662.9 MB | **5.0 s** (131.7 MB/s) |
| changed in the last day | 87 | 94.0 MB | 0.4 s |
| changed in the last 7 days | 382 | 215.0 MB | 0.9 s |

Warm page cache. Dropping it needs root, so these are floors, not cold-start
numbers — but they are the numbers that apply to a re-index on a machine that
has been running all day.

Five seconds. **Re-index cost is not a constraint on any design here**, which
removes the argument for an incremental reader, a watch mode, or a cache that
would then need invalidating. Read everything, every time.

## 8 · Against the bar, which was fixed before the numbers were seen

| vendor | readable (≥ 85%) | extracted (≥ 60%) | |
|---|---|---|---|
| claude | 100.0% | 95.1% | **PASS** |
| grok | 100.0% | 94.3% | **PASS** |
| codex | 100.0% | 53.0% | **FAIL** |
| kimi | 100.0% | — (no tool calls) | **FAIL** |

Two of the four decision rules fire, and one partially:

**Row 2 — "pass on some vendors only" → do E3 for those, say who is cut and what
it costs.** Cutting codex and kimi loses 35.8 MB of 662.9 MB (5.4%) and 2,883 of
27,599 tool-use turns (10.4%). codex is the one worth revisiting: it parses
perfectly and its 53% is partly this survey's vocabulary, not the format's.

**Row 3, in part — "outcome weak or target often missing" → cut `S3.2` to the
kinds that are really accurate.** The fourth kind, a confirmed or refused
decision, has a structural form in grok alone. It should come out of `S3.2 AC1`
for every other vendor rather than being attempted in prose.

**Row 4 — "history reaches only a few weeks, or noise and duplicates dominate" →
do not dig backwards; capture at the hook instead, and say what week three
becomes.** claude, which is 88% of the material, reaches seven weeks. grok
reaches eleven days. Duplicates are 5.3% and sub-agent records 15.4% of claude,
and 44–80% of sessions have no human in them at all.

Row 4 outranks row 2. The dig works — it just does not reach far, and it never
will, because the limit is vendor retention rather than effort.

---

## Recommendation

**Do not build E3 as a backfill. Build the capture, and treat the history as a
one-off seed.**

1. **`S3.1` survives, with its job changed.** It is a reader fed by a capture
   hook at the moment of the action, not a scanner of 663 MB. The on-disk
   history becomes a *seed*: run the reader over it once, get seven weeks, and
   never depend on it again. At 5 s a pass, running the seed is nearly free, so
   this is not an argument against doing it — only against building on it.
2. **Seed from claude and grok only.** codex and kimi stay out until someone
   writes a codex-shaped reader; the cost of leaving them out is 5.4% of bytes
   and 10.4% of tool-use turns, stated above so the choice can be reversed
   knowingly.
3. **Drop the fourth kind from `S3.2 AC1`** except where a `decision` field
   exists. Extracting "the owner confirmed this" from prose is a different and
   much harder story, and pretending otherwise is how an extractor ends up 60%
   accurate on a criterion that demanded 80%.
4. **`S3.2 AC3` is not answerable from these files.** The only structural
   separation available is "did a human type in this session at all", which
   removes 44% of claude's sessions and 80% of grok's. If ordered-versus-proposed
   matters — and it does, it is the whole point of "จำสิ่งที่เจ้าของ *ทำ*" — the
   capture hook has to record it at the moment, because the transcript does not.
5. **The grok reader must join across files**, or report every outcome as
   unknown while the answer sits in the next file along.
6. **Any ingester needs a record-id check.** 5.3% of claude records appear more
   than once, and an action counted twice is a preference invented.

### What week three becomes

Not "`S3.1` reader + `S3.2` extractor over 589 MB". Instead:

- a capture hook that writes mind's own action record at the moment the action
  happens — with the one field the transcripts cannot give us, which is whether
  the owner asked for it;
- a seed importer for claude and grok, run once over the seven weeks that exist;
- `S3.5` before either of them touches anything, unchanged.

That is a smaller week three than the plan assumed, and it produces a growing
record instead of a fixed and shrinking one.

### Suggested backlog edits — not applied

`.scrum/` was not touched. If the owner agrees, these are the changes:

- **§3** — claude transcripts measured 2026-09-21: 1,079 files, 583.1 MB. Add:
  *"files on disk span 2026-08 → 2026-09; vendor retention, not deletion."*
- **`S3.1`** — restate as "read the capture stream, and seed once from claude and
  grok history". Add an AC: *"answers that live in a different file from their
  call are joined, or reported as unknown — never silently dropped."*
- **`S3.2 AC1`** — four kinds becomes three, plus "a decision, where the vendor
  records one as a field".
- **`S3.2 AC3`** — mark as not satisfiable from transcripts; move the requirement
  onto the capture hook.
- **§8 A1** — "transcript สกัดพฤติกรรมได้จริง" is **confirmed for the present and
  refuted for the past**: 90.7% of tool-use turns yield an action, over a window
  that is seven weeks wide and does not grow.

---

## How to reproduce

The survey was deleted in `gate4`. Git still holds it at the last commit where
it stood, `42e51ff4df1998d98f5cf0bf34feb66322e31ee0`:

```sh
git show 42e51ff4df1998d98f5cf0bf34feb66322e31ee0:scripts/sp1-transcript-survey.ts > /tmp/sp1-survey.ts
bun run /tmp/sp1-survey.ts --self-test     # the five privacy guards, on invented data
bun run /tmp/sp1-survey.ts                 # every number in §1–§8
bun run /tmp/sp1-survey.ts --format json   # §1's claim that those files are not transcripts
bun run /tmp/sp1-survey.ts --discover      # §1's file counts, and what the exclusion list hides
```

Counts drift by a few dozen records between runs: claude writes transcripts
while the survey reads them.

`scripts/sp1-transcript-survey.ts` was an instrument, not engine — outside
`tsconfig`'s `include`, outside the coverage gate's reach, and written to be
deleted together with its decision. D-024 made that decision: capture from here,
not a backfill, which is what §8 above recommends. Nothing was left waiting on a
second reading of the same seven-week window, so the script is gone and with it
the only code in this repository that read the owner's real transcripts — a
straight reduction in the surface `I-3` and `I-6` have to cover. Its own guards
were tested by `test/scripts/sp1-survey.test.ts`, which went with it.

What did **not** go is the watch on this note. `test/notes/sp1-note.test.ts`
still runs on every `bun test`: the note outlived the script, it is the artefact
a person edits by hand afterwards, and a sentence added later to make a number
clearer is exactly how a path or a session id gets into a file meant to be
opened.

## What kept the conversations out of this note

Five guards, all five exercised by `--self-test` on invented data and by the
test suite on every run. Result today: **5/5 hold.**

1. **Tool names pass an allowlist.** Anything else becomes `mcp` or `other` — an
   MCP server name is frequently a company, a host or a person.
2. **Key names must look like identifiers and appear in ≥ 5 files.** A map keyed
   by a path is data; a key seen once is data. 35 of claude's top-level key
   names were withheld by this rule, and the report says so rather than
   pretending it saw 102 of 102.
3. **No exception text is ever printed.** `JSON.parse` quotes the input it
   choked on, so a parse-error message is a transcript excerpt wearing a
   diagnostic's clothes. Parse failures are counted, never described. The same
   applies to the second place a value could have leaked through an error — the
   helper that parses codex's arguments string — which swallows its exception
   for the same reason.
4. **Nothing is reported per file.** Time is reported per month, volume per
   vendor. Session ids, record ids and call ids are hashed on the way in, so
   printing one is not possible rather than merely unintended.
5. **Values are never read, only shapes.** The walker records that a call had a
   `file_path`, never which one.

And the rule that made the rest of it necessary: no transcript was opened with a
file-reading tool, a pager or a search. Only the script touched them, and only
counts came back — because an agent that reads a conversation to summarise it
has already sent it somewhere, which is exactly what `I-6` forbids.
