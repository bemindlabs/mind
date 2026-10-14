# Security policy

Mind holds things that matter: an agent's memory, the personal data of the person it inherits from, the
tokens it talks to other agents and chat apps with, and a kill switch. A hole in any of those is a security bug.

## Reporting a vulnerability

**Please do not open a public issue with the details.** Report it privately through GitHub:
[**Security → Report a vulnerability**](https://github.com/bemindlabs/mind/security/advisories/new)
on `bemindlabs/mind`. Only the maintainers see it.

If that page does not let you file a report (private reporting has to be switched on by the owner of the
repository), open an issue that says only that you have a security report, with no details, and a maintainer
will arrange a private way to receive it.

Useful to include: the version (`mind --version`), the platform, the command or page involved, what you
expected, what happened, and the smallest steps that show it. Please leave real personal data and real tokens out
of the report — a made-up one shows the same thing.

We aim to answer within 7 days, to agree on a fix and a date with you, and to credit you in the release notes
unless you would rather not be named.

## What counts

Anything that breaks one of the six principles in the [README](README.md#six-things-it-will-never-trade-for-speed)
is in scope. For example:

- personal data leaving the machine without a human's approval for that instance (the egress filter, the local
  judge, the chat and A2A connectors; the judge's limits are listed below)
- one agent's memory or personal data reaching another agent's context
- the autonomy dial or the kill switch being raised or bypassed by a turn Mind started, or by anything that is not a
  process running as your own user (see the limits below for what a process of your own user can do)
- a turn on a backend with no kernel fence acting at write or run 2 or above (it is held at 1, D-163)
- `mind erase` or `memory forget` claiming to have removed something it did not
- the web console (`mind web`) being reachable without its key, answering a host it should refuse, or running
  something its buttons do not
- a credential getting past the staged-file scan into an agent's repository or memory
- a release that `install.sh` accepts although its signature does not verify, or a binary that does not match
  its `SHA256SUMS`

## Known limits (not vulnerabilities, but you should know them)

These are stated openly in the [README](README.md#what-to-know-before-you-rely-on-it). A report that only restates
one of them is a known limit, not a new finding; a way around a *mitigation* listed there is a finding.

- **Anything running as your user can do what you can.** While the warden (a separate system user that holds the
  approvals, planned for 1.x) does not exist, any process running as your user can answer a held browser action,
  approve a proposal, or write an approval file. That is why **browser acting at `operate` level 2 and
  `mind task --detach` are experimental.** If your user is in the `docker` group, that group is root-equivalent on the
  machine.
- **The local judge is automatic only when a local model is configured, and it reads only against your needles.** A
  default install has it for `mind a2a send`, a cloud turn and proposal triage only when `MIND_OLLAMA_MODEL` names a
  model that runs on this machine (`OLLAMA_HOST` a full URL on a loopback address; a name ending `-cloud` or `:cloud`
  is relayed to a hosted service and does not count). With none, the filter alone screens the text and one line on
  stderr says so each time; a paraphrase or a translation of your own words can then still leave. The judge fails
  closed (a configured model that does not answer keeps an A2A message in), and with no needles listed
  (`mind egress needles`) it has nothing to read. Chat and bots still need `MIND_EGRESS_JUDGE` named and do not start
  without it.
- **The kernel fence covers the local chain only.** A turn on a cloud vendor's CLI is held at write 1 / run 1 (D-163);
  what a vendor CLI does with its own flags is the vendor's.
- **Releases before v0.11.0 are not signed at all.** From v0.11.0 on, `install.sh` and `mind update` both refuse a
  release whose cosign signature on `SHA256SUMS` they cannot verify; for an older release they go on with the
  checksum and say in one line that the signature was not checked. The signing identity they trust is still a
  default the owner has not settled.

Not in scope: what a vendor CLI (Claude Code, Codex, …) does on its own once Mind has started it — report
those to that vendor — and anything that needs someone who already controls your user account, beyond what is
listed above as a limit.

## Supported versions

Mind is an alpha and a 0.x. Only the newest release gets fixes; `mind update` or `install.sh` installs it. From
v0.11.0 releases carry a cosign signature on `SHA256SUMS`, which `install.sh` and `mind update` require; releases
before that were published unsigned.
