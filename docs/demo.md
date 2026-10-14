# The demo (B3)

The one thing MVP-lite is defined by — and re-run before every release since (v0.1.0, v0.2.0,
v0.3.0, v0.4.0, v0.4.1, v0.4.2, v0.5.0, v0.5.1, v0.6.0, v0.6.1, v0.7.0, v0.7.1, v0.7.2, v0.8.0, v0.8.1, v0.8.2, v0.8.3, v0.9.0, v0.10.0, v0.10.1 and v0.10.2 each passed 15/15; the runs are listed at the end). It proves the core claims in a bare
container; it does not exercise `setup`, triggers, `observe patterns` or recall, which have tests of
their own.

> make an agent → give it an identity → `git clone` it into a bare container
> that has **only ollama** → `soul verify` passes → a turn finishes.

`scripts/demo-bare-container.sh` runs that end to end and reports one
criterion per line. It proves — or fails to prove — five acceptance criteria
at once:

| | |
|---|---|
| the MVP-lite DoD | the sentence above, whole |
| `S0.3 AC4` | clone into a bare container, rebuild, verify |
| `S2.1 AC6` | a turn that finishes with no vendor CLI present |
| `S0.4 AC3` | the pre-commit scan blocks a commit carrying a secret — in the shape that escaped it, a staged typechange |
| `S7.2 AC2/AC3/AC6` · `I-4` | `erase` asked in both directions: a subject never held comes back `nothing-found` and touches nothing, and the subject that is here comes back `erased-and-verified` with the id findable nowhere |

The last two were added in dod1. Before it, the words `erase` and `guard`
appeared in this script zero times — so the two things the night of 2026-09-21
found actually broken were outside everything the demo covered.

## Running it

```sh
npm run demo -- --model <a model already pulled on this host>
```

There is no default model, on purpose: a model id is a fact about one machine
and the engine carries no such facts (D-021). `--image <ref>` swaps the base
image; the default is `debian:bullseye-slim`.

`OLLAMA_HOST` overrides where the container looks for ollama. Unset, the
script reads the docker bridge gateway out of docker itself, so no address of
any particular machine is written down anywhere in this repository.

### Exit codes

| | |
|---|---|
| `0` | proven |
| `1` | ran, and did not pass |
| `2` | did not run — preflight failed, which is not a result about Mind |

Three levels rather than two, for the same reason `Confidence` has four: "the
demo failed" and "the demo never ran" call for different actions, and a
boolean cannot tell them apart.

### What it leaves behind

Nothing. The container is started with `--rm` and a bounded `sleep`, is
removed by container id (never by prune and never by name pattern), and the
script asserts at exit that no container carrying this run's label survives.
The base image is removed only if this run was the one that pulled it. Every
host-side file lives in a `mktemp -d` that goes with it, including a throwaway
`HOME` and throwaway `XDG_*` — the real home is never read and never written.

To check that for yourself, compare these before and after; both should be
identical line for line:

```sh
docker ps -a --format '{{.ID}} {{.Image}} {{.Names}}' | sort
docker images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | sort
```

## What "a bare container" means here

A stock `debian:bullseye-slim`, unmodified, with exactly two things copied in.

| what it has | why the demo still proves what it claims |
|---|---|
| the base image's glibc | a binary needs a libc; "bare" was never going to mean `scratch` |
| one binary from `bun build --compile` (the script installs it as `mind` — D-055) | installing bun inside would need network and an installer, which is not bare — and the binary proves the stronger claim: **no runtime at all** (ADR 0001 §1) |
| one working tree from `git clone` | this is the whole point: what git holds has to be enough |
| ollama, **outside** the container, over the docker bridge | "only ollama" means the one endpoint reachable from in there is a local model daemon — not that ollama is installed twice |

The script asserts the negative rather than asking you to trust it: inside the
container, none of `claude codex gemini grok copilot kimi bun node npm deno
python3 git curl wget` resolves. If any of them does, the demo fails. It also
prints `docker diff` so you can see every path that differs from the stock
image.

## What this demo does **not** prove

Five honest limits. None of them is hidden in a flag.

