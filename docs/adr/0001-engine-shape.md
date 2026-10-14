# ADR 0001 — Engine shape: Bun, ExecBackend, one agent per repo

- **Status:** Accepted
- **Date:** 2026-09-20
- **Supersedes:** nothing (first record)

## Context

mind builds agents a person owns: named, scoped, given a voice, and able to
keep working when any particular vendor is unavailable. Three shape decisions
had to be made before the first line of code, because each one is expensive to
reverse later.

Two neighbouring projects already exist and were read before deciding, so that
mind would not rebuild them:

- One orchestrates a fleet of coding agents and **suppresses** cross-vendor
  configuration on purpose, so that a review is judged on the repository's own
  rules rather than the operator's machine.
- One scaffolds agent directories with a persona, a scope, and instruction
  files symlinked across backends — but at *directory* scope: it does not make
  a CLI invoked anywhere else carry that identity.

mind's gap is the one neither covers: **making an identity arrive in every
backend, and proving that it did.**

## Decision

### 1. Bun (TypeScript) as the single runtime

The MVP touches no machine learning. It renders text, spawns CLIs, parses
JSON, reads line-delimited logs, and keeps a ledger.

- `Bun.spawn` gives direct control of stdio, env, and timeouts with no
  dependency.
- JSON is native to the language, and every vendor CLI's structured output is
  JSON.
- `bun:sqlite` is built in, so the memory full-text index needs no package (the ledger turned out
  to be plain JSONL — one line per turn, readable with `jq`).
- `bun build --compile` produces a single binary, which removes the usual
  distribution objection to a scripted language.
- Local model serving and vector search are reached over HTTP, so neither
  pins the engine to a particular language.

**Alternatives not chosen:**

- **Python** was the first proposal and was withdrawn. Its advantage is the ML
  ecosystem, and the MVP uses none of it. If fine-tuning later proves
  worthwhile, it arrives as an HTTP sidecar — the pattern already used for
  other services here — rather than as a second language in the engine.
- **Rust** matches the neighbouring projects and would give one static binary.
  The heaviest work in this MVP is file I/O and waiting on subprocesses, so
  Rust buys no speed where it is spent, and costs iteration time where it is
  needed. Reconsider if the engine ever runs models in-process.

### 2. `ExecBackend` as the seam, with the local path as a first-class member

Every way of reaching a model implements one interface: vendor CLIs over a
subprocess, and a local model over HTTP.

The interface is written for the *harder* case — a subprocess that can hang,
exit 0 with nothing, or write its answer to the wrong stream — and the HTTP
path conforms to it, not the other way round. Consequences:

- A turn result carries four outcomes, not a boolean: `confirmed`, `partial`,
  `failed`, **`silent`**. `silent` means nothing usable came back whatever the
  exit code claimed. Collapsing it into `failed` would erase the only signal
  that separates a broken identity from a run that never happened — and that
  signal is the reason this project exists.
- A turn result also records **how strongly the identity reached it**. Only
  some CLIs accept a system prompt as a flag; the rest read a file and treat it
  as user-level text. mind reports that difference rather than claiming the
  backends are equivalent.
- Fallback (try the next backend when one produces nothing) lives behind the
  same interface, because deciding "did that actually work?" is the same
  judgement `verify` makes, and a shell `||` cannot see a silent success.

**Alternative not chosen:** calling vendor CLIs directly from each call site.
It is shorter, and it makes the acceptance test — take the commercial CLIs off
PATH and finish the work on a local model alone — impossible to pass.

### 3. One agent, one git repository

An agent is a git repository: its identity, its memory, and its consent record
are files a human can read without mind installed. Derived state lives in a
single ignored directory and must be rebuildable from what git holds.

**Consequences:**

- Portability is `git clone`, with no export format to maintain.
- Deletion is honest: what git history already holds is named plainly rather
  than reported as erased.
- Nothing in mind pushes. Publishing is a human act.

**Alternative not chosen:** a shared database of agents. It makes listing and
cross-agent queries easy, and it makes "this agent is mine, and I can take it
with me" false.

### 4. Open-source from the first commit

The engine contains no personal paths, names, or accounts; user-specific
locations are written relative to the home directory and expanded at runtime,
and test fixtures are synthetic. Licence: **Apache-2.0** (recorded in
`package.json`); a `LICENSE` file is added before the repository is made
public, which is the owner's decision to make, not this project's.

*Amended 2026-09-24:* `LICENSE` and `NOTICE` are in the repository, and the owner published it as a
snapshot of each release at `bemindlabs/mind` (D-058), keeping the development history private.

## Consequences

- Vendor knowledge is data in one file, measured from each CLI's own `--help`
  and dated. It will go stale; `docs/cli-matrix.md` records how to re-measure
  it.
- Four of six vendor CLIs surveyed carry an identity only as user-level text.
  mind therefore cannot promise equal results across backends, and does not.
  It measures how far the identity got and reports the difference.
- The four-level outcome type propagates: anything that reports a result has
  to decide what `silent` means for it, which is the intended pressure.
