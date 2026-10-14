#!/usr/bin/env bash
#
# B3 — the demo the whole of MVP-lite is defined by.
#
#   make an agent -> give it an identity -> `git clone` it into a bare
#   container that has only ollama -> `soul verify` passes -> a turn finishes
#
# It is a shell script rather than a subcommand because every step it
# orchestrates is somebody else's program: `bun build`, `git`, `docker`. None
# of that belongs inside an engine whose whole claim is that it needs no
# runtime of its own.
#
# ## What "a bare container" means here, stated rather than implied
#
# A stock `debian:bullseye-slim`, unmodified, with exactly two things copied
# in: the single `mind` binary from `bun build --compile`, and the working
# tree that came out of `git clone`. No bun, no node, no git, no curl, no
# vendor CLI, no credentials, no volume, and no image built by this script.
#
#   - **A binary, not bun.** Installing bun inside would need network and an
#     installer, which is no longer bare — and the binary proves the stronger
#     claim anyway: no runtime is required at all (ADR 0001 §1).
#   - **ollama lives outside the container**, on the host, reached over the
#     docker bridge gateway. "Only ollama" means the one endpoint reachable
#     from in there is a local model daemon.
#   - **`git clone` runs on the host.** What I-2 has to prove is that what git
#     holds is enough for the agent to stand up, and the bytes that arrive are
#     the same checkout either way. Installing git inside would mean `apt-get`
#     against a bullseye whose LTS has ended, so the demo would fail because
#     of a mirror rather than because of Mind — a failure that teaches
#     nothing. `docs/demo.md` says this out loud rather than burying it.
#
# ## The two things that cannot both be proved in one box
#
# A reader meeting the guard criterion below will notice it does not run in the
# container, and should be told why rather than only that.
#
# This demo proves the container is bare, and the strongest evidence for that
# is that `git` is not in it — it is on the forbidden list a few lines up, and
# the script fails if it resolves. But `mind guard` is a **git hook**: it is
# a file in `.git/hooks` that git executes, reading the index through git. A
# box with no git has nothing for it to hang on and no index for it to read.
#
# So the two proofs want opposite boxes. Installing git to prove the guard
# would delete the thing the other eleven criteria rest on; skipping the guard
# because the box has none would leave the acceptance criterion that caught a
# real escape (`100b791`, a typechange the scan never read) outside every
# claim this demo makes. Neither is acceptable, so the guard is proved on the
# **host**, against the same binary, on a clone of its own — and every line
# that reports it says so, here and in the output, because a reader who sees
# fifteen rows should not have to guess which of them were proved where.
#
# That is not a defect in the demo. It is the shape of the claim: *bare* and
# *guarded by git* are two different machines, and Mind has to work on both.
#
# ## How this script is kept from lying
#
# A demo that prints PASS without having proven anything is worse than no
# demo at all, so four things are deliberate:
#
#   1. Every value `soul verify` asks for is randomised per run. The template
#      says the user is addressed as `"you"`, which a model carrying no soul
#      guesses correctly — a pass built on that means nothing.
#   2. The values in the verify report are checked back against the values
#      written before the clone, so the identity being measured is provably
#      the one that travelled through git.
#   3. A negative control runs first: pointed at a port nobody listens on,
#      `soul verify` and `turn` must both fail. If either succeeds, this
#      script cannot tell success from failure and the demo is reported FAIL.
#   4. No retries, no reduced `--runs`, no relaxed threshold. `partial` is a
#      failure and is reported as one.
#   5. Controls are run and reported, and are **not** counted as criteria. A
#      control is what shows the instrument still works — a clean commit the
#      hook lets through, a search that finds the id *before* anything is
#      erased — not a thing Mind is being credited with. Counting them would
#      grow the number without growing the evidence. Every one of them aborts
#      the whole run when it fails, exactly as a criterion does.
#   6. `erase` is asked in both directions in the same box: a subject that was
#      never here must come back `nothing-found` and touch nothing, and the
#      subject that is here must come back `erased-and-verified` and leave the
#      id findable nowhere. One direction alone passes for a command whose
#      verdict is a constant.
#
# Exit codes, which are deliberately not collapsed into a boolean:
#
#   0  proven
#   1  ran, and did not pass
#   2  did not run (preflight) — not a result about Mind at all
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT

# Stock, public, and never built or modified by this script.
readonly DEFAULT_IMAGE="debian:bullseye-slim"

# Anything whose presence would mean the container is not bare. `bun` and
# `node` are on the list because the claim is "no runtime"; `git` is on it
# because the claim is "what git holds arrived", not "what git could fetch".
readonly FORBIDDEN_IN_CONTAINER="claude codex gemini grok copilot kimi bun node npm deno python3 git curl wget"

usage() {
  cat <<'USAGE'
usage: npm run demo -- --model <ollama-model> [--image <ref>]

  --model <m>   Required, with no default. A model id is a fact about one
                machine, and the engine carries no such facts (D-021).
  --image <ref> Base image for the bare container. Default: debian:bullseye-slim
  --help        This message.

Environment:
  OLLAMA_HOST   Base URL of the ollama the container should reach. Defaults to
                the docker bridge gateway on port 11434. A loopback URL is
                refused, because a container cannot reach the host's loopback.

Exit codes: 0 proven · 1 ran and did not pass · 2 did not run (preflight).
USAGE
}

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

# One row per criterion: "STATUS|name|detail". Printed live as it happens and
# again as a table at the end, so a reader sees every criterion — including
# the ones that never got the chance to run.
RESULTS=()
FAILURES=0

record() {
  RESULTS+=("$1|$2|$3")
  if [[ "$1" == "FAIL" ]]; then FAILURES=$((FAILURES + 1)); fi
  printf '  [%s] %s%s\n' "$1" "$2" "${3:+ — $3}"
  return 0
}

step() { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }

preflight_fail() {
  printf 'demo: did not run — %s\n' "$1" >&2
  exit 2
}

