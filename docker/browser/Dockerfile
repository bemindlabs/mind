# mind's per-task browser (D-151, D-155): headless Chromium driven by the
# official Playwright MCP server, one container per task, built on this
# machine and never pushed anywhere.
#
#   mind browser up …   (builds it when its tag is missing)
#
# The tag is `mind-browser:<Playwright MCP version>-<12 hex of this
# directory's digest>` (src/browser/runtime.ts), so an edited file here is a
# new image rather than a stale one.
#
# ## Why Chromium runs with --no-sandbox, and why that is acceptable here
#
# Chromium's own sandbox needs unprivileged user namespaces (or a setuid
# helper). Ubuntu's AppArmor restricts user namespaces on this server, and
# docker's default seccomp profile blocks the clone flags as well, so inside a
# container the sandbox cannot start and Chromium refuses to run without
# `--no-sandbox`. Granting the container what the sandbox needs (`SYS_ADMIN`,
# an unconfined seccomp profile) would weaken the outer boundary to strengthen
# the inner one, which is the wrong trade.
#
# So the container is the fence, as D-151 records: a fresh container per task
# (`--rm`), no host mounts except the task's output directory, `--cap-drop ALL`
# with only NET_ADMIN, SETUID, SETGID and KILL added back — and the browser
# itself runs with an empty capability set (entrypoint.sh tabulates who holds
# what: docker-init and the root deadline keep a few, the browser, guard and
# proxy none) — `no-new-privileges`, docker's default seccomp and AppArmor
# profiles, memory and pid limits, the MCP port published on 127.0.0.1 only and
# reachable from the bridge's gateway only, a per-task bearer token at the
# guard in front of it (guard.mjs), and an egress firewall that lets packets out
# only from the allowlist proxy (proxy.mjs). A page that escapes the renderer
# lands in a process with no capabilities, no route out except that proxy, and
# nothing of the host's to read.

# node:22-bookworm-slim, pinned by digest (2026-10-05).
FROM node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# The pinned Playwright MCP release; its own `playwright` dependency decides the
# Chromium build installed below, so the two cannot drift apart.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables util-linux coreutils ca-certificates fonts-noto-core fonts-thai-tlwg \
 && npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && cd /usr/local/lib/node_modules/@playwright/mcp \
 && npx --no-install playwright install --with-deps chromium chromium-headless-shell \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
 && chmod -R a+rX /opt/ms-playwright \
 && mkdir -p /home/browser /out \
 && chmod 1777 /home/browser

COPY --chmod=0555 entrypoint.sh /opt/mind/entrypoint.sh
COPY --chmod=0444 proxy.mjs guard.mjs mcp-config.mjs record.cjs release.cjs describe.cjs cdp-read.cjs sensitive.cjs /opt/mind/

LABEL org.opencontainers.image.title="mind-browser" \
      org.opencontainers.image.description="Per-task headless Chromium + Playwright MCP behind an egress allowlist (mind D-151/D-155)" \
      dev.mind.playwright-mcp="${PLAYWRIGHT_MCP_VERSION}"

EXPOSE 8931
ENTRYPOINT ["/opt/mind/entrypoint.sh"]
