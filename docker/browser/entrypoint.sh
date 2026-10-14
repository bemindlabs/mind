#!/bin/sh
# The per-task browser container's start (D-151), in the order that matters.
#
# The container is started with `--cap-drop ALL` and exactly five added back:
# NET_ADMIN (the firewall), SETUID and SETGID (changing uid), KILL (the
# deadline) and SETPCAP — without which `setpriv --bounding-set` cannot shrink
# a bounding set at all. What holds which, once this script is done:
#
# | process                         | uid          | capabilities                |
# |---------------------------------|--------------|-----------------------------|
# | docker-init (PID 1, `--init`)   | root         | the five above — it only reaps and forwards docker's signals; nothing here talks to it |
# | timeout (the deadline)          | root         | KILL, SETUID, SETGID, SETPCAP (no NET_ADMIN); SETPCAP and SETUID/SETGID only so the setpriv under it can drop to nothing |
# | Playwright MCP + Chromium       | the owner's  | none (bounding set empty, no-new-privileges) |
# | the guard (guard.mjs)           | 10003        | none                        |
# | the egress proxy (proxy.mjs)    | 10002        | none                        |
# | the two log writers (cat)       | the owner's  | none                        |
#
# The deadline runs as root on purpose: the browser's uid cannot stop or kill
# it (SIGSTOP from inside does not outlive the deadline), and it kills the
# browser with KILL when the deadline passes.
set -eu
umask 077

: "${MIND_ALLOW:?MIND_ALLOW must name the task's allowed origins}"
: "${MIND_UID:?MIND_UID must be the owner's uid}"
: "${MIND_GID:?MIND_GID must be the owner's gid}"
: "${MIND_HOST_PORT:?MIND_HOST_PORT must be the published loopback port}"
: "${MIND_TOKEN:?MIND_TOKEN must be the task's token}"
TOKEN="$MIND_TOKEN"
unset MIND_TOKEN
# D-156: a task that can ask for the owner's yes has a wait, and its release *public* key (review of PR #24,
# round 3): releases are Ed25519-signed by the task's runner, whose private key never enters this container.
APPROVAL_WAIT="${MIND_APPROVAL_WAIT:-0}"
TTL="${MIND_TTL:-1800}"
EGRESS_ID=10002
GUARD_ID=10003
GUARD_PORT=8931
MCP_PORT=8932
PROXY_PORT=3128

if [ "$MIND_UID" = 0 ] || [ "$MIND_GID" = 0 ]; then
  echo "mind browser: refusing to run the browser as root" >&2
  exit 64
fi
case "$MIND_UID:$MIND_GID" in
  "$EGRESS_ID":* | *:"$EGRESS_ID" | "$GUARD_ID":* | *:"$GUARD_ID")
    echo "mind browser: the owner's uid/gid collides with the proxy's or the guard's" >&2
    exit 64 ;;
esac

# The docker bridge's gateway: the only address the published port arrives from
# (docker forwards 127.0.0.1:<port> on the host through it).
GATEWAY=$(node -e '
  const line = require("fs").readFileSync("/proc/net/route", "utf8").split("\n").find((l) => l.split("\t")[1] === "00000000");
  const hex = line.split("\t")[2];
  console.log([3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join("."));')

# Outbound: only the proxy's group leaves; loopback to the MCP server's own port
# only from the guard's uid (a page cannot reach the unauthenticated server).
# Inbound: the guard's port from the gateway only — not from other containers on
# the bridge — and replies to what was sent.
for table in iptables ip6tables; do
  "$table" -P OUTPUT DROP
  "$table" -A OUTPUT -o lo -p tcp --dport "$MCP_PORT" -m owner ! --uid-owner "$GUARD_ID" -j REJECT
  "$table" -A OUTPUT -o lo -j ACCEPT
  "$table" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "$table" -A OUTPUT -m owner --gid-owner "$EGRESS_ID" -j ACCEPT
  "$table" -P INPUT DROP
  "$table" -A INPUT -i lo -j ACCEPT
  "$table" -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done
iptables -A INPUT -p tcp -s "$GATEWAY" --dport "$GUARD_PORT" -j ACCEPT

# Only ever called as `drop … &`: the forked child replaces itself (`exec`), so
# no root shell is left behind as a parent.
drop() {
  uid="$1"; gid="$2"; shift 2
  exec setpriv --reuid "$uid" --regid "$gid" --clear-groups \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- "$@"
}

# Logs go through writers that run as the owner, so they are the owner's files
# (I-4: `erase` must be able to remove them), mode 600 under umask 077. A FIFO
# each, so that no root shell has to sit in the middle of a pipeline.
mkdir -p /run/mind
chmod 0755 /run/mind
for name in egress actions; do
  mkfifo -m 0600 "/run/mind/$name.fifo"
done
# Both ends of each FIFO are opened by root (the FIFOs are root's, 0600, and
# root here has no DAC override) in the forked child, before it drops: so the
# browser's uid can neither read the log on its way nor write lines into it.
drop "$MIND_UID" "$MIND_GID" sh -c 'umask 077; exec cat >> /out/egress.jsonl' < /run/mind/egress.fifo &
drop "$MIND_UID" "$MIND_GID" sh -c 'umask 077; exec cat >> /out/actions.jsonl' < /run/mind/actions.fifo &
drop "$EGRESS_ID" "$EGRESS_ID" env -i PATH="$PATH" HOME=/nonexistent \
    MIND_ALLOW="$MIND_ALLOW" MIND_PROXY_PORT="$PROXY_PORT" node /opt/mind/proxy.mjs > /run/mind/egress.fifo &
drop "$GUARD_ID" "$GUARD_ID" env -i PATH="$PATH" HOME=/nonexistent MIND_TOKEN="$TOKEN" \
    MIND_OPERATE="${MIND_OPERATE:-1}" node /opt/mind/guard.mjs > /run/mind/actions.fifo &
TOKEN=

# Wait for the proxy before the browser can ask it anything.
i=0
while ! node -e "require('net').connect($PROXY_PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo "mind browser: the egress proxy did not start" >&2; exit 70; fi
  sleep 0.1
done

# Playwright MCP's configuration, written by root and only readable. Its own
# origin list is a second, softer layer; WebMCP is off so a page cannot hand the
# model tools of its own.
node /opt/mind/mcp-config.mjs > /run/mind/mcp.json
chmod 0444 /run/mind/mcp.json

# The deadline as root with KILL, SETUID and SETGID only; the browser beneath it
# with nothing.
exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all,+kill,+setuid,+setgid,+setpcap -- \
  timeout --signal=TERM --kill-after=10 "$TTL" \
  setpriv --reuid "$MIND_UID" --regid "$MIND_GID" --clear-groups \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- \
  env -i PATH="$PATH" HOME=/home/browser TMPDIR=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    MIND_APPROVAL_WAIT="$APPROVAL_WAIT" MIND_RELEASE_PUBKEY="${MIND_RELEASE_PUBKEY:-}" \
  playwright-mcp --config /run/mind/mcp.json
