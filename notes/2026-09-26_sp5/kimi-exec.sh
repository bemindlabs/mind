#!/usr/bin/env bash
# kimi-exec.sh <kimi args...> — called under `env -i` with the isolated env already set.
# Loads the LiteLLM key into env LITELLM_API_KEY here (never on any argv, never on disk)
# and execs kimi. The provider config reads it via api_key_env = "LITELLM_API_KEY".
# OWNER_HOME is the real home (HOME here is the isolated one); the caller passes it.
set -euo pipefail
LITELLM_API_KEY=$(grep -oP '^LITELLM_MASTER_KEY=\K.*' "$OWNER_HOME/.secrets/.env.litellm" | tr -d '"')
export LITELLM_API_KEY
exec "$OWNER_HOME/.kimi-code/bin/kimi" "$@"
