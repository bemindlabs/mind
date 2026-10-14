#!/usr/bin/env bash
# run-codex-host.sh <task-id> <trial-number> — the codex arm that works on this host (see run-codex.sh header).
# Same interface/outputs as run-codex.sh; results under runs/codex-host/, cli="codex-host".
SP5_CODEX_SANDBOX=host exec <scratch>/sp5/run-codex.sh "$@"