**The pre-commit guard is proved on the host, not in the container.** This is
the one limit that is a straight collision between two of the claims above. A
guard hook is a file git executes, reading git's index — and the strongest
evidence that this container is bare is that it has no git in it at all (`git`
is on the forbidden list the script asserts). Installing git to prove the
guard would delete what the other criteria rest on; skipping the guard would
leave the acceptance criterion that caught a real escape outside everything
this demo claims. So the guard runs on the host, against the same binary, on a
clone of its own that never goes near the container — and the row in the
output says `on the host` rather than leaving it to this document. *Bare* and
*guarded by git* are two different machines, and Mind has to work on both.

`erase`, by contrast, really does run in the container: it needs no git, which
is exactly why the crash it used to have on a machine without one mattered.

**`git clone` runs on the host, not inside the container.** What I-2 has to
prove is that what git holds is enough for the agent to stand up, and the
bytes that arrive are the same checkout either way. Cloning inside would mean
`apt-get install git` against a bullseye whose LTS has ended — so the demo
would fail because of a package mirror rather than because of Mind, which is
a failure that teaches nothing. If you want the literal reading, install git
in the container yourself and accept that risk.

**It does not prove there is no egress.** It proves there is no vendor CLI, no
credential, and nothing in the container that can resolve a hostname
(`--dns 127.0.0.1` points DNS at a port nothing is listening on, and ollama is
reached by address). That is *not* a firewall. Actually closing the network
would need `sudo` and would affect the whole machine, so it is not done here,
and nothing in the output should be read as if it were.

**It does not prove the model is good enough in general.** It proves one
identity arrived and one task finished. Assumption A5 — "a local model can
stand in for the cloud CLIs well enough" — is measured by this demo only at
the width of this demo.

**It does not check the GPU.** It spends roughly ten turns on whatever model
you name, on a GPU that may be shared with other services. Choosing when to
run it is a human decision, so the script does not make it.

## How the demo is kept from lying

A demo that prints PASS without proving anything is worse than no demo, so:

- **Every answer `soul verify` asks for is randomised per run.** The template
  says the user is addressed as `"you"`, which a model carrying no soul at all
  guesses correctly. The demo replaces all three answers — how the agent
  addresses the user, what it calls itself, and its first prohibition — with
  values unique to that run.
- **The report is checked back against those values.** The script reads
  `soul verify --json` and asserts the `expected` fields hold the values that
  were written *before* the clone, so a pass cannot come from the template.
- **The first prohibition stays the I-5 one.** "says plainly that it is an AI"
  is the sentence the demo measures, with a per-run code appended — not a
  slogan invented to be easy to quote.
- **A negative control runs before anything is allowed to pass.** Pointed at a
  port nobody listens on, `soul verify` and `turn` must both exit non-zero. If
  either exits 0, the script cannot tell success from failure and the whole
  demo is reported failed.
- **The turn names no backend.** The default chain is claude → codex → ollama
  and it has to fall through on its own; naming `ollama` would delete the
  thing `S2.1 AC6` is about. The ledger is then read back to confirm no vendor
  backend was ever handed the prompt.
- **The task is checked by machine.** It is arithmetic on two numbers drawn
  per run, because what is being measured is the plumbing, not the model.
- **No retries, no reduced `--runs`, no relaxed threshold.** `soul verify`
  returns four levels; only `confirmed` on every question of every run counts.
  `partial` is reported as a failure, because it is one.
- **Controls are run and reported, and are not counted as criteria.** The hook
  has to let a clean commit through, a plain file carrying a token has to be
  blocked, and the subject's id has to be findable *before* anything is erased
  — otherwise a block proves nothing and a zero afterwards proves nothing. None
  of those is a row in the table: a control shows the instrument still works, it
  is not a thing Mind is credited with, and counting them would grow the
  number without growing the evidence. Every one of them fails the whole run.
- **`erase` is asked in both directions in the same container.** A subject that
  was never here must come back `nothing-found`, exit 3, and leave every file
  byte-identical; the subject that is here must come back
  `erased-and-verified`, remove something, and leave the id findable in no
  file's bytes and no file's name. One direction alone passes for a command
  whose verdict is a constant. The `nothing-found` direction is deliberately
  run in a home that holds the *real* subject's data, which is D-026's
  dangerous case: a mistyped id where `filesRead` must not be zero and the
  correctly spelled subject must not lose a byte.
