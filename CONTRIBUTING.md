# Contributing to Mind

Thank you for looking. Mind is **not open for code contributions yet** — see
[Contributing in the README](README.md#contributing) — but it very much wants to hear from you.

## How this repository works

`bemindlabs/mind` is a **snapshot of each release**, exported from a private development repository (see
`.snapshot`). Development history, and the agents' own repositories, are not published. So a pull request here
cannot be merged as it is: a change is made in the development repository and arrives here with the next release.

## What helps most

- **A bug report** — [open an issue](https://github.com/bemindlabs/mind/issues/new/choose) with the version
  (`mind --version`), your platform, and the output of `mind doctor`. Take personal data out first.
- **An idea or a missing piece** — open a feature request that says what you were trying to do. The backlog lives
  in `.scrum/`, and every design choice is a numbered decision in `.scrum/decisions.md`; pointing at one helps.
- **A security problem** — never in an issue. See [SECURITY.md](SECURITY.md).
- **A small fix** — welcome as a pull request so we can see exactly what you mean; it will be carried into the
  development repository with credit to you, and the pull request closed when the release that has it is out.

## If you build it yourself

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run coverage   # every source file loaded by a test and at least 85% of its lines run
```

These are the gates CI runs on every push. CI also runs `bun audit --audit-level=high`,
`bun run scripts/licence-audit.ts` and `bun run scripts/third-party-notices.ts --check`; after changing fonts or
dependencies run `bun run scripts/third-party-notices.ts --write` and commit `THIRD_PARTY_NOTICES.md`. A change
comes with its tests, a line in `CHANGELOG.md` under *Unreleased*, and — when it decides something — a decision in
`.scrum/decisions.md`. Code reads like the code around it: TypeScript on Bun, small functions, plain sentences in
messages a person will read.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
