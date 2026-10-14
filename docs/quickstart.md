# Quickstart: your first agent, on a small model that runs on your own machine

By the end you will have an agent of your own, answered by a model that never leaves your computer, and you will
have tried two things with it: an agent that knows your notes, and an agent that does a chore on a schedule
(it proposes, you decide). Allow about half an hour, plus the model download. (The commands themselves took under a minute
on a warm small model when this page was followed by an automated reviewer; the rest of the half hour is reading and
typing, which is a guess for a person, not a measurement.)

Once Mind and the model are installed, nothing on this page sends your agent's words off your machine (as long as you
name `--backend ollama`, see step 6), and nothing on this page lets the agent act by itself: every category of its
autonomy stays at the default, **1: it proposes and does not do**.

> **About the output on this page, and how it was checked.** The output blocks were first recorded with a stand-in
> model server (one fixed sentence), so their *shape*, the lines around the answer and the exit codes are real, but the
> answer text was not a model's. On 2026-10-14 an **automated reviewer** (not a person) then followed this page,
> step by step, on Linux x86-64 in a throwaway home directory, with the **published release v0.11.0-alpha**, the first alpha (installed with
> its own `install.sh`, signature checked with cosign) and a **local model** (`gemma3:4b` on an Ollama that was already
> running; `llama3.2:3b`, which this page names, was **not** run). Every step below that was run is as printed, except where
> a note says otherwise; your answer text will be your model's own words and take seconds (`<n>s`). The steps that were
> **not** run: downloading cosign, installing Ollama and `ollama pull`. **No human has yet followed this page on a clean
> machine.** If you are the first, please [open an issue](https://github.com/bemindlabs/mind/issues/new/choose) with what
> you saw; the places most likely to be wrong are now steps 1 and 3.
>
> **A newer release than that run.** The review found seven engine bugs (B1 to B7); they are fixed in `v0.11.1-alpha`
> (CHANGELOG, 0.11.1). Where this page describes `mind setup` returning its prompt, offering
> `MIND_OLLAMA_MODEL`, the web page's schedule, and `mind erase` with no vector store or with imported notes, it describes
> `v0.11.1-alpha` and later; `v0.11.0-alpha` has the old behaviour in those places (`setup` needs `Ctrl-D`, and
> so on). The fixes were checked by tests in `v0.11.1-alpha`, not by a second run of the whole page.

## 1. What you need

- Linux, x86_64 or arm64, and your own user account. Mind needs no root. (macOS: the README says how to build from source.)
- `git`, `curl`, `sh`, `sha256sum`, and [cosign](https://github.com/sigstore/cosign) (step 2: the installer refuses to install
  without it). Git needs to know who you are once: `git config --global user.name "Your Name"` and
  `git config --global user.email you@example.com`.
- About 3 GB of free disk and 4 GB of free memory for the model below.
- A real terminal. `mind setup` asks questions, and a few steps ask you to type a phrase; neither works from a script.

## 2. Install Mind

Follow [README → Install](../README.md#install): get cosign, then run `install.sh`. In short:

```bash
curl -fsSLO https://github.com/bemindlabs/mind/releases/download/v0.11.1-alpha/install.sh
sh install.sh
mind --version
```

The release is called `v0.11.1-alpha` (a pre-release; there is no tag `v0.11.1` without the suffix, and a download URL that says `v0.11.1`
answers `curl: (22) ... 404`). With no `MIND_VERSION` set, `install.sh` installs the newest release, pre-releases included,
which is the latest; `MIND_VERSION=v0.11.1-alpha sh install.sh` pins it. It takes a few seconds and prints `checksum ok`,
`signature ok (cosign, the release workflow)` and `installed …`. `mind --version` then prints `0.11.1`: the binary
does not carry the `-alpha` suffix, and `mind update --check` says `mind 0.11.1 is the newest release (latest published:
v0.11.1-alpha)`. If `~/.local/bin` is not on your `PATH`, `install.sh` says so; add it.

## 3. A small local model

Mind talks to [Ollama](https://ollama.com), a program that runs models on your own machine. Install it by following
[ollama.com/download](https://ollama.com/download), make sure it is running, then pull one small model:

```bash
ollama pull llama3.2:3b          # about 2 GB
ollama list                      # the list should now name llama3.2:3b
```

`llama3.2:3b` is small enough to run on an ordinary laptop with no graphics card. It is the one this page uses, and
nothing in Mind depends on it: any chat model Ollama can run works, and a bigger one answers better and slower. Wherever
`--model llama3.2:3b` appears below, put your model's name. (Or type it once; a command that names no model uses this:)

```bash
export MIND_OLLAMA_MODEL=llama3.2:3b      # the model a turn uses when none is named
```

If you have pulled several models, `mind setup` (step 5) offers the model in `MIND_OLLAMA_MODEL` when it is pulled, and
says so; without the variable it offers the first one in Ollama's list.

Ollama listens on `http://127.0.0.1:11434`. If yours listens elsewhere, `export OLLAMA_HOST=http://127.0.0.1:<port>`
(use a loopback address: that is what Mind counts as this machine).

## 4. Check the machine

```bash
mind doctor --no-version
```

`--no-version` skips asking each vendor CLI for its version. Read the part about the local route:

```
ollama — the local route
  ok   daemon     http://127.0.0.1:11434 · 1 model(s) pulled
```

That `ok` is what matters: `doctor` exits 1 when this route is broken, and for one safety finding: a LiteLLM master key
in a file a program of yours can read (see [what a turn can read](fence.md)). Many `warn` lines are normal on a machine
that has only Ollama: `claude is not on PATH. Mind works without it`, a vector store that did not answer
(`a capability that is absent, not a fault`), and `engine … not checked` (a downloaded binary has no source to scan).
If the daemon line says `FAIL`, go to [When something does not work](#when-something-does-not-work).

## 5. Make your first agent

```bash
mind setup
```

It runs a few commands for you, one step at a time, and prints what it ran. First it looks at the machine
(`mind backends`); on a machine with only Ollama most vendor rows say `--` and `claude: not on PATH`, and that is
fine:

```
backend      reach    identity  writes?          where the identity lives
ollama       OK       system    no (no tools)    system prompt field (no file needed)
claude       --       system    no (measured)    ~/.claude/CLAUDE.md
             claude: not on PATH
…
```

Then it asks seven questions. A bracket shows the answer Enter takes. Answer like this, or with your own words:

| Question | An answer |
|---|---|
| What is the agent called? | `keeper` (it is also the name of its directory) |
| Whose agent is it? (a *subject* id: your data is filed under it) | `me` |
| Where should its repository go? | Enter, for `~/agents` |
| In one line, what is it for? | `Keeps my notes and tasks in order.` |
| What does it take on? | `Reads my notes, answers questions about them, files proposals for changes.` |
| What should it decline? | `Anything that deletes or sends without asking.` |
| How should it address you? | your first name |

Then it creates the repository, writes the soul from your answers and checks it:

```
created ~/agents/keeper
  .gitignore
  soul/role.md
  soul/person.md
  memory/README.md
  consent/README.md
  .git/hooks/pre-commit  (not in git)
  .git/hooks/pre-push  (not in git)

Nothing was committed and no remote was set — publishing an identity is a human act (D-013). Make the first commit yourself.
…
keeper — Keeps my notes and tasks in order.
subject me · 3 prohibition(s) · 3 principle(s) · discloses it is an AI

4 · what it may do by itself
  Level 1 — it proposes, and nothing it proposes happens until you approve it. That is where it starts,
  and setup leaves it there. `mind autonomy set` raises a category when you decide to.
```

(`mind new` prints a long, plain list of what git keeps whatever you do later and what deleting your data cannot reach.
Read it once; it is the honest part.) Last, it offers a first turn. Take `ollama` for the backend, and for the model
take the offered one if it is the model you pulled (it is `MIND_OLLAMA_MODEL` when you exported it and it is pulled, else the
first model Ollama lists; a line above the question says which and why).
**If the backend it offers is anything but `ollama`** (it offers a vendor CLI when Ollama has no model), type `ollama` or `skip`:
a vendor CLI sends the prompt off your machine.

```
5 · a first turn
  local models: llama3.2:3b · AI CLIs on PATH: none
  Which backend for a first turn? (or skip) [ollama] ›
  default model: llama3.2:3b — MIND_OLLAMA_MODEL is set and that model is pulled
  Which model? [llama3.2:3b] ›
<the model's answer, in its own words>
mind: route: You named the backend chain, so automatic routing did not change it.
answered by ollama · identity arrived as system · <n>s
```

`identity arrived as system` says the soul reached the model as its system prompt. After that `setup` prints `Done.`, the
commit line to run, a line about the egress judge (`on by itself`, idle until you list needles) and a list of next
commands, and returns the prompt. Now commit what you made. The
repository is yours, and Mind never makes a commit for you:

```bash
cd ~/agents/keeper && git add soul && git commit -m "soul: first description"
```

(The commit prints a notice from the guard: `2 staged file(s) passed 18 rules. That is not the same as "there is
nothing personal in this commit"`. It is a scan for credentials and it says what it cannot see.)

## 6. Talk to it again, and see what Mind kept

```bash
mind --as ~/agents/keeper turn --backend ollama --model llama3.2:3b --prompt "What are you for, and are you a person?"
mind ledger show --subject me
```

**Name the backend.** Without `--backend`, a turn tries the vendor CLIs it finds, `claude` and then `codex`, before
`ollama`, and a prompt sent to one of those leaves your machine (Mind prints `leaving this machine: this prompt goes to
… now, and Mind cannot take it back` first). For an agent that stays local, always say `--backend ollama`.

The ledger lists each turn: when, which backend received it, how many tokens it said it used. It never shows what was
said unless you pass `--content`. If you took `setup`'s first turn, the list has two rows by now, the setup turn and this one.

```
when                      backend   outcome    exit  ms       bytes      tokens in/out/total  usage      cost            id
2026-10-13T05:37:11.070Z  ollama    confirmed  -     1        33/43      120/14/-             reported   price-unknown   974fadf8-…
```

## 7. Worked example A: an agent that knows your notes

This one uses only what `mind new` gave you, a template agent, and shows the part that makes an agent yours: a soul you
write, and notes it can recall.

**a. Write its soul.** Open `~/agents/keeper/soul/role.md` and replace what `setup` wrote with the version below (the
fields in `+++` are what Mind reads; the text under them is the agent's knowledge of the job):

```
+++
schema = "mind/soul-role@1"
subject = "me"
name = "keeper"
role = "keeps my notes and to-do list in order"
prohibitions = [
  "never claims to be a person, and says plainly that it is an AI whenever asked",
  "never lets anything flagged personal leave this machine without a human approving that message",
  "never puts a credential, a token, or anything told in confidence into git",
  "never deletes a note",
]

[scope]
does = "reads my notes, answers questions about them, proposes how to tidy them"
does_not = "changes or sends anything without asking first"
+++

# keeper — role knowledge

Notes live in ~/notes as Markdown. A note is never deleted; an old one is moved to archive/.
```

```bash
mind soul check ~/agents/keeper --subject me      # every problem, with its file and line
```
```
keeper — keeps my notes and to-do list in order
subject me · 4 prohibition(s) · 3 principle(s) · discloses it is an AI
```

**b. Some notes to give it.** Any Markdown files will do; for a try-out:

```bash
mkdir -p ~/notes
printf '# Tax\n\nThe VAT return for the shop is due on the 15th of each month. Ask Dana for the invoices first.\n' > ~/notes/vat.md
printf '# Cat\n\nThe cat, Biscuit, eats at 7 and 18. The vet is closed on Mondays.\n' > ~/notes/cat.md
```

**c. Say on what basis its data comes in.** Mind will not read a subject's notes in until you have recorded why,
typed at a terminal (an agent running on its own cannot give itself that permission):

```bash
mind basis record owner --subject me --uses memory
```
```
me's data may come in for memory, on the basis "owner", approved by Your Name, with no end date.
This records a decision; it does not make it lawful. That is the approver's to know.
To record it, type exactly:  record basis for me
```

Type `record basis for me` and Enter. It prints `recorded <id>: owner for memory`. Without this step `ingest` stops with
`mind: no basis to take me's data in for memory: there is no basis on record for this subject. Nothing was read (S7.3).`

**d. Give it the notes, and recall.**

```bash
mind memory ingest ~/agents/keeper --from ~/notes --subject me --yes
mind memory index ~/agents/keeper --subject me
```
```
ingest — ~/notes → memory/imported/notes
  2 new · 0 changed · 0 unchanged · 0 gone from the source · 0 blocked
  + memory/imported/notes/cat.md
  + memory/imported/notes/vat.md
…
wrote 2 file(s), removed 0 under memory/imported/notes
Not staged and not committed. Run `mind memory index` to put them in recall, and `git add` them when you have read them …
```
```
memory — ~/agents/keeper
  2 file(s) · 2 piece(s)
  full-text  2 piece(s) → .mind/index/fts.sqlite
  vectors    not built — Unable to connect. Is the computer able to access the url?
  recall still works on the full-text half; run this again when the store is up.
```

The notes were copied into the agent's `memory/` after a scan for credentials. The `vectors … not built` line is
expected: vector recall needs Qdrant and an embedding model, which are optional; full-text recall works without them.

**e. Ask it something only the notes know.** Run it from any directory that is not inside the agent's repository:

```bash
mind turn ~/agents/keeper --subject me --backend ollama --model llama3.2:3b --prompt "When is the VAT return due?"
```
```
mind: recall: vector half skipped — Unable to connect. Is the computer able to access the url?
mind: recall: 1 piece(s), 101/4500 char(s)
mind:   memory/imported/notes/vat.md — Tax (101 char(s), fts)
mind: route: You named the backend chain, so automatic routing did not change it.
<the model's answer; with that note attached it has what it needs to say the 15th>
answered by ollama · identity arrived as system · <n>s
```

The three `recall` lines are the part you can check without trusting the model: they name exactly which pieces of
memory were attached to the question, before it was sent. `mind memory search ~/agents/keeper --subject me "VAT"` shows
what recall finds for a word, with no model involved. (A small model may still answer badly from a good piece; that
is the model, not the memory.)

## 8. Worked example B: a chore on a schedule

A *trigger* is a prompt and an interval, written in the agent's soul so it is in git and in `git diff`. It runs as a
turn held at level 1, so it can only **propose**; nothing it proposes happens until you approve it.

**a. Write it.** Create `~/agents/keeper/soul/triggers.md`:

```
+++
schema = "mind/triggers@1"

[tidy-inbox]
every = "1d"
prompt = "Look at the notes and propose one way to tidy them."
+++

Each trigger runs as a turn held at level 1: it proposes, and nothing it proposes happens until somebody approves it.
```

`every` is a number and a unit: `30m`, `6h`, `1d`, between 5 minutes and 90 days. Commit it
(`git add soul/triggers.md && git commit -m "soul: a daily tidy-up trigger"`).

**b. See it, and run what is due.** Give the `triggers` commands the agent's **`soul/` directory**. (Given the repository
root they look for `triggers.md` there, find nothing and print `no triggers.md in … — nothing runs by itself`.)

```bash
S=~/agents/keeper/soul
mind triggers show $S --subject me
```
```
tidy-inbox           every 1d    last never · next due now
```
```bash
mind triggers tick $S --subject me --backend ollama --model llama3.2:3b
```
````
mind: trigger tidy-inbox (every 1d) — a turn held at level 1
One thing is worth doing.

```mind-proposal
{"what": "Archive the notes in inbox/ that are older than 30 days", "why": "The inbox has grown and …", "impact": "Moves files inside the notes folder; nothing is deleted"}
```
…
mind: proposal da6e0a1c-291b-4784-b49f-aa4beacc1d85 filed by the agent: Archive the notes in inbox/ that are older than 30 days
mind: nothing was done. Approve with `mind proposal decide <id> <dir> --subject me --approve`, then run the turn again with --proposal <id> at level 2.
````

(The model's own wording will differ, and a model that finds nothing to do files nothing.) Run `mind triggers show $S
--subject me` again: it now says `last <time> · next <time a day later>`, and a second `tick` prints `nothing is due`:
a machine that was off for a week runs a daily trigger once when it comes back, not seven times.

**c. Decide.**

```bash
mind proposal list $S --subject me           # id, when, pending, what
mind proposal show <id> $S --subject me      # what, why, impact, and whether its approval was spent
mind proposal decide <id> $S --subject me --approve      # or --refuse
```
```
da6e0a1c-… approved by Your Name at 2026-10-13T05:43:54.888Z
  Good for one turn, and for this action only (sha256:5ce3f10d…): `mind turn <dir> --subject me --proposal da6e0a1c-…` runs its what. …
```

A refused proposal is remembered and is not proposed again without something new.

**What approving does and does not do.** Your yes is **good for one turn and for that action only**, and the turn
that spends it is `mind turn <dir> --subject me --proposal <id>`. It does not make the agent able to do more than the
rest of this page allows. On Ollama a turn can only answer. On a vendor CLI in the cloud, a turn is held at write 1 /
run 1 whatever the dial says ([why](../README.md#what-the-autonomy-dial-does-today)); only the local CLI chain
(`claude-local`, `grok-local`) acts at 2 or 3, and that needs local action set up, which this page does not. What that
chain may read and write is in [what a turn can read and write](fence.md). So in
this quickstart "approve" records and spends your decision; the doing is yours.

**d. Make it run by itself.** Mind runs no scheduler of its own. `triggers schedule` prints a systemd user timer and a
cron line that call `tick`, and installs neither:

```bash
mind triggers schedule $S --subject me
```
```
# systemd (user) — ~/.config/systemd/user/mind-triggers-me.service
[Unit]
Description=mind triggers for me

[Service]
Type=oneshot
ExecStart='/home/you/.local/bin/mind' 'triggers' 'tick' '/home/you/agents/keeper/soul' '--subject' 'me'
…
# then: systemctl --user daemon-reload && systemctl --user enable --now mind-triggers-me.timer

# or cron (crontab -e):
*/5 * * * * '/home/you/.local/bin/mind' 'triggers' 'tick' '/home/you/agents/keeper/soul' '--subject' 'me'
```

Copy what you want into place yourself. The tick needs to say which backend answers, or it uses the default chain
(`claude`, then `codex`, then `ollama`): add `'--backend' 'ollama' '--model' 'llama3.2:3b'` to the command you install.

## When something does not work

Start with `mind doctor --no-version`: it says what is installed, missing or stale and exits 1 only when the local
route is broken, or when a LiteLLM master key lies where a program of yours can read it.

| You see | It means | Do this |
|---|---|---|
| `FAIL daemon http://127.0.0.1:11434 did not answer /api/tags` (doctor), or `no backend answered … ollama: unavailable (http://…: unreachable …)` (a turn) | Ollama is not running, or is somewhere else | Start Ollama. If it listens on another port, `export OLLAMA_HOST=http://127.0.0.1:<port>`. |
| `no backend answered · 0.0s · all 1 backend(s) missed · ollama: silent` | the daemon answered with an error, or no model was named | Run it again with `--json` and read `evidence.raw`: it holds the daemon's own words, for example `HTTP 404: {"error":"model \"x\" not found, try pulling it first"}` (then `ollama pull x`) or, with no model named, a request that was never sent. Name one: `--model …` or `export MIND_OLLAMA_MODEL=…`. |
| `ollama: silent` after a long wait | the model was loading, or is too big for the memory you have | `ollama ps` shows what is loaded. Mind waits up to 5 minutes. Try the smaller model. |
| `leaving this machine: this prompt goes to claude (Claude Code) now` | you did not name `--backend ollama`, and a vendor CLI is installed and logged in | Name the backend. The line is printed before the prompt goes, and it cannot be taken back. |
| `mind: no basis to take me's data in for memory …` | you have not recorded on what basis the notes come in | Step 7c, at a terminal. |
| `mind: a basis is recorded at a terminal, where you can type: record basis for me` | the command ran with no terminal (a script, a pipe) | Run it in a real terminal. The same goes for `mind setup` (`setup ran out of input`) and every typed phrase. |
| `mind: recall: vector half skipped — Unable to connect…` | no Qdrant or embedding model on this machine | Nothing: full-text recall still works. It is optional. |
| `no triggers.md in <dir> — nothing runs by itself` and the file exists in `soul/` | the `triggers` commands were given the repository root | Give them the `soul/` directory (step 8b). |
| `mind: nothing was sent — the working directory … contains the agent's repo … and this turn may write` | you raised write or run to 2 and started the turn inside the agent's repository, Mind's own directories, or a directory with credentials in it | Start the turn from a scratch directory. (Nothing on this page raises the dial.) |
| `install.sh: a verified signature is required … cosign is not installed` | v0.11.0 and later need cosign | [README → Install](../README.md#1-get-cosign-once). |
| `curl: (22) The requested URL returned error: 404` on `install.sh` | the URL names a tag that does not exist (`v0.11.1`) | Use `v0.11.1-alpha` (step 2). |
| `Mind wrote vectors for this subject to … and cannot reach it now` (from `mind erase`) | a vector store was reached once and a marker says Mind wrote there, and it does not answer now | Start the store and run it again, or, if it is gone for good, pass `--vectors-not-reached <the collection name the message prints>`; the certificate then says `not reached` and is not `erased-and-verified`. |

Still stuck? Say what you ran, what you saw, and `mind --version`, in an
[issue](https://github.com/bemindlabs/mind/issues/new/choose). Never put a real token or real personal data in one;
a made-up one shows the same thing. A security problem goes through [SECURITY.md](../SECURITY.md), not an issue.

## Where to go next

- `mind web ~/agents/keeper --subject me --backend ollama --model <your model>`: the same agent in your browser: what it
  may do, what waits for your yes, a chat. It prints a link with a key (new at each start) and listens on this computer only,
  on port 30701 unless you give `--port`; stop it with `Ctrl-C`. Name `--backend ollama`: without it the chat uses the same
  default chain as a turn, so a vendor CLI you have installed gets your messages. The page's *schedule* panel lists the
  triggers in `soul/triggers.md`, the ones step 8 made. (Checked by driving the page's API with `curl`, not by a person in a browser.)
- `mind soul apply ~/agents/keeper --subject me`: shows, as a diff, how the soul would be written into the AI CLIs you
  use; nothing is written without `--apply`.
- Raising what the agent may do on its own, a browser for a task, and the limits of both:
  [README → What to know before you rely on it](../README.md#what-to-know-before-you-rely-on-it). Read it before you
  run `mind autonomy set … 2`, and before any `mind task … --operate 2` or `--detach`.
- Taking everything back out: `mind erase me --agent ~/agents/keeper --by "me"` is a dry run until you add `--yes`.
  Know three things first. (1) If `mind memory index` said `vectors not built … Unable to connect` (no Qdrant, as on this
  page), no marker was left and `erase` goes on: it notes that the store did not answer and that Mind holds no record of
  writing to it. Only if a vector store once answered and now does not does it refuse, naming the collection and the flag
  (`--vectors-not-reached <name>`) that goes on without it and puts `not reached` on the certificate. (2) It removes the
  soul files, Mind's state, the ledger and proposals, but **not** the notes copied into `memory/imported/`: they are your
  files in your repository, so the certificate lists each one as `yours to delete` and the verdict is
  `erased-with-remainder` (exit 1) until you remove them (`git rm -r memory/imported`); the agent's directory is yours too
  (`rm -r ~/agents/keeper`), and git history keeps whatever was committed. (3) A subject with nothing indexed can end
  `erased-with-remainder` (exit 1) because the scaffold `consent/README.md` names the agent; the certificate lists the file.
