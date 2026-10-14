#!/usr/bin/env bash
# run-probe.sh <label> <workdir> <prompt> [kimi flags...]
# Runs one kimi -p turn in <workdir> under strace (connect), isolated env, key via env only.
# Writes $W/runs/<label>/{stdout.txt,stderr.txt,connects.log,before.lst,after.lst,meta.json}
set -uo pipefail
W="${SCRATCH:?set SCRATCH}"/s12.6/kimi
LABEL=$1; WD=$2; PROMPT=$3; shift 3
R=$W/runs/$LABEL
[ -e "$R" ] && { echo "exists: $R" >&2; exit 3; }
mkdir -p "$R"
H=$W/home
snap(){ (cd "$WD" && find . -mindepth 1 \( -type f -printf '%y %P ' -exec sh -c 'sha256sum "$1" | cut -c1-16' _ {} \; \) -o \( ! -type f -printf '%y %P\n' \) | sort); }
snap > "$R/before.lst"
printf '%s\n' "env: ${PROBE_ENV:-} ; kimi -p <prompt> $*" > "$R/argv.txt"
printf '%s' "$PROMPT" > "$R/prompt.txt"
start=$(date +%s.%N)
( cd "$WD" && timeout 600 strace -f -qq -e trace=connect -o "$R/connects.log" \
  env -i \
    HOME="$H" KIMI_CODE_HOME="$H/.kimi-code" \
    XDG_CONFIG_HOME="$H/.config" XDG_CACHE_HOME="$H/.cache" XDG_DATA_HOME="$H/.local/share" \
    PATH="$HOME/.kimi-code/bin:/usr/local/bin:/usr/bin:/bin" \
    LANG="${LANG:-C.UTF-8}" TERM=dumb NO_COLOR=1 \
    KIMI_DISABLE_TELEMETRY=1 KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START=0 \
    OWNER_HOME="$HOME" ${PROBE_ENV:-} \
  /bin/bash "$W/kimi-exec.sh" -p "$PROMPT" "$@" \
  > "$R/stdout.txt" 2> "$R/stderr.txt" < /dev/null )
EXIT=$?
end=$(date +%s.%N)
snap > "$R/after.lst"
python3 - "$R" "$WD" "$start" "$end" "$EXIT" <<'PY'
import json, re, sys
R, WD, start, end, ex = sys.argv[1:6]
b = open(f"{R}/before.lst").read().splitlines(); a = open(f"{R}/after.lst").read().splitlines()
added = sorted(set(a) - set(b)); removed = sorted(set(b) - set(a))
leaks, dns, loop, addrs = 0, 0, 0, []
for l in open(f"{R}/connects.log", errors="replace"):
    m4 = re.search(r'sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([\d.]+)"\)', l)
    m6 = re.search(r'sa_family=AF_INET6, sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"', l)
    if m4:
        port, ad = int(m4.group(1)), m4.group(2)
        if ad == "127.0.0.53" and port == 53: dns += 1
        if ad.startswith("127."): loop += 1; addrs.append(f"{ad}:{port}")
        else: leaks += 1; addrs.append(f"LEAK {ad}:{port}")
    elif m6:
        port, ad = int(m6.group(1)), m6.group(2).lower()
        if ad == "::1" or ad.startswith("::ffff:127."): loop += 1; addrs.append(f"[{ad}]:{port}")
        else: leaks += 1; addrs.append(f"LEAK [{ad}]:{port}")
meta = {"workdir": WD, "exit": int(ex), "seconds": round(float(end)-float(start), 2),
        "fs_added_or_changed": added, "fs_removed_or_changed": removed,
        "inet_connects": addrs, "non_loopback_connects": leaks, "dns_connects": dns}
json.dump(meta, open(f"{R}/meta.json", "w"), indent=1)
print(json.dumps(meta))
PY
