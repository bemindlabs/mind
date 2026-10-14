#!/usr/bin/env bash
# kimi-env.sh <kimi args...> — run kimi with the isolated SP-5 environment (manual probes).
S=<scratch>/sp5
H=$S/homes/kimi
exec env -i \
  HOME="$H" KIMI_CODE_HOME="$H/.kimi-code" \
  XDG_CONFIG_HOME="$H/.config" XDG_CACHE_HOME="$H/.cache" XDG_DATA_HOME="$H/.local/share" \
  OWNER_HOME="$HOME" PATH="$HOME/.kimi-code/bin:/usr/local/bin:/usr/bin:/bin" \
  LANG="${LANG:-C.UTF-8}" TERM=dumb NO_COLOR=1 \
  KIMI_DISABLE_TELEMETRY=1 KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START=0 \
  /bin/bash "$S/kimi-exec.sh" "$@"
