# Global instructions

<!--
  Synthetic fixture. Nothing here describes a real person, machine or account
  (D-021). It exists to be the *hard* case for `soul apply`: long, hand-edited,
  already shared with two other tools, and written in more than one script.

  If a single byte of this file changes when Mind writes its block, the test
  that reads it has caught the bug S1.2 AC4 was written about.
-->

These are the instructions a fictional operator keeps for every project on a
fictional machine. They are long because real ones are long, and the thing
being tested is what happens to someone's own writing when a tool edits the
file underneath it.

@./conventions.md
@./ports.md

## Who is reading this

A command-line coding assistant, on every session, in every directory.

## House rules

1. Say what was skipped. A summary that omits the part that did not work is
   worse than no summary.
2. Do not reformat a file you were asked to edit one line of.
3. Prefer the boring construct. The interesting one is someone's next bug.
4. Never commit credentials, never commit generated output, never push.
5. When two rules collide, stop and ask rather than picking one quietly.

## Languages

| Language | Used for | Notes |
|---|---|---|
| TypeScript | services, CLIs | strict mode, no implicit any |
| Python | data work only | type hints required |
| Bash | glue, under 40 lines | longer than that, write it in TypeScript |
| SQL | reports | no ORM-generated SQL in review |

## Style

- Names describe the thing, not its type. `retryBudget`, not `numRetries`.
- A function that needs a comment to explain *what* it does needs a better
  name. A comment explaining *why* is welcome and rarely written.
- Comments are prose. Full sentences, no telegraphese.
- Keep the diff small enough that a tired person can review it correctly.

## Testing

- A bug fix arrives with the test that would have caught it.
- Tests assert on behaviour, not on implementation detail.
- A test that has never failed is not yet a test.
- Fixtures are synthetic. Real data in a repository is a data breach waiting
  for a `git clone`.

## Reviews

- Review the diff, then review what the diff does not say.
- Ask about the case that was left out before asking about naming.
- "Looks good to me" on a change you did not read is a lie with a timestamp.

## Shell habits

```bash
# Always the explicit form, even when the short one works today.
rsync --archive --verbose --dry-run ./src/ ./backup/

# The quoted form, always. Paths contain spaces on somebody's machine.
find . -name '*.tmp' -print0 | xargs -0 rm --
```

## A note about markers

Some tools write into this file inside delimited blocks. One of them uses a
marker that looks like `<!-- mind:soul:begin ... -->` when written inline,
and that inline mention must not be mistaken for a real block. Here it is
again, indented inside a fence so that it is unambiguously an example:

```markdown
    <!-- mind:soul:begin subject=someone sha256=deadbeef lead=0 tail=0 -->
    ...identity text...
    <!-- mind:soul:end -->
```

A tool that treats the two lines above as a block it owns will delete this
whole section the first time it writes. That is the failure being tested.

## ภาษาไทย

ส่วนนี้เขียนเป็นภาษาไทยโดยตั้งใจ เพราะไฟล์จริงของคนทำงานหลายคนมีมากกว่าหนึ่งภาษา
และเครื่องมือที่อ่านไฟล์เป็นไบต์แล้วเขียนกลับ มักทำให้ข้อความที่ไม่ใช่ ASCII เพี้ยน
โดยไม่มีใครรู้ตัวจนกว่าจะสายเกินไป

หลักที่ถือ:

- ตรวจสถานะจริงก่อนลงมือ อย่าเชื่อสิ่งที่จำไว้เมื่อวาน
- ทำเท่าที่ขอ ไม่แถมสิ่งที่ไม่ได้ขอ
- สิ่งที่ย้อนยากต้องถามก่อนเสมอ
- บอกตรง ๆ เมื่อทำไม่สำเร็จ ดีกว่ารายงานที่ฟังดูดี

ตารางเล็ก ๆ เพื่อให้มีอักขระกว้างปนอยู่ด้วย:

| งาน | ความถี่ | ใคร |
|---|---|---|
| สำรองข้อมูล | ทุกคืน | อัตโนมัติ |
| ตรวจ log | ทุกเช้า | คน |
| อัปเดตระบบ | เดือนละครั้ง | คน |

## Long-form notes

The section below exists mostly to make this file long, because the property
under test is about a file of real size and not about a toy. Every line is
still something a person might plausibly have written.

### On estimates

An estimate is a probability distribution someone flattened into a number to
be polite. When the number turns out wrong, the distribution was still right.

### On logs

A log line without context is a log line that will be read once, at 3am, by
someone who does not have the context. Include the identifier.

### On retries

Retrying a non-idempotent operation is how one failure becomes several. Decide
which of the two the operation is before writing the retry.

### On caches

Every cache is a second source of truth that has agreed, for now, to keep
quiet. Name the invalidation rule in the same commit that adds the cache.

### On deadlines

A deadline moves the work, not the amount of it. Say which part is being cut.

### On meetings

A meeting that could have been a written decision costs the same as one that
could not, and produces less.

### On documentation

Documentation describes the thing as it is, not as it was planned. A document
that has drifted is worse than no document, because it is believed.

### On dependencies

Every dependency is a promise by a stranger to keep doing something for free.
Most keep it. Plan for the ones who do not.

### On configuration

Configuration is code that has escaped review. Check it in, or accept that it
is undocumented state on one machine.

### On error messages

An error message is written for the person who will read it at their worst
moment. Say what happened, what was expected, and what to do.

### On performance

Measure before, measure after, keep the numbers. An optimisation without a
before is a change of style.

### On security

The interesting attacks are boring: a leaked token, an open port, a stale
dependency. Spend the attention there.

### On backups

A backup that has never been restored is a hypothesis. Restore one on purpose,
on a schedule, and write down how long it took.

### On handovers

Write the handover as if the reader has never seen the system, because in six
months that reader is you.

### On naming

The second-best name that everyone already uses beats the best name that only
one person does. Rename once, at the start, or never.

### On flags

A feature flag with no removal date is a branch in the code that will outlive
everyone who understood it. Put the date in the comment.

### On migrations

A migration that cannot be run twice will be run twice. Write it so the second
run is boring.

### On on-call

The runbook is written on a quiet afternoon, not during the incident. If it
was written during the incident, rewrite it on the next quiet afternoon.

### On saying no

"No, and here is the smaller thing I will do instead" is an answer. "Maybe
later" is a way of saying no that costs someone a month of waiting.

<!-- A tool that is not Mind keeps its own state here. Do not hand-edit. -->
<assistant-memory-context>
# Recent activity

| id | when | what |
|----|------|------|
| #1 | Tue | Reviewed the retry policy and left it alone |
| #2 | Wed | Split the deploy script in two |
| #3 | Thu | Wrote down why the cache key includes the region |
</assistant-memory-context>

## End matter

Anything below this line was added by a tool, not by a person. The rule the
operator cares about is simple: what is above this line stays exactly as it
was written, byte for byte, forever.