- **The zero `grep` returns inside `.git` is printed with what it is worth.**
  git objects are compressed, so grep cannot see an identifier in a pack file
  whether it is there or not — and it *is* there, because the demo commits the
  soul. The searches therefore exclude `.git`, and the script says why in its
  own output rather than letting a reader take that zero for a clean result.
  The evidence for `S0.4 AC5` is the sentence on the certificate, never a grep.

`mind backends` is run inside the container and printed rather than a second
full verify across claude and codex: it reports the same fact — that those
CLIs are not reachable here — without spending nine more turns on the GPU.

## Results

Recorded here rather than in `.scrum/`, so the raw output lives next to the
script that produced it.

### 2026-09-21 · `qwen3.8:27b` · `debian:bullseye-slim`

Superseded by the 2026-09-22 runs below, which ran to a conclusion.

### 2026-09-22 · `qwen3.8:27b` · `debian:bullseye-slim`

Two runs, an hour apart, and the second is the one that counts because the
script changed between them.

| when | tree | criteria | exit | recorded by |
|---|---|---|---|---|
| ~09:00 | `992ad16` | **12/12** | 0 | `4621036` |
| ~10:00 | the tree `7df2ce9` leaves behind | **15/15** | 0 | `7df2ce9` |

The first was a re-prove, not a new result: the criteria were unchanged and
thirteen commits had landed under the record cited by the previous run, so the
question it answered was *does the demo still pass on this `src/`?* The answer
was yes, and two of the night's repairs showed up in the demo's own output
rather than only in the test suite — `rebuild` reporting `fresh — 1
artefact(s)` where `odd2` had found it saying `0`, and the backend table
stating that a headless kimi turn told to write a file wrote it.

The second is where the count moved. It moved because three criteria were
*added*, not because anything got easier: the guard's staged-typechange case,
`erase` of a subject never held, and `erase` of the subject that is there —
the three rows the table at the top of this document now names. Writing them
found `erase --agent` crashing on a machine with no git, which was repaired
before the run. Controls are not among the fifteen, for the reason the list
above gives.

Both runs left the machine as it was: 34 containers and 44 images before and
after, checked with the two commands under *What it leaves behind*.

**The run ids of these two runs were not kept.** The script prints one per run
and nothing captured it into this file at the time, so the row above cites the
commit that recorded the run instead. That is weaker evidence and is written
here as weaker evidence: a commit says *somebody ran it and wrote down what
came back*, where a run id plus its output would say *this is what came back*.
What is pinned rather than asserted is the script's own bytes —
`scripts/check-coverage.ts`'s `PROOFS` carries a sha256 of
`demo-bare-container.sh` taken at the 15/15 run, so the file cannot be edited
quietly afterwards while still claiming that number. That hash says nothing
about a change in `src/` breaking the demo, and `PROOFS` says so itself.

### 2026-09-24 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.1.0**

Run `2ddacb38`, on the tree released as 0.1.0: **15/15, exit 0**. The binary in the
container reported `0.1.0`, under the former name. This time the run id was kept, and so was the
result table the script printed: `notes/2026-09-24_demo-v0.1.0.txt`.

### 2026-09-24 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.2.0**

Run `fd433912`, on the tree released as 0.2.0: **15/15, exit 0**; the binary in the container reported
`0.2.0`. Table kept in `notes/2026-09-24_demo-v0.2.0.txt`.

### 2026-09-24 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.3.0**

Run `cbeda900`, on the tree released as 0.3.0: **15/15, exit 0**; the binary in the container reported
`0.3.0`. Table kept in `notes/2026-09-24_demo-v0.3.0.txt`.

### 2026-09-24 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.4.0**

Run `065c6900`, on the tree released as 0.4.0: **15/15, exit 0**; the binary in the container reported
`0.4.0`. Table kept in `notes/2026-09-24_demo-v0.4.0.txt`.

### 2026-09-25 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.4.1**