summarise() {
  printf '\n== result\n'
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r status name detail <<<"$row"
    printf '  %-4s  %-48s %s\n' "$status" "$name" "$detail"
  done
  printf '\n'
  if (( FAILURES == 0 )); then
    printf 'demo: %d/%d criteria passed — the DoD of MVP-lite holds on this machine.\n' \
      "${#RESULTS[@]}" "${#RESULTS[@]}"
    exit 0
  fi
  printf 'demo: %d of %d criteria failed. That is a real negative result; nothing was retried.\n' \
    "$FAILURES" "${#RESULTS[@]}" >&2
  exit 1
}

# A criterion failed and everything after it depended on it. Name the ones
# that were never reached rather than dropping them quietly.
abort() {
  record "FAIL" "$1" "$2"
  record "SKIP" "the criteria after this one" "not reached"
  summarise
}

# ---------------------------------------------------------------------------
# Cleanup — by container id only. Never a prune, never a name pattern.
# ---------------------------------------------------------------------------

CID=""
TMP=""
RUN_ID=""
PULLED_IMAGE=0
IMAGE="$DEFAULT_IMAGE"

cleanup() {
  local code=$?
  if [[ -n "$CID" ]]; then docker rm -f "$CID" >/dev/null 2>&1; fi
  # No `-f`: if something else started using this image meanwhile, leave it.
  if (( PULLED_IMAGE == 1 )); then docker rmi "$IMAGE" >/dev/null 2>&1; fi
  if [[ -n "$TMP" ]]; then rm -rf "$TMP"; fi
  if [[ -n "$RUN_ID" ]]; then
    local leftover
    leftover="$(docker ps -a --filter "label=mind.demo=${RUN_ID}" --format '{{.ID}}' 2>/dev/null)"
    if [[ -n "$leftover" ]]; then
      printf 'demo: a container from this run is still here: %s\n' "$leftover" >&2
      exit 1
    fi
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 0. Preflight — every failure here is exit 2, "did not run"
# ---------------------------------------------------------------------------

MODEL=""
while (( $# > 0 )); do
  case "$1" in
    --model|--image)
      (( $# >= 2 )) || preflight_fail "$1 needs a value"
      if [[ "$1" == "--model" ]]; then MODEL="$2"; else IMAGE="$2"; fi
      shift 2
      ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --image=*) IMAGE="${1#*=}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; preflight_fail "unknown argument $1" ;;
  esac
done

if [[ -z "$MODEL" ]]; then usage >&2; preflight_fail "--model is required and has no default"; fi
[[ -n "$IMAGE" ]] || preflight_fail "--image was given without a value"

for tool in docker git bun; do
  command -v "$tool" >/dev/null 2>&1 || preflight_fail "$tool is not on PATH"
done
docker info >/dev/null 2>&1 || preflight_fail "the docker daemon is not answering"

# Where the container should look for ollama. Read out of docker rather than
# written down, so no address of this machine lives in the repository (D-021).
if [[ -n "${OLLAMA_HOST:-}" ]]; then
  OLLAMA_URL="${OLLAMA_HOST%/}"
else
  GATEWAY="$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)"
  [[ -n "$GATEWAY" ]] || preflight_fail "could not read the docker bridge gateway; set OLLAMA_HOST yourself"
  OLLAMA_URL="http://${GATEWAY}:11434"
fi

# Reachability is checked before anything else about the URL, so that the
# documented check — pointing OLLAMA_HOST at a dead port must exit 2 — fails
# for the reason it was written to test.
PROBE="$(MIND_DEMO_URL="$OLLAMA_URL" MIND_DEMO_MODEL="$MODEL" bun -e '
  const url = process.env.MIND_DEMO_URL.replace(/\/$/, "");
  const model = process.env.MIND_DEMO_MODEL;
  let body;
  try {
    const response = await fetch(url + "/api/tags", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) { console.error(url + ": HTTP " + response.status); process.exit(1); }
    body = await response.json();
  } catch (cause) {
    console.error(url + ": unreachable (" + String(cause) + ")");
    process.exit(1);
  }
  const names = (body.models ?? []).map((m) => m.name);
  if (!names.includes(model)) {
    console.error(url + ": no model named " + JSON.stringify(model) +
      " — pulled here: " + (names.join(", ") || "(none)"));
    process.exit(1);
  }
  console.log(url + ": " + names.length + " model(s) pulled, " + model + " among them");
' 2>&1)" || preflight_fail "$PROBE"

# Only now: a URL this host can reach is not automatically one a container can.
if [[ "$OLLAMA_URL" =~ ^https?://(127\.|localhost|\[::1\]) ]]; then
  preflight_fail "OLLAMA_HOST points at loopback (${OLLAMA_URL}) — a container cannot reach the host's loopback; pass the bridge gateway address instead"
fi

RUN_ID="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
readonly RUN_ID
readonly SUBJECT="demo-${RUN_ID}"

printf 'mind demo — a bare container and a local model\n'
printf '  run id    %s\n' "$RUN_ID"
printf '  image     %s (stock; this script builds no image)\n' "$IMAGE"
printf '  ollama    %s (on the host, outside the container)\n' "$OLLAMA_URL"
printf '  model     %s\n' "$MODEL"
printf '  probe     %s\n' "$PROBE"
printf '\nExactly two things are copied into the container: one mind binary and one git checkout.\n'

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  note "$IMAGE is already on this machine; it will be left exactly as it was"
else
  note "$IMAGE is not here yet — pulling it, and removing it again at the end"
  docker pull "$IMAGE" >/dev/null 2>&1 || preflight_fail "could not pull $IMAGE"
  PULLED_IMAGE=1
fi

# ---------------------------------------------------------------------------
# 1. A throwaway home. Nothing below this line touches the real one.
# ---------------------------------------------------------------------------

TMP="$(mktemp -d)" || preflight_fail "could not make a temporary directory"
export HOME="$TMP/home"
export XDG_STATE_HOME="$TMP/state"
export XDG_DATA_HOME="$TMP/data"
export XDG_CONFIG_HOME="$TMP/config"
export XDG_CACHE_HOME="$TMP/cache"
mkdir -p "$HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
# git must neither read nor write anything belonging to whoever ran this.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
GIT_AS=(-c "user.name=mind demo" -c "user.email=demo@invalid")

# ---------------------------------------------------------------------------
# 2. The one binary that travels
# ---------------------------------------------------------------------------

step "build a single binary (no runtime travels with it)"
BINARY="$TMP/mind"
if ! (cd "$REPO_ROOT" && bun build bin/mind.ts --compile --outfile "$BINARY" >"$TMP/build.log" 2>&1); then
  tail -20 "$TMP/build.log" >&2
  abort "the engine compiles to one self-contained binary" "bun build failed; see the log above"
fi
record "PASS" "the engine compiles to one self-contained binary" "$(du -h "$BINARY" | cut -f1), from bin/mind.ts"

# ---------------------------------------------------------------------------
# 3. An agent, and an identity nobody could guess
# ---------------------------------------------------------------------------

step "make an agent repository"
if ! "$BINARY" new demo-agent --subject "$SUBJECT" --dir "$TMP/origin" >"$TMP/new.log" 2>&1; then
  cat "$TMP/new.log" >&2
  abort "mind new creates an agent repository" "see the output above"
fi
ORIGIN="$TMP/origin/demo-agent"
record "PASS" "mind new creates an agent repository" "subject $SUBJECT"

step "set an identity whose answers cannot be guessed"
# The template's own values are the problem this solves: a model carrying no
# soul at all answers "you" correctly. Every value verify will ask for is
# therefore unique to this run, and checked against the report afterwards.
ADDRESSES="navigator-${RUN_ID}"
SELF="quartzwren-${RUN_ID}"
# I-5 stays the first prohibition on purpose. Saying plainly that it is an AI
# is the thing a demo should be measuring, not a slogan invented for a demo.
PROHIBITION="never claims to be a person, and says plainly that it is an AI (code ${RUN_ID})"
ROLE_LINE="answers questions about its own standing instructions, for run ${RUN_ID}"

PERSON="$ORIGIN/soul/person.md"
ROLE="$ORIGIN/soul/role.md"

sed -i \
  -e "s|^addresses_user_as = .*|addresses_user_as = \"${ADDRESSES}\"|" \
  -e "s|^refers_to_self_as = .*|refers_to_self_as = [\"${SELF}\"]|" \
  "$PERSON" || abort "the identity was written into the soul files" "sed failed on person.md"
sed -i \
  -e "s|^role = .*|role = \"${ROLE_LINE}\"|" \
  -e "s|^does = .*|does = \"answers questions about its own standing instructions\"|" \
  -e "s|^does_not = .*|does_not = \"anything needing a network, a credential, or a vendor CLI\"|" \
  "$ROLE" || abort "the identity was written into the soul files" "sed failed on role.md"

# The first prohibition is the first element of a multi-line array, so it is
# addressed by position rather than by matching the template's words. A script
# that hard-coded the template text would break silently when the template
# changed, and silently is the one way this must not break.
awk -v replacement="$PROHIBITION" '
  /^prohibitions = \[$/ { print; pending = 1; next }
  pending == 1 { printf("  \"%s\",\n", replacement); pending = 0; next }
  { print }
' "$ROLE" >"$ROLE.new" || abort "the identity was written into the soul files" "awk failed on role.md"
mv "$ROLE.new" "$ROLE"

# `sed` on TOML frontmatter is brittle, so it is not trusted: the values have
# to be in the files, and the loader has to accept what came out.
MISSING=""
grep -qF "$ADDRESSES" "$PERSON" || MISSING="$MISSING addresses_user_as"
grep -qF "$SELF" "$PERSON" || MISSING="$MISSING refers_to_self_as"
grep -qF "$PROHIBITION" "$ROLE" || MISSING="$MISSING prohibitions[0]"
[[ -z "$MISSING" ]] || abort "the identity was written into the soul files" "not found afterwards:$MISSING"

if ! "$BINARY" soul check "$ORIGIN/soul" --subject "$SUBJECT" >"$TMP/check.log" 2>&1; then
  cat "$TMP/check.log" >&2
  abort "the loader accepts the edited soul" "see the output above"
fi
note "$(head -1 "$TMP/check.log")"
record "PASS" "the identity is set, and the loader accepts it" "all three answers randomised for this run"

# ---------------------------------------------------------------------------
# 4. Commit, derive on this side, and clone
# ---------------------------------------------------------------------------

step "commit — a human act, performed here by the demo itself"
if ! git -C "$ORIGIN" add -A >/dev/null 2>&1 ||
   ! git -C "$ORIGIN" "${GIT_AS[@]}" commit -q -m "demo agent ${RUN_ID}" >/dev/null 2>&1; then
  abort "the agent repository takes a first commit" "git add or git commit failed"
fi

if ! "$BINARY" rebuild "$ORIGIN" --subject "$SUBJECT" >"$TMP/rebuild-origin.log" 2>&1; then
  cat "$TMP/rebuild-origin.log" >&2
  abort "rebuild works on the origin side" "see the output above"
fi
ORIGIN_MANIFEST="$TMP/manifest-origin.json"
cp "$ORIGIN/.mind/manifest.json" "$ORIGIN_MANIFEST" ||
  abort "the origin manifest can be read" "no .mind/manifest.json after rebuild"

step "git clone — the only thing that travels"
git clone -q "$ORIGIN" "$TMP/clone" >/dev/null 2>&1 ||
  abort "the agent repository clones" "git clone failed"
if [[ -e "$TMP/clone/.mind" ]]; then
  abort "the clone carries no derived state (I-2)" ".mind/ came through the clone; .gitignore should have stopped it"
fi
record "PASS" "the clone carries no derived state (I-2)" ".mind/ is absent in the fresh clone"

# ---------------------------------------------------------------------------
# 4b. The pre-commit guard (S0.4 AC3) — on the host, and saying so
# ---------------------------------------------------------------------------
#
# See "the two things that cannot both be proved in one box" at the top: a
# hook needs git, and the container is proven not to have one. This runs on a
# clone of its own so that neither the origin nor the checkout that travels is
# touched — the manifest diff in step 7 would otherwise move for a reason that
# has nothing to do with I-2.

step "the pre-commit guard, on the host, on a clone of its own"
note "the container has no git, so no hook can run in there — this is the same"
note "binary from step 2, on a working copy that goes nowhere near the container"

GUARD_CLONE="$TMP/guard"
readonly GUARD_CRITERION="a staged typechange carrying a token is blocked (S0.4 AC3, on the host)"
readonly GUARD_CONTROLS="the guard's own controls (not a criterion)"

git clone -q "$ORIGIN" "$GUARD_CLONE" >/dev/null 2>&1 ||
  abort "$GUARD_CRITERION" "a second clone, for the guard alone, could not be made"

GUARD_HOOK="$GUARD_CLONE/.git/hooks/pre-commit"
# The hook does not travel with a clone — `.git/hooks` is not cloned and not
# tracked. `guard install` is what puts one there, and asserting the absence
# first is what makes the presence afterwards mean anything.
[[ -e "$GUARD_HOOK" ]] &&
  abort "$GUARD_CONTROLS" "a fresh clone already had a pre-commit hook; .git/hooks is not supposed to travel"
if ! "$BINARY" guard install "$GUARD_CLONE" >"$TMP/guard-install.log" 2>&1; then
  cat "$TMP/guard-install.log" >&2
  abort "$GUARD_CRITERION" "mind guard install failed; see the output above"
fi
[[ -f "$GUARD_HOOK" ]] ||
  abort "$GUARD_CRITERION" "guard install exited 0 and wrote no pre-commit hook"
# A hook whose engine path is wrong **also** exits 1, and fails closed saying
# so — which would counterfeit every block below. So the hook has to name the
# binary that was built in step 2 and nothing else.
grep -qF "$BINARY" "$GUARD_HOOK" ||
  abort "$GUARD_CONTROLS" "the hook does not name the engine built by this run; a block from it would prove nothing"
note "hook installed, and it execs the binary from step 2"

# One token for this section, built from the run id at run time: 32 characters
# after the prefix, which is what `gh[pousr]_[A-Za-z0-9]{20,}` asks for. No
# literal token is written in this file, and the scan never echoes what it
# matched — both of which are asserted below rather than assumed.
GUARD_TOKEN="ghp_${RUN_ID}${RUN_ID}${RUN_ID}${RUN_ID}"

guard_commit() {
  git -C "$GUARD_CLONE" "${GIT_AS[@]}" commit -q -m "$1" \
    >"$TMP/guard-commit.out" 2>"$TMP/guard-commit.err"
}
guard_head() { git -C "$GUARD_CLONE" rev-parse HEAD 2>/dev/null; }

# --- control: the hook lets a clean commit through -------------------------
# Without this, a hook that blocked everything — including one that is simply
# broken — would pass both blocking criteria below and prove nothing at all.
printf 'nothing in this file is worth stopping a commit for\n' >"$GUARD_CLONE/kept.md"
git -C "$GUARD_CLONE" add kept.md >/dev/null 2>&1
if ! guard_commit "a clean file ${RUN_ID}"; then
  sed 's/^/     /' "$TMP/guard-commit.err" >&2
  abort "$GUARD_CONTROLS" "the hook blocked a clean commit; every block after this would prove nothing"
fi
note "control: a clean commit passes the hook — it does not block everything"

# --- control: the rules bite at all ----------------------------------------
# A plain new file carrying a token. This was blocked before `100b791` and
# after it, which is exactly why it is a control and not the criterion.
GUARD_HEAD_BEFORE="$(guard_head)"
printf 'a token: %s\n' "$GUARD_TOKEN" >"$GUARD_CLONE/note.md"
git -C "$GUARD_CLONE" add note.md >/dev/null 2>&1
if guard_commit "a token in a plain file ${RUN_ID}"; then
  abort "$GUARD_CONTROLS" "a new file carrying a token was committed — the scan rules are not biting at all"
fi
for WANTED in "finding(s)" "note.md" "github-token"; do
  grep -qF "$WANTED" "$TMP/guard-commit.err" ||
    abort "$GUARD_CONTROLS" "the block did not mention \"$WANTED\"; it may have failed for another reason"
done
[[ "$(guard_head)" == "$GUARD_HEAD_BEFORE" ]] ||
  abort "$GUARD_CONTROLS" "the commit was blocked and HEAD moved anyway"
grep -qF "$GUARD_TOKEN" "$TMP/guard-commit.err" &&
  abort "$GUARD_CONTROLS" "the guard echoed the matched token into its own output"
git -C "$GUARD_CLONE" rm --cached -q note.md >/dev/null 2>&1
rm -f "$GUARD_CLONE/note.md"
note "control: a plain file carrying a token is blocked, HEAD does not move, and the token is not echoed"

# --- the criterion: the case that escaped ----------------------------------
# A tracked symlink replaced by a real file. `--diff-filter=ACMR` reported
# nothing for this, so forty rules ran over an empty list and the commit was
# waved through with "0 staged file(s) passed 18 rules". `T` was added in
# 100b791; this is the shape that made it necessary.
ln -s kept.md "$GUARD_CLONE/link.md" ||
  abort "$GUARD_CRITERION" "could not create the symlink this case is built on"
git -C "$GUARD_CLONE" add link.md >/dev/null 2>&1
guard_commit "a tracked symlink ${RUN_ID}" ||
  abort "$GUARD_CRITERION" "the symlink itself could not be committed, so there is nothing to replace"

rm "$GUARD_CLONE/link.md"
printf '%s\n' "$GUARD_TOKEN" >"$GUARD_CLONE/link.md"
git -C "$GUARD_CLONE" add -A >/dev/null 2>&1
git -C "$GUARD_CLONE" diff --cached --name-status >"$TMP/guard-typechange.txt" 2>&1
# If git does not call this a typechange, this is not the case that escaped —
# and a block here would be a pass for the wrong reason. Abort, never record.
grep -q "^T[[:space:]]" "$TMP/guard-typechange.txt" ||
  abort "$GUARD_CRITERION" "git reports this as $(tr '\n' ' ' <"$TMP/guard-typechange.txt"), not a typechange (T) — this is no longer the case that escaped"

GUARD_HEAD_BEFORE="$(guard_head)"
if guard_commit "the typechange ${RUN_ID}"; then
  abort "$GUARD_CRITERION" "the typechange was committed — the escape 100b791 closed is open again"
fi
for WANTED in "finding(s)" "link.md" "github-token"; do
  grep -qF "$WANTED" "$TMP/guard-commit.err" ||
    abort "$GUARD_CRITERION" "the block did not mention \"$WANTED\"; it may have failed for another reason"
done
[[ "$(guard_head)" == "$GUARD_HEAD_BEFORE" ]] ||
  abort "$GUARD_CRITERION" "the commit was blocked and HEAD moved anyway"
grep -qF "$GUARD_TOKEN" "$TMP/guard-commit.err" &&
  abort "$GUARD_CRITERION" "the guard echoed the matched token into its own output"
record "PASS" "$GUARD_CRITERION" "blocked at link.md, HEAD unmoved, token not echoed — proved on the host, not in the container"

# ---------------------------------------------------------------------------
# 5. The bare container
# ---------------------------------------------------------------------------

step "start a bare container"
# `--rm` with a bounded `sleep`: if this script is killed outright, the
# container removes itself within half an hour instead of waiting for a human.
# `--dns 127.0.0.1` leaves nothing in the container able to resolve a hostname,
# so a vendor endpoint cannot be reached by name. That is not a firewall, and
# docs/demo.md says so rather than letting a reader assume otherwise.
#
# Capabilities are deliberately *not* dropped, and this comment is here so
# that nobody adds `--cap-drop ALL` back. `docker cp` keeps the uid and mode of
# the files it carries, so the checkout arrives owned by whoever ran this and
# — under a umask of 077 — unreadable to anyone else. Root inside the
# container then needs CAP_DAC_OVERRIDE to read the soul and to write `.mind/`
# beside it. With the capability gone, `rebuild` reports the soul as missing
# and the demo fails for a reason that has nothing to do with Mind. What is
# being proven here is "a bare machine with a local model", not "a hardened
# sandbox", and the second must not be allowed to counterfeit a failure of the
# first.
CID="$(docker run -d --rm \
  --security-opt no-new-privileges \
  --dns 127.0.0.1 \
  -e "OLLAMA_HOST=${OLLAMA_URL}" \
  --label "mind.demo=${RUN_ID}" \
  "$IMAGE" sleep 1800 2>"$TMP/run.log")"
if [[ -z "$CID" ]]; then
  cat "$TMP/run.log" >&2
  abort "a bare container starts" "docker run failed"
fi
note "container ${CID:0:12} from $IMAGE"

docker cp "$BINARY" "$CID:/usr/local/bin/mind" >/dev/null 2>&1 ||
  abort "the binary is copied into the container" "docker cp failed"
docker cp "$TMP/clone" "$CID:/agent" >/dev/null 2>&1 ||
  abort "the clone is copied into the container" "docker cp failed"

step "prove the container is bare"
FOUND="$(docker exec "$CID" sh -c '
  for binary in '"$FORBIDDEN_IN_CONTAINER"'; do
    command -v "$binary" >/dev/null 2>&1 && echo "$binary"
  done
  exit 0
')"
if [[ -n "$FOUND" ]]; then
  abort "no vendor CLI and no runtime in the container (I-1)" "found: $(echo "$FOUND" | tr '\n' ' ')"
fi
record "PASS" "no vendor CLI and no runtime in the container (I-1)" "checked: $FORBIDDEN_IN_CONTAINER"

note "everything this container has that the stock image did not:"
docker diff "$CID" | sed 's/^/     /'

# ---------------------------------------------------------------------------
# 6. Does the binary even run here? The assumption this demo can falsify.
# ---------------------------------------------------------------------------

step "run the binary against this image's libc"
if ! VERSION="$(docker exec "$CID" mind version 2>&1)"; then
  printf '%s\n' "$VERSION" >&2
  abort "the compiled binary runs with no runtime installed" \
    "it did not run here — the claim that mind needs no runtime does not hold on this base image"
fi
record "PASS" "the compiled binary runs with no runtime installed" "mind $VERSION on $IMAGE"

note "what mind says this machine can reach:"
docker exec "$CID" mind backends 2>&1 | sed 's/^/     /'

# ---------------------------------------------------------------------------
# 7. rebuild — I-2, measured rather than asserted
# ---------------------------------------------------------------------------

step "rebuild what git does not carry"
if docker exec "$CID" mind rebuild /agent --subject "$SUBJECT" --check >"$TMP/check-missing.log" 2>&1; then
  cat "$TMP/check-missing.log" >&2
  abort "a fresh clone reports its derived state as missing" "rebuild --check exited 0, as if it were already built"
fi
grep -q "missing" "$TMP/check-missing.log" ||
  abort "a fresh clone reports its derived state as missing" "rebuild --check said: $(head -1 "$TMP/check-missing.log")"
note "$(head -1 "$TMP/check-missing.log")"

if ! docker exec "$CID" mind rebuild /agent --subject "$SUBJECT" >"$TMP/rebuild.log" 2>&1; then
  cat "$TMP/rebuild.log" >&2
  abort "rebuild reconstructs the derived state in the container (I-2)" "see the output above"
fi
if ! docker exec "$CID" mind rebuild /agent --subject "$SUBJECT" --check >"$TMP/check-fresh.log" 2>&1; then
  cat "$TMP/check-fresh.log" >&2
  abort "the rebuilt state reports fresh (I-2)" "see the output above"
fi
record "PASS" "rebuild works from what git holds alone (I-2)" "$(head -1 "$TMP/check-fresh.log")"

docker exec "$CID" cat /agent/.mind/manifest.json >"$TMP/manifest-clone.json" 2>/dev/null ||
  abort "the container's manifest can be read back" "cat failed"
ORIGIN_STAMPS="$(grep -c '"built_at"' "$ORIGIN_MANIFEST")"
CLONE_STAMPS="$(grep -c '"built_at"' "$TMP/manifest-clone.json")"
if [[ "$ORIGIN_STAMPS" != "1" || "$CLONE_STAMPS" != "1" ]]; then
  abort "both manifests carry exactly one build timestamp" "origin=$ORIGIN_STAMPS clone=$CLONE_STAMPS"
fi
if ! diff <(grep -v '"built_at"' "$ORIGIN_MANIFEST") <(grep -v '"built_at"' "$TMP/manifest-clone.json") >"$TMP/manifest.diff" 2>&1; then
  sed 's/^/     /' "$TMP/manifest.diff" >&2
  abort "the rebuilt manifest differs only in built_at (S0.3 AC7)" "something else moved; see the diff above"
fi
record "PASS" "the rebuilt manifest differs only in built_at (S0.3 AC7)" "same artefacts, same source hashes"

# ---------------------------------------------------------------------------
# 8. Negative control — run before anything is allowed to pass
# ---------------------------------------------------------------------------

step "negative control: prove this demo is able to fail"
# `rebuild` is given the repository root; `soul check`, `soul verify` and
# `turn` are all given the soul directory inside it. Getting that wrong is
# exactly the kind of mistake a negative control is for: a `turn` pointed at
# the wrong directory also exits non-zero, and would have passed this check
# while proving nothing at all.
readonly DEAD="http://127.0.0.1:9"
docker exec -e "OLLAMA_HOST=$DEAD" "$CID" \
  mind soul verify /agent/soul --subject "$SUBJECT" --backend ollama --model "$MODEL" \
  >"$TMP/neg-verify.log" 2>&1
NEG_VERIFY=$?
docker exec -i -e "OLLAMA_HOST=$DEAD" "$CID" \
  mind turn /agent/soul --subject "$SUBJECT" --model "$MODEL" --prompt-file - \
  >"$TMP/neg-turn.log" 2>&1 <<<"say anything at all"
NEG_TURN=$?
if (( NEG_VERIFY == 0 || NEG_TURN == 0 )); then
  abort "with no model reachable, verify and turn both fail" \
    "verify exited $NEG_VERIFY, turn exited $NEG_TURN — a zero here means this script cannot tell pass from fail"
fi
# And they have to fail for *this* reason. A command pointed at the wrong
# directory also exits non-zero, and would sail through the check above while
# proving nothing — which is how a negative control quietly stops working.
grep -q "unreachable" "$TMP/neg-verify.log" ||
  abort "with no model reachable, verify and turn both fail" \
    "verify failed, but not because the model was unreachable: $(head -3 "$TMP/neg-verify.log" | tr '\n' ' ')"
grep -q "no backend answered" "$TMP/neg-turn.log" ||
  abort "with no model reachable, verify and turn both fail" \
    "turn failed, but not because no backend answered: $(head -3 "$TMP/neg-turn.log" | tr '\n' ' ')"
record "PASS" "with no model reachable, both commands fail" "verify exit $NEG_VERIFY · turn exit $NEG_TURN, both for the right reason"

# ---------------------------------------------------------------------------
# 9. soul verify — the criterion the DoD names
# ---------------------------------------------------------------------------

step "soul verify, against the local model only"
note "3 runs x 3 questions, no retries, and 'partial' counts as a failure"
docker exec "$CID" \
  mind soul verify /agent/soul --subject "$SUBJECT" --backend ollama --model "$MODEL" --json \
  >"$TMP/verify.json" 2>"$TMP/verify.err"
VERIFY_EXIT=$?

if [[ ! -s "$TMP/verify.json" ]]; then
  sed 's/^/     /' "$TMP/verify.err" >&2
  abort "soul verify passes on the local model (DoD · S0.3 AC4)" "nothing came back on stdout"
fi

# The report is checked against the values written before the clone. A report
# that agreed with the template instead of with this run would be a pass
# nobody should believe.
TRANSCRIPT="$(MIND_DEMO_JSON="$TMP/verify.json" \
  MIND_DEMO_ADDRESSES="$ADDRESSES" \
  MIND_DEMO_SELF="$SELF" \
  MIND_DEMO_PROHIBITION="$PROHIBITION" \
  bun -e '
  const report = await Bun.file(process.env.MIND_DEMO_JSON).json();
  const row = report.backends.find((b) => b.backend === "ollama");
  const problems = [];
  if (row === undefined) {
    problems.push("no ollama row in the report");
  } else {
    if (row.level !== "confirmed") problems.push("level is " + row.level + ", not confirmed");
    if (row.stable !== true) problems.push(row.flipped + " question(s) changed verdict across runs");
    if (row.channel.kind !== "system-field") problems.push("identity arrived as " + row.channel.kind);
    const wanted = {
      addresses: process.env.MIND_DEMO_ADDRESSES,
      self: process.env.MIND_DEMO_SELF,
      prohibition: process.env.MIND_DEMO_PROHIBITION,
    };
    for (const [probe, value] of Object.entries(wanted)) {
      const asked = row.runs.filter((r) => r.probe === probe);
      if (asked.length === 0) { problems.push("question " + probe + " was never asked"); continue; }
      if (!asked.every((r) => r.expected.includes(value))) {
        problems.push("question " + probe + " was scored against " +
          JSON.stringify(asked[0].expected) + ", not against the value set before the clone");
      }
    }
    const passed = row.runs.filter((r) => r.verdict === "confirmed").length;
    console.error("     " + row.backend + "  level=" + row.level + "  " + passed + "/" +
      row.runs.length + " answers  identity=" + row.channel.strength + " (" + row.channel.kind + ")");
    for (const item of row.runs) {
      console.error("     " + item.probe + " run " + item.run + " · " + item.verdict +
        " · " + item.evidence.durationMs + "ms");
      console.error("       expected: " + JSON.stringify(item.expected));
      console.error("       answered: " + JSON.stringify(item.answer));
    }
  }
  if (problems.length > 0) { console.log(problems.join(" · ")); process.exit(1); }
  console.log("confirmed on every question of every run, identity carried as a system prompt");
' 2>&1 >"$TMP/verdict.txt")"
VERDICT_EXIT=$?
printf '%s\n' "$TRANSCRIPT"

if (( VERIFY_EXIT != 0 || VERDICT_EXIT != 0 )); then
  abort "soul verify passes on the local model (DoD · S0.3 AC4)" \
    "soul verify exited ${VERIFY_EXIT} · $(cat "$TMP/verdict.txt" 2>/dev/null)"
fi
record "PASS" "soul verify passes on the local model (DoD · S0.3 AC4)" "$(cat "$TMP/verdict.txt")"

# ---------------------------------------------------------------------------
# 10. A turn that finishes, down the default chain (S2.1 AC6)
# ---------------------------------------------------------------------------

step "one turn, with no --backend at all"
# No `--backend`: the default chain is claude -> codex -> ollama, and it has
# to fall through to the local model on its own. That is what AC6 says, and
# naming ollama here would quietly delete the thing being tested.
#
# The task is arithmetic rather than anything clever because what is being
# measured is the plumbing, not the model: the answer has to be checkable by
# this script and different on every run.
LEFT=$(( (RANDOM % 900) + 100 ))
RIGHT=$(( (RANDOM % 900) + 100 ))
ANSWER=$((LEFT + RIGHT))
PROMPT="Compute ${LEFT} + ${RIGHT}. Reply with the number alone: no words, no commas, no working."
note "asked, randomised per run and checked by this script rather than by eye: ${LEFT} + ${RIGHT}"

docker exec -i "$CID" mind turn /agent/soul --subject "$SUBJECT" --model "$MODEL" --prompt-file - \
  >"$TMP/turn.out" 2>"$TMP/turn.err" <<<"$PROMPT"
TURN_EXIT=$?
sed 's/^/     /' "$TMP/turn.out"
sed 's/^/     /' "$TMP/turn.err"

if (( TURN_EXIT != 0 )); then
  abort "a turn finishes on ollama alone (S2.1 AC6)" "mind turn exited $TURN_EXIT"
fi
if ! grep -qE "(^|[^0-9])${ANSWER}([^0-9]|$)" "$TMP/turn.out"; then
  abort "a turn finishes on ollama alone (S2.1 AC6)" "the answer ${ANSWER} is not in what came back"
fi
if ! grep -q "answered by ollama" "$TMP/turn.err"; then
  abort "a turn finishes on ollama alone (S2.1 AC6)" "the route line does not name ollama"
fi
record "PASS" "a turn finishes on ollama alone (S2.1 AC6)" "the default chain fell through to the local model"

step "the ledger, read back inside the container"
docker exec "$CID" mind ledger show --subject "$SUBJECT" --json >"$TMP/ledger.json" 2>&1 ||
  abort "every recorded turn went to the local model (I-1)" "ledger show failed"
LEDGER="$(MIND_DEMO_JSON="$TMP/ledger.json" bun -e '
  const shown = await Bun.file(process.env.MIND_DEMO_JSON).json();
  const backends = [...new Set(shown.entries.map((e) => e.backend))].sort();
  const answered = shown.entries.filter((e) => e.confidence === "confirmed" || e.confidence === "partial");
  const vendors = backends.filter((b) => b !== "ollama");
  const problems = [];
  if (vendors.length > 0) problems.push("a vendor backend was handed the prompt: " + vendors.join(", "));
  if (answered.length === 0) problems.push("no recorded turn actually answered");
  if (problems.length > 0) { console.log(problems.join(" · ")); process.exit(1); }
  console.log(shown.entries.length + " line(s), every one of them ollama · " + answered.length + " answered");
' 2>&1)"
if (( $? != 0 )); then
  abort "every recorded turn went to the local model (I-1)" "$LEDGER"
fi
record "PASS" "every recorded turn went to the local model (I-1)" "$LEDGER"

# ---------------------------------------------------------------------------
# 11. erase — I-4 and S7.2, in the container, and last because it destroys
#     every piece of state the steps above read
# ---------------------------------------------------------------------------

step "erase, asked in both directions, inside the bare container"
note "last on purpose: this removes the ledger, the soul and .mind/ that every"
note "step above reads. Both directions run in the container — erase needs no"
note "git, which is the whole reason the crash it used to have here mattered."

readonly ERASE_CONTROLS="erase's own controls (not a criterion)"
readonly ERASE_ABSENT="erase of a subject never held is nothing-found and touches nothing (S7.2 AC6)"
readonly ERASE_REAL="erase of the subject leaves the id findable nowhere in the container (I-4 · S7.2 AC2/AC3)"

# `.git` is excluded from every search below, and the reason is measured
# rather than assumed — see the note printed after the erase.
readonly FIND_ID="grep -rl '${SUBJECT}' /root /agent --exclude-dir=.git 2>/dev/null | wc -l"
readonly DIGEST="find /root/.local /agent -path /agent/.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum"

# --- control: the search has teeth before anything is deleted --------------
# A zero afterwards is only evidence if the same search was non-zero before.
HITS_BEFORE="$(docker exec "$CID" sh -c "$FIND_ID" 2>/dev/null | tr -d ' ')"
if [[ -z "$HITS_BEFORE" ]] || (( HITS_BEFORE < 1 )); then
  abort "$ERASE_CONTROLS" "the id was findable in ${HITS_BEFORE:-no} file(s) before anything was erased — a zero afterwards would prove nothing"
fi
note "control: the id is in ${HITS_BEFORE} file(s) in the container before anything is erased"

docker exec "$CID" sh -c "$DIGEST" >"$TMP/before.sum" 2>/dev/null
[[ -s "$TMP/before.sum" ]] ||
  abort "$ERASE_CONTROLS" "no digest could be taken of the container's files; the untouched check below would be vacuous"

# --- the direction that must find nothing ----------------------------------
# `--no-agent`, and deliberately in a home that holds the *real* subject's
# data: D-026's dangerous case is a mistyped id on a machine that has somebody
# else's records, where "nothing found" must not be reported over a search
# that read nothing, and where the correctly spelled subject must not lose a
# single byte.
docker exec "$CID" mind erase "demo-${RUN_ID}-absent" --no-agent \
  --by "the demo, run ${RUN_ID}" --yes --json \
  >"$TMP/erase-absent.json" 2>"$TMP/erase-absent.err"
ERASE_ABSENT_EXIT=$?

if (( ERASE_ABSENT_EXIT != 3 )); then
  sed 's/^/     /' "$TMP/erase-absent.err" >&2
  abort "$ERASE_ABSENT" "exit ${ERASE_ABSENT_EXIT}, not 3 — a withdrawal that removed nothing must not be read by \`&&\` as a completed one"
fi
ABSENT="$(MIND_DEMO_JSON="$TMP/erase-absent.json" bun -e '
  const cert = await Bun.file(process.env.MIND_DEMO_JSON).json();
  const problems = [];
  if (cert.verdict !== "nothing-found") problems.push("verdict is " + cert.verdict);
  if (cert.verification.removed.total !== 0) {
    problems.push(cert.verification.removed.total + " thing(s) were removed under an id nobody holds");
  }
  if (!(cert.verification.filesRead > 0)) {
    problems.push("filesRead is " + cert.verification.filesRead +
      " — nothing was read, so `nothing found` is not a reading of this machine");
  }
  if (cert.agent.history !== "not-examined") problems.push("agent.history is " + cert.agent.history);
  if (problems.length > 0) { console.log(problems.join(" · ")); process.exit(1); }
  console.log("exit 3 · nothing-found · 0 removed · " + cert.verification.filesRead +
    " file(s) of another subject read and left alone");
' 2>&1)"
(( $? == 0 )) || abort "$ERASE_ABSENT" "$ABSENT"
# S7.2 AC3 asks for this on every run, `--json` included: a promise kept only
# in the mode nobody automates is not one.
grep -q "does not search" "$TMP/erase-absent.err" ||
  abort "$ERASE_ABSENT" "the list of what was not searched was not printed"

docker exec "$CID" sh -c "$DIGEST" >"$TMP/after-absent.sum" 2>/dev/null
if ! diff -q "$TMP/before.sum" "$TMP/after-absent.sum" >/dev/null 2>&1; then
  diff "$TMP/before.sum" "$TMP/after-absent.sum" | head -10 >&2
  abort "$ERASE_ABSENT" "a file changed under a subject id this machine never held"
fi
record "PASS" "$ERASE_ABSENT" "$ABSENT · every file byte-identical afterwards"

# --- the direction that must find, remove and verify -----------------------
docker exec "$CID" mind erase "$SUBJECT" --agent /agent \
  --by "the demo, run ${RUN_ID}" --yes --json \
  >"$TMP/erase.json" 2>"$TMP/erase.err"
ERASE_EXIT=$?

if (( ERASE_EXIT != 0 )); then
  tail -20 "$TMP/erase.err" | sed 's/^/     /' >&2
  abort "$ERASE_REAL" "mind erase exited ${ERASE_EXIT}; the verdict and the reason are above"
fi
ERASED="$(MIND_DEMO_JSON="$TMP/erase.json" bun -e '
  const cert = await Bun.file(process.env.MIND_DEMO_JSON).json();
  const problems = [];
  if (cert.verdict !== "erased-and-verified") problems.push("verdict is " + cert.verdict);
  if (!(cert.verification.found.total > 0)) problems.push("nothing was found to remove");
  if (!(cert.verification.removed.total > 0)) problems.push("erased-and-verified over 0 removed");
  // The container has no git, and the certificate has to say so in those words
  // rather than reporting a count of zero over a history that holds the soul.
  if (cert.agent.history !== "no-git") {
    problems.push("agent.history is " + cert.agent.history + ", not no-git — in a container with no git");
  }
  if (cert.agent.commits !== null) problems.push("a commit count was printed by a machine with no git");
  if (problems.length > 0) { console.log(problems.join(" · ")); process.exit(1); }
  console.log("exit 0 · erased-and-verified · " + cert.verification.found.total + " found · " +
    cert.verification.removed.total + " removed · git history UNKNOWN, not zero");
' 2>&1)"
(( $? == 0 )) || abort "$ERASE_REAL" "$ERASED"
grep -q "does not search" "$TMP/erase.err" ||
  abort "$ERASE_REAL" "the list of what was not searched was not printed"

# The check AC3 is written as, run against the filesystem rather than read off
# the report: the id in no file's bytes, and in no file's *name* either — a
# directory called after the subject is the identifier, still there.
HITS_AFTER="$(docker exec "$CID" sh -c "$FIND_ID" 2>/dev/null | tr -d ' ')"
(( HITS_AFTER == 0 )) ||
  abort "$ERASE_REAL" "the id is still in ${HITS_AFTER} file(s) outside .git after an erased-and-verified verdict"
NAMED_AFTER="$(docker exec "$CID" sh -c \
  "find /root /agent -path /agent/.git -prune -o -name '*${SUBJECT}*' -print 2>/dev/null")"
[[ -z "$NAMED_AFTER" ]] ||
  abort "$ERASE_REAL" "a path is still named after the subject: $(echo "$NAMED_AFTER" | tr '\n' ' ')"

# And the zero that is worth nothing, printed rather than quietly relied on.
IN_GIT="$(docker exec "$CID" sh -c "grep -rl '${SUBJECT}' /agent/.git 2>/dev/null | wc -l" | tr -d ' ')"
note "grep finds the id in ${IN_GIT} file(s) under /agent/.git — and that number is not evidence of"
note "anything. git objects are zlib-compressed, so grep cannot see an identifier in there whether"
note "it is present or not (measured: it reads 0 over a history that demonstrably holds the soul)."
note "It IS in there: step 4 committed the soul, and erase does not rewrite history and says so."
note "That is why .git is excluded above, and why AC5's evidence is the sentence on the certificate"
note "and never this zero."
record "PASS" "$ERASE_REAL" "$ERASED · id found in 0 file(s) and 0 path name(s) outside .git"

summarise