Run `8a52848c`, on the tree released as 0.4.1: **15/15, exit 0**; the binary in the container reported
`0.4.1`. Table kept in `notes/2026-09-25_demo-v0.4.1.txt`.

### 2026-09-25 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.4.2**

Run `fbad84d0`, on the tree released as 0.4.2: **15/15, exit 0**; the binary in the container reported
`0.4.2`. Table kept in `notes/2026-09-25_demo-v0.4.2.txt`.

### 2026-09-25 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.5.0**

Run `5e5f6903`, on the tree released as 0.5.0: **15/15, exit 0**; the binary in the container reported
`0.5.0`. Table kept in `notes/2026-09-25_demo-v0.5.0.txt`.

### 2026-09-25 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.5.1**

Run `caa68c60`, on the tree released as 0.5.1: **15/15, exit 0**; the binary in the container reported
`0.5.1`. Table kept in `notes/2026-09-25_demo-v0.5.1.txt`.

### 2026-09-26 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.6.0**

Run `1972948d`, on the tree released as 0.6.0: **15/15, exit 0**; the binary in the container reported
`0.6.0`. Table kept in `notes/2026-09-26_demo-v0.6.0.txt`.

### 2026-09-26 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.6.1**

Run `3eaea63f`, on the tree released as 0.6.1: **15/15, exit 0**; the binary in the container reported
`0.6.1`. Table kept in `notes/2026-09-26_demo-v0.6.1.txt`.

### 2026-09-26 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.7.0**

Run `1c88d842`, on the tree released as 0.7.0: **15/15, exit 0**; the binary in the container reported
`0.7.0`. Table kept in `notes/2026-09-26_demo-v0.7.0.txt`.

### 2026-09-26 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.7.1**

Run `0eaea0cf`, on the tree released as 0.7.1: **15/15, exit 0**; the binary in the container reported
`0.7.1`. Table kept in `notes/2026-09-26_demo-v0.7.1.txt`.

### 2026-09-26 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.7.2**

Run `f28cd0ba`, on the tree released as 0.7.2: **15/15, exit 0**; the binary in the container reported
`0.7.2`. Table kept in `notes/2026-09-26_demo-v0.7.2.txt`.

### 2026-09-27 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.8.0**

Run `391c781f`, on the tree released as 0.8.0: **15/15, exit 0**; the binary in the container reported
`0.8.0`. Table kept in `notes/2026-09-27_demo-v0.8.0.txt`.

### 2026-09-27 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.8.1**

Run `0a4d532e`, on the tree released as 0.8.1: **15/15, exit 0**; the binary in the container reported
`0.8.1`. Table kept in `notes/2026-09-27_demo-v0.8.1.txt`.

### 2026-09-27 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.8.2**

Run `c7517aef`, on the tree released as 0.8.2: **15/15, exit 0**; the binary in the container reported
`0.8.2`. Table kept in `notes/2026-09-27_demo-v0.8.2.txt`.

### 2026-09-28 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.8.3**

Run `de86a5a6`, on the tree released as 0.8.3: **15/15, exit 0**; the binary in the container reported
`0.8.3`. Table kept in `notes/2026-09-28_demo-v0.8.3.txt`.

### 2026-09-28 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.9.0**

Run `b7384f44`, on the tree released as 0.9.0: **15/15, exit 0**; the binary in the container reported
`0.9.0`. Table kept in `notes/2026-09-28_demo-v0.9.0.txt`.

### 2026-10-05 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.10.0**

Run `ff1ad2c7`, on the tree released as 0.10.0: **15/15, exit 0**; the binary in the container reported
`0.10.0`. Table kept in `notes/2026-10-05_demo-v0.10.0.txt`.

### 2026-10-06 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.10.1**

Run `a32be071`, on the tree released as 0.10.1: **15/15, exit 0**; the binary in the container reported
`0.10.1`. Table kept in `notes/2026-10-06_demo-v0.10.1.txt`.

### 2026-10-06 · `qwen3.8:27b` · `debian:bullseye-slim` · **v0.10.2**

Run `b2581387`, on the tree released as 0.10.2: **15/15, exit 0**; the binary in the container reported
`0.10.2`. Table kept in `notes/2026-10-06_demo-v0.10.2.txt`.
