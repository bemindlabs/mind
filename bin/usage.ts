/**
 * The help text, which is most of what a first-time reader of this CLI reads.
 *
 * Its own file because it is 250 lines of prose interpolating a dozen values
 * out of `src/`, and because it is the one thing every new command has to
 * touch — keeping it beside one command's code would have made that command's
 * file the shared one instead.
 */

import { DERIVED_DIR } from "../src/agent/index.ts";
import { AUTONOMY_FILE, AUTONOMY_MAX_ENV, PROPOSAL_FENCE, STOP_FILE } from "../src/decide/index.ts";
import { PHASE_A_BACKENDS } from "../src/exec/index.ts";
import { SUMMARY_PATH } from "../src/observer/index.ts";
import { DEFAULT_RUNS, LEVEL_LEGEND, PERSON_FILE, ROLE_FILE } from "../src/soul/index.ts";
import { VERSION } from "../src/version.ts";

export const USAGE = `mind ${VERSION} — build AGI agents you actually own

Usage:
  mind version                       Print the version
  mind backends                      What this machine can reach, and how identity lands
  mind doctor [--model a,b] [--backend a,b] [--home <dir>] [--no-version]
                [--agent <dir> --subject <id>] [--ollama <url>] [--qdrant <url>] [--json]
                                        What is installed, missing or stale —
                                        the CLIs and whether the registry's
                                        reading of each is still current, the
                                        local model route, free VRAM, the vector
                                        store, and which identity is worn.
                                        Mind writes nothing; \`--version\`
                                        starts six other programs, which write
                                        their own caches. \`--no-version\` skips
                                        those probes and the drift check with
                                        them. Exit 1 only when the local route
                                        is broken, or when a file a program
                                        running as you can read holds the
                                        LiteLLM master key (it says "not safe").
  mind setup [--no-turn]              First run, one question at a time:
                                        checks this machine, creates an agent,
                                        describes its soul, runs a first turn.
                                        Raises no autonomy and enables nothing.
  mind new <name> --subject <id> [--dir <parent>]
                                        Create an agent repository: soul,
                                        memory, consent, and a .gitignore with
                                        one line in it. Runs \`git init\` and
                                        stops there — no commit, no remote.
  mind rebuild <dir> --subject <id> [--check]
                                        Rebuild <dir>/${DERIVED_DIR} from what git holds.
                                        --check reports fresh, stale or missing
                                        and writes nothing.
  mind soul check <dir> --subject <id>
                                        Validate the soul in <dir> — a soul directory or an agent repository (D-033) — with line numbers
  mind soul import <agent-dir> --subject <id> --map <file> --out <dir>
                                        Convert a bwoc agent directory into a soul
  mind soul edit <dir> --subject <id> (--profile <file.json> [--yes] | --print)
                                        The soul from a flat JSON profile (what
                                        the web Profile wizard sends): says which
                                        fields change, writes only with --yes, and
                                        only a soul that still loads.
  mind soul apply <dir> --subject <id> [--backend a,b] [--apply]
                                        Render an identity into each backend.
                                        Prints a diff and writes nothing unless
                                        you pass --apply.
  mind worn [--backend a,b] [--home <dir>] [--subject <id>] [--json]
                                        Which identity this machine is wearing,
                                        read out of each backend's instruction
                                        file. Exit 0 when exactly one is worn,
                                        intact, everywhere Mind looked — and
                                        when it is the one you named, if you
                                        named one.
  mind soul verify <dir> --subject <id> [--backend a,b] [--home <dir>]
                     [--model <m> | --model <backend>=<m>,…] [--runs N] [--json]
                                        Ask each backend three questions only
                                        this soul can answer, and report what
                                        came back. Writes nothing.
  mind soul revoke --subject <id> [--backend a,b] [--apply]
                                        Take Mind's block out of every file
                                        soul apply wrote — back byte for byte
                                        to what it was before the first apply,
                                        or removed if apply created it. Dry run
                                        without --apply; all or nothing.
  mind soul card <dir> --subject <id> [--url <base-url>]
                                        Print the A2A 1.0.0 Agent Card this soul
                                        would publish — from role.md only,
                                        saying it is an AI, and with the agent's
                                        public key if \`mind key\` made one
                                        (it says so if not). Makes no key and
                                        serves nothing; \`a2a serve\` serves it.
  mind turn <dir> --subject <id> (--prompt <text> | --prompt-file <path> | --proposal <id>)
             [--backend a,b,c] [--route auto|local|cloud] [--model <m> | --model <backend>=<m>,…]
             [--private] [--proposal <id>]
             [--no-recall] [--no-proposals] [--recall-chars <n>] [--history-json <[{role,text}]>] [--json]
                                        Run one turn wearing this soul. Tries
                                        each backend in order until one really
                                        answers. Records one ledger line per
                                        backend that was actually handed the
                                        prompt. --proposal spends an approved
                                        proposal on this turn: a pending or
                                        refused one stops it (exit 4), and the
                                        approval is spent before the prompt
                                        goes, so a second turn needs a second
                                        approval. Under --proposal the prompt
                                        is the approved action, read from its
                                        record; a different --prompt is refused
                                        and nothing is spent (D-153).
                                        --route defaults to auto. When an
                                        acting turn needs recalled pieces kept
                                        from cloud, auto puts the fenced local
                                        CLI chain first. local asks for that
                                        chain; cloud keeps the usual chain.
                                        An explicit --backend chain wins.
                                        Recall: pieces of memory/ related to
                                        the prompt ride along beside the soul,
                                        whole or not at all, up to 4500
                                        characters (--recall-chars), each named
                                        on stderr before the prompt goes. The
                                        prompt itself is sent as typed.
                                        At autonomy level 1 the model is told
                                        to propose rather than act, and each
                                        ${PROPOSAL_FENCE} block it writes is
                                        filed as a proposal (filed by the
                                        agent); one already refused is not
                                        filed again.
                                        --model is one backend's model, never
                                        the whole chain's (D-142). With one
                                        --backend it is that backend's, and a
                                        vendor CLI is handed it on its own
                                        model flag. In a chain of several a
                                        bare name is ollama's, as before, and
                                        claude=opus,ollama=qwen3:8b gives each
                                        named step its own; the rest run their
                                        own default. A backend that takes none
                                        (claude-local, grok-local) or a name
                                        that is not a model's (a leading -,
                                        a space, a quote) is refused, exit 2,
                                        before anything is sent. The ledger
                                        and --json name the model the CLI said
                                        it ran (claude's and grok's output
                                        do), and what was asked apart, as
                                        model_requested: an alias like opus is
                                        never priced as a model.
  mind ledger show --subject <id> [--since <iso>] [--until <iso>]
                     [--content] [--json]
                                        What this subject's turns were, when,
                                        and which backend received them.
                                        Metadata only unless --content.
  mind ledger forget --subject <id> (--id <id> | --before <iso> | --all)
                       [--yes]
                                        Withdraw ledger lines. Prints what
                                        would go, who already received it, and
                                        what deletion cannot reach; writes
                                        nothing unless you pass --yes.
  mind observe status --subject <id>  Where this subject's raw capture lives,
                                        whether capture is on, how much of it
                                        there is, and what a purge cannot
                                        reach. Writes nothing and creates
                                        nothing.
  mind observe enable --subject <id> [--scope capture|seed]
                                        Turn capture on. Prints exactly what is
                                        kept and what is not, then waits for
                                        the phrase \`capture <id>\` at a
                                        terminal. There is deliberately no
                                        --yes. Nothing is written if you say no.
  mind observe disable --subject <id> Withdraw consent and stop recording.
                                        Deletes nothing.
  mind observe hook --print --subject <id>
                                        Print the settings snippet that would
                                        connect the capture hook. Mind never
                                        writes another program's config; the
                                        snippet is yours to use or not.
  mind observe capture --subject <id> [--from claude-hook]
                                        Read one hook event from stdin and
                                        record it. Prints nothing on stdout and
                                        always exits 0 — it is running inside
                                        your session and will not interfere
                                        with it.
  mind observe seed --subject <id> --vendor claude|grok --root <dir> [--again]
                                        Import the history that is already on
                                        disk, once. Needs its own consent, and
                                        refuses a second run without --again,
                                        which prints why repeating it is a
                                        backfill.
  mind observe actions --subject <id> [--write <agent-dir>] [--json]
                                        What was done, as counts per month over
                                        closed lists of words: kind, outcome,
                                        origin, vendor, and tool or program
                                        names only from a built-in list. Reads
                                        and prints; \`--write\` puts
                                        ${SUMMARY_PATH} in that
                                        repository and says first what a commit
                                        cannot undo. Never stages, never commits.
  mind observe audit --vendor claude|grok --root <dir>
                                        Show what Mind derived beside the
                                        transcript line it came from, twenty
                                        files at random, and take y/n per field.
                                        This is S3.2 AC4's instrument: it needs a
                                        terminal, has no --yes, and stores
                                        nothing.
  mind observe patterns --subject <id> [--limit <n>]
                                        Routines and sequences in what you set
                                        going, with the evidence for each, and
                                        triggers.md snippets for timed ones.
                                        Recomputed each run; nothing is kept.
  mind observe interests --subject <id> --root <dir> [--half-life <days>] [--limit <n>]
                                        Your projects ranked by how much and how
                                        recently you worked in them. Counts only;
                                        nothing is kept.
  mind observe leaks --subject <id> --fleet-dir <dir> [--fleet-dir <dir>...]
                                        Count records in the subject that ran in
                                        a directory a fleet launcher uses — a
                                        launcher that forgot MIND_FLEET.
                                        Counts under the names you give, prints
                                        no other path, exits 1 if any is above 0.
  mind observe purge --subject <id> [--dry-run]
                                        Delete every byte of it, then count the
                                        directory again and print what is left.
                                        Exit 1 if that count is not zero.
  mind memory index <agent-dir> --subject <id>
                                        Build recall from memory/ in the agent
                                        repository: a full-text index in
                                        .mind/index/ (always) and the subject's
                                        own Qdrant collection (when bge-m3 and
                                        Qdrant answer on loopback). Says first
                                        what dropping the collection cannot
                                        reach.
  mind memory ingest <agent-dir> --from <dir> [--name <name>] [--yes]
                                        Copy the top-level .md files of <dir>
                                        into memory/imported/<name>/, after the
                                        repo guard's scanner: a file it flags is
                                        not copied, and is named without what
                                        matched. A mirror — files gone from
                                        <dir> go here too. Plan only without
                                        --yes; never stages or commits.
  mind memory forget <agent-dir> --subject <id> (--file <memory/…> | --match <text>) [--yes]
                                        Forget whole files under memory/: they
                                        go, the subject's collection is dropped
                                        whole and rebuilt from what is left,
                                        and the needle is looked for again.
                                        Refuses before removing anything if the
                                        store it wrote to cannot be reached.
  mind memory write <agent-dir> --subject <id> --file <memory/…md> --from <file> [--yes]
                                        Create or replace one memory file — what
                                        the web editor saves. Needs a basis for
                                        memory; the credential scan applies;
                                        --yes writes and rebuilds both indexes.
  mind memory import <agent-dir> --subject <id> (--from <file> | --url <link>) [--name <file name>] [--as <memory/…md>] [--yes]
                                        A document or a web page into memory as
                                        markdown: md, txt, html, pdf, docx, and
                                        what LibreOffice opens. Shows where it
                                        goes; --yes writes it (long ones in
                                        parts) through the same gates as write.
  mind memory move <agent-dir> --subject <id> --file <memory/…md> (--to <memory/…md> | --to knowledge | --to memory) [--yes]
                                        Move a memory — between the person's
                                        memory and knowledge/ (D-090), or to any
                                        path. Same gates as write; one rebuild.
  mind memory distill <agent-dir> --subject <id> [--from <memory/…>,…] [--model <m>] [--max-chunks <n>]
  mind memory distill show --subject <id> [--json]
  mind memory distill decide <fact-id> --subject <id> (--yes | --no)
  mind memory distill adopt <agent-dir> --subject <id> [--yes]
                                        Facts drawn out of memory by a local
                                        model (default: memory/knowledge/), each
                                        quoting its note or cut; only yeses are
                                        written, to memory/knowledge/facts/.
  mind memory who <agent-dir> <port|service|host|env name|path…>
                                        Which memories mention it, and on which
                                        line — "what uses port 10410" (D-092).
  mind memory search <agent-dir> --subject <id> [--limit <n>] [--scope all|memory|knowledge] <query...>
                                        Ask both indexes and merge the answers;
                                        every hit says which index found it.
                                        Exit 1: no hit. Exit 3: nothing was
                                        searched (no index yet, and no vector
                                        store answered).
  mind memory ask <agent-dir> --subject <id> [--scope all|memory|knowledge] [--backend a,b,c] [--route auto|local|cloud] [--model <m>] [--private] [--json] [--] <question...>
                                        Ask memory a question (D-152): the agent
                                        answers in a few sentences from what
                                        recall finds, in the question's
                                        language, then lists the sources (file
                                        and section) it was handed — never the
                                        files pasted back. No tools at all, at
                                        any dial level, and no proposal: only
                                        claude, claude-local and ollama answer
                                        (grok keeps read tools; file-channel
                                        vendors cannot be handed the pieces).
                                        Routed, screened and recorded in the
                                        ledger as a turn is. Nothing about the
                                        question recalled: "nothing in memory
                                        about this", no model asked. After --,
                                        the question is words, never a flag
                                        (memory ask only). Each ask's recall
                                        numbers, no text, go to <personal
                                        dir>/ask/recall.jsonl. Exit 2: empty or
                                        over 2000 characters. Exit 3: nothing
                                        searched.
  mind egress needles --subject <id>
                                        Where the list of what must not leave
                                        this machine lives (personal, outside
                                        git), and how many it holds.
  mind egress check --subject <id> <text...>
                                        Screen a text the way a turn does: the
                                        needles, then shapes that supplement
                                        them: e-mail, phones, IBANs, IDs, cards,
                                        passports, secrets. Exit 1 if kept in.
  mind egress log --subject <id>     What was kept in, when, going where,
                                        by which rule — never the text.
  mind erase <subject> (--agent <dir> | --no-agent) --by <text>
               [--personal] [--needle <text>]... [--remote <target.json>]
               [--out <file>] [--json] [--yes]
                                        Remove one subject from every place
                                        Mind has a deleter for, count what is
                                        left from disk, search for the
                                        identifier afterwards, and print a
                                        certificate. Writes nothing without
                                        --yes. Exit 1 when anything is left, or
                                        when a place has data Mind cannot
                                        delete. Exit 3 for \`nothing-found\`:
                                        nothing of this subject was here, so
                                        nothing was erased and the document is
                                        not a certificate of erasure. Mind
                                        cannot tell that from "an earlier run
                                        erased it", and says so. With --json,
                                        stdout is the certificate and nothing
                                        else; the plan, the five places and what
                                        is not searched all go to stderr, so
                                        \`erase … --json | jq\` reads a document
                                        and \`2>&1 | jq\` does not. Keep the two
                                        streams apart. --remote <target.json>
                                        (the file \`deploy plan\` reads) also
                                        prints where the remote half would look;
                                        with --yes it erases the remote first,
                                        asks it again, and only then erases here;
                                        it needs a connected ssh, which is not
                                        built yet, so --yes refuses for now.
  mind deploy plan <agent-dir> --subject <id> --target <file> [--json]
                                        What deploying this agent to the machine
                                        in <file> (ssh, gcp or aws; JSON, no
                                        secrets in it) would do, before anything
                                        is done: what goes where on the
                                        encrypted volume, what is made there,
                                        what stays here, D-100's four conditions
                                        for that provider, and every command it
                                        would run. Reads sizes from disk; runs
                                        nothing, writes nothing, sends nothing.
                                        Exit 1 when apply would refuse.
  mind guard install [<dir>]         Write the pre-commit and pre-push hooks
                                        into <dir>. \`new\` already did this for
                                        the repository it made; a fresh clone
                                        needs it, because git does not clone
                                        .git/hooks.
  mind guard scan --staged [<dir>]   Scan what is staged in <dir> and exit 1
                                        on a finding. This is what the
                                        pre-commit hook runs.
  mind guard status [<dir>]          Are the hooks there, how many commits
                                        already exist, which remotes are
                                        configured — and everything this guard
                                        does not cover. Exit 1 if a hook is
                                        missing.
  mind autonomy show [<dir> --subject <id>]
                                        What a turn of this agent may do, per
                                        category, with every number that was set
                                        beside the number in force. **Read the
                                        direction carefully: level 1 is the
                                        default and is what Mind has always
                                        done — every vendor's read-only flag on
                                        every turn. 2 and 3 are what take that
                                        flag off.** Without a directory it shows
                                        the machine's half only: the brake and
                                        the ceiling. MIND_LANG=th adds the Thai.
  mind autonomy set <read|write|run|reach|operate> <0-3> <dir> --subject <id>
                                        Write one category into <dir>/${AUTONOMY_FILE}.
                                        operate is the browser (D-153): it runs
                                        at min(operate, reach), starts at 0, and
                                        at every level stops for a yes before
                                        paying, sending, deleting, credentials
                                        or accepting terms.
                                        Level 3 has to be typed at a terminal
                                        and there is no --yes; who set it and
                                        when are recorded in the file. Says at
                                        the moment of setting what the number
                                        will actually do — including when the
                                        minimum makes it do nothing, and which
                                        backends will be refused rather than run.
  mind autonomy resume               Take the brake off. Asks for a phrase at
                                        a terminal; \`rm\` works too and Mind
                                        says so.
  mind proposal new <dir> --subject <id>
                      (--what <text> --why <text> --impact <text> | --from <path|->)
                      [--changed <text>]
                                        File what would be done, why, and what it
                                        affects. Refused with exit 5 if this
                                        subject has already been refused the same
                                        \`what\`, or has one pending — unless
                                        --changed says what is new, which is
                                        recorded against the old proposal. The
                                        new id is the whole of stdout; everything
                                        for a person is on stderr. --from reads
                                        the three fields as JSON from a file or
                                        from standard input, which keeps them out
                                        of shell history and \`ps\` the way
                                        --prompt-file does.
  mind proposal new <dir> --subject <id> --refile <proposal-id>
                                        File a spent approval again, from its own
                                        record, when the turn that spent it sent
                                        nothing (D-144). A new proposal that waits
                                        for a new yes; once per approval, and
                                        refused (4) for one a turn ran or may
                                        have run. Also files again an approval
                                        no turn will run (D-153): given before
                                        approvals named their action, or whose
                                        record changed after the yes.
  mind proposal decide <proposal-id> <dir> --subject <id> (--approve | --refuse)
                         [--note <text>]
                                        Answer one, recording who and when. A
                                        decision is written once and never edited
                                        in place. An approval is good for exactly
                                        one turn.
  mind proposal list <dir> --subject <id> [--json]
                                        Every proposal for this subject, newest
                                        first, with where they are kept.
  mind proposal show <proposal-id> <dir> --subject <id>
                                        One proposal in full, for a person about
                                        to decide it: the key it is compared by,
                                        whether its approval has been spent, and
                                        this subject's refusals. There is no
                                        --json — \`proposal list --json\` already
                                        holds every record, and two JSON shapes
                                        for one record is one too many.
  mind proposal triage (<proposal-id> | --pending) <dir> --subject <id>
                                        Ask TypeSafe's Jev what kind of action a
                                        proposal is, whether it can be undone
                                        and whether it touches private data.
                                        Opt-in, advisory, approves nothing; the
                                        text is screened first. Needs
                                        TYPESAFE_API_KEY. MIND_TRIAGE=jev does
                                        it on every filing.
  mind stop [<dir> --subject <id>]   Stop everything, in a fixed order: set
                                        the brake, take every category to 0, end
                                        the turns that are running, docker kill
                                        every browser task, ask every task to
                                        stop. Prints what it could
                                        not reach and the exact command for
                                        each. Exit 1 if anything survived.
  mind browser up --subject <id> --allow <origin> [--allow <origin>…] [--operate 1|2] [--task <id>] [--ttl <s>] [--no-build] [--json]
                                        Internal (E17, not reachable from turns
                                        yet). One task's browser: a fresh
                                        container with headless Chromium and
                                        Playwright MCP on a 127.0.0.1 port
                                        (30730-30749) behind a per-task token
                                        that is never printed, egress only to the named
                                        origins (scheme://host[:port], no paths,
                                        no wildcards), a trace and screenshots
                                        in the subject's personal directory,
                                        ended by down, stop or its deadline
                                        (--ttl, default 1800 s). Builds the image
                                        here when missing; never pushes it.
                                        --operate (default 1) is the most its
                                        guard serves: 1 look tools, 2 also act.
                                        Refused while the brake is on.
  mind browser down <task> [--json]  docker kill that task's container. The
                                        recording stays until erase.
  mind browser status [--json]       The running tasks, after ending any
                                        whose owner is gone or that nothing
                                        names.
  mind browser mcp-config <task> --vendor <id> [--level 1|2] [--json]
                                        Write the one-server MCP config a vendor
                                        CLI is handed for that task (mode 600: it
                                        holds the token), or say why the vendor
                                        gets none (only claude and claude-local
                                        are wired; exit 1 otherwise). --level is
                                        operate's: 1 approves look tools only, 2
                                        also click and type; code-running tools
                                        never, and sensitive actions are held.
  mind task new <dir> --subject <id> --goal <text> [--backend a,b] [--model <m>] [--budget-turns <n>] [--budget-minutes <n>] [--budget-tokens <n>] [--operate 0|1|2] [--allow <origin>…] [--step-minutes <n>] [--approve-within <minutes>] [--backend-wait-minutes <n>] [--detach] [--json]
                                        A goal carried over several turns
                                        (D-154): a plan, then one step per turn,
                                        each an ordinary turn (ledger, dial,
                                        fence, egress, stop all apply), until it
                                        is done, the budget is spent (default
                                        12 turns, 30 active minutes, no token
                                        limit) or it is stopped. --operate 1|2
                                        gives it a browser on --allow's origins
                                        (claude or claude-local only, D-157),
                                        never above the dial, and each step has
                                        the browser and no shell; at 2, a sensitive
                                        action pauses the task until you answer
                                        (--approve-within, default 10 minutes;
                                        no answer is a no). The goal, plan and
                                        steps stay in the personal directory.
                                        Foreground prints each step on stderr
                                        and the result on stdout; --detach runs
                                        it in the background, in a systemd user
                                        unit of its own (mind-task-<id>) when
                                        there is one, so restarting whatever
                                        started it (mind web) does not end
                                        it (S18.1; MIND_NO_SYSTEMD=1: never).
                                        A task on local CLIs alone waits while
                                        the local model is asleep or down
                                        ("waiting-backend": no turn, no minute
                                        counts) and is parked after
                                        --backend-wait-minutes (default 30;
                                        S18.2). Exit 0 done, 1 failed, 3 out of
                                        budget, 4 stopped or refused, 5 already
                                        running, 6 parked, 75 left for resume
                                        (its unit was stopped with no stop
                                        asked). For a task to outlive the login
                                        and start after a reboot, the owner
                                        enables lingering once: loginctl
                                        enable-linger <user>.
  mind task list <dir> --subject <id> [--json]
                                        Every task of this agent, newest first.
  mind task show <task> <dir> --subject <id> [--json]
                                        Its goal, status, budget used, plan and
                                        every step with the id of its turn.
                                        "interrupted" means its runner died;
                                        "parked", that it was set aside (its
                                        backend was not ready in time).
  mind task stop <task> <dir> --subject <id> [--json]
                                        Stop it: no next step starts, the step
                                        running now is ended like mind stop
                                        ends a turn, its browser is killed.
  mind task resume <task> <dir> --subject <id> [--detach] [--json]
                                        Carry an interrupted or parked task on
                                        from the step it was on (an interrupted
                                        step counts as a turn spent; its
                                        browser starts fresh).
  mind task approve <task> <approval> <dir> --subject <id> [--json]
                                        D-156: let one sensitive browser action
                                        a task's container is holding (paying,
                                        sending, deleting, a credential, terms)
                                        happen, once — that action and no other.
                                        "task show" lists them. Answered once:
                                        a second answer is refused (exit 5); no
                                        answer by its deadline is a no. Only at
                                        a terminal (exit 4 otherwise) or with
                                        Yes / No on the web page. A password or
                                        credential is never approvable yet
                                        (D-160). A page's confirm is its own
                                        question, shown with its click (D-159).
  mind task deny <task> <approval> <dir> --subject <id> [--stop] [--json]
                                        It does not happen, and the task is told
                                        so; --stop also stops the task.
  mind task run <task> <dir> --subject <id> [--detached]
                                        The runner itself — what new --detach
                                        and resume --detach start. --detached
                                        writes its lines to the task's
                                        runner.log instead of stderr.
  mind triggers show <dir> --subject <id>
                                        The schedules in triggers.md, when each
                                        last fired and when it is next due.
  mind triggers tick <dir> --subject <id> [--backend a,b] [--model <m>]
                                        Run what is due, each as a turn held at
                                        level 1 — it proposes, never acts — then
                                        exit. Nothing runs under the brake.
  mind triggers schedule <dir> --subject <id> [--every <5m>]
                                        Print a systemd timer and a cron line
                                        that call tick. Installs nothing.
  mind web <dir> --subject <id> [--port <n>] [--host <addr>] [--name <host,…>] [--https] [--key-file <path>] [--qr]
             [--backend a,b] [--model <m> | --model <backend>=<m>,…]
                                        A page for one agent in your browser:
                                        what it may do, what waits for your
                                        yes or no, a chat, and the brake. Every
                                        button runs a command; level 3, consent,
                                        releasing the brake and erase stay in
                                        the terminal. Loopback, with a link key.
                                        --qr prints the link as a code for the
                                        phone app (it holds the key).
                                        On a tailnet address it also answers to
                                        this machine's tailnet names; --name
                                        adds others. --https: behind
                                        tailscale serve, on loopback.
                                        --key-file keeps the link across
                                        restarts (made once, 600). Off a
                                        terminal (a service, a pipe) the key
                                        is not printed, nor a --qr code.
                                        --backend and --model are what a chat
                                        message uses until the page picks
                                        others; --model is read as turn reads
                                        it. The page offers each backend the
                                        names its CLI documents and the price
                                        table lists, and shows a model a CLI
                                        was only asked for as "asked for".
  mind a2a peers --subject <id>        Who this agent may talk to, both ways.
  mind a2a allow <name> --endpoint <url> --subject <id> [--send-token-file <path>]
                                        Allow a peer: typed at a terminal, never
                                        by a flag. Prints the token it sends with.
  mind a2a remove <name> --subject <id>
                                        Take a peer away.
  mind a2a serve <dir> --subject <id> [--port <n>] [--host <addr>]
                                        Listen for allowed peers (loopback) and
                                        serve the agent card, with the agent's
                                        public key if \`mind key\` made one.
                                        What arrives goes to the ledger and the
                                        inbox; none is run.
  mind a2a send <dir> --subject <id> --to <name> --text <message>
                                        Send one message to a peer, screened
                                        like a turn; kept in means not sent.
  mind a2a inbox --subject <id>      What peers have sent.
  mind key <agent-dir> --subject <id>
                                        The agent's own ed25519 signing key
                                        (D-108): made the first time, the same
                                        public key shown every time after, never
                                        replaced. The private key stays in a 600
                                        file in a 700 directory under the data
                                        root, outside git, and is never printed;
                                        the public key goes on the agent card.
                                        A full erase removes it; erase
                                        --personal keeps it, as it keeps role.md.
  mind key prove <agent-dir> --subject <id> --market <origin> --listing <slug> --nonce <nonce> [--json]
                                        Prove to a market that this agent holds
                                        its key (D-141): signs the market's
                                        challenge — {market, listing, nonce,
                                        at} — with it, for the market to
                                        register the public key. --market is
                                        an origin, https://host[:port] (http
                                        only to 127.0.0.1 or localhost), as a
                                        browser writes it: no path, no
                                        trailing /, lower case, punycode.
                                        --nonce is the 43-character challenge
                                        (--nonce=<nonce> if it begins with --).
                                        Anything else is refused, exit 2.
                                        Use only a nonce from your OWN
                                        listing's key page: a proof signed
                                        for someone else's listing puts your
                                        key on it.
                                        --json prints the proof alone, on one
                                        line. Needs \`mind key\` first;
                                        makes no key.
  mind key verify-proof <file|-> --key <public-key> --market <origin> --listing <slug> --nonce <nonce>
                                        Check a proof as the market does. Exit
                                        0 only when it is signed by exactly
                                        --key's key and names exactly that
                                        market, listing and nonce; 1 when it
                                        is not; 2 for a command line it will
                                        not run. Whether the nonce is still
                                        unused is the market's to know.
  mind usage report <agent-dir> --subject <id> [--since <iso>] [--until <iso>] [--market <origin> --listing <slug> [--job <id>]] [--json]
                                        What the agent's turns used and cost,
                                        signed with its key (D-106, D-110): one
                                        row per model delivery in the ledger —
                                        ids, time, backend, model, input, output
                                        and cache read/write tokens, and the
                                        cost in whole US micro-dollars with the
                                        rates and price table it came from.
                                        Never a prompt, an answer, memory or the
                                        subject id. A count the ledger does not
                                        have is null, not 0; a turn with a count
                                        or a price missing is not charged, and
                                        says why. --market and --listing
                                        (both, or neither) bind it to one
                                        listing on one market, and --job to
                                        a job there (D-141): signed, so it
                                        counts at that listing and nowhere
                                        else. Without them it is bound to no
                                        market, and no market takes it.
                                        --json prints the signed report alone,
                                        on one line. Needs \`mind key\`
                                        first; makes no key.
  mind usage verify <file|-> [--key <public-key>] [--market <origin> --listing <slug>]
                                        Check a signed report against the key
                                        on the agent card. Exit 0: a well-formed
                                        usage report signed by exactly --key's
                                        key. 1: not valid — changed, another
                                        key, a weak key, a duplicate field, a
                                        number not in plain integer digits
                                        (1.0, 1e3, -0), a string with control
                                        characters. 2: a command line it will
                                        not run. 3: signed by the key inside
                                        it, but no --key was given, so whose
                                        key it is is unknown.
                                        A cost that does not follow from its
                                        own row's counts and rates is not valid,
                                        and nor is one that claims a shipped
                                        table at rates that table does not have.
                                        Costs are shown grouped by the price
                                        each row claims; rates the owner set,
                                        or a shipped table this build does not
                                        carry, are said to be not checked, and
                                        the total is split the same way. With
                                        --market and --listing, a report bound
                                        anywhere else, or to nothing, is not
                                        valid; without them its binding is
                                        shown and said to be not checked.
                                        Takes no other option.
  mind usage prices [--json]         The prices a turn is charged at now, per
                                        million tokens (D-139): the dated table
                                        shipped with Mind, and yours in
                                        $XDG_STATE_HOME/mind/prices.json — the
                                        only place a model on this machine gets
                                        a price. Yours replaces a shipped entry
                                        for the same backend and model. A model
                                        in neither has no price, never 0. Exit 1
                                        when yours cannot be used: until it is
                                        fixed, nothing is charged.
  mind persona extract <dir> --subject <id> --from <path,…> [--model <m>] [--max-chunks <n>]
                                        Draft a soul from real artifacts with a
                                        model on this machine. Every claim must
                                        quote its source; one whose quote is not
                                        there is cut. Kept in personal/.
  mind persona review <dir> --subject <id> [--draft <id>]
                                        Answer yes or no to each claim, at a
                                        terminal.
  mind persona show --subject <id> [--draft <id>] [--json]
                                        The draft and what was decided.
  mind persona decide <claim-id> --subject <id> (--yes | --no) [--draft <id>]
                                        One answer — what the web page's review
                                        sends.
  mind persona adopt <dir> --subject <id> [--draft <id>] [--yes]
                                        Write only the yeses into role.md and
                                        person.md; the soul must still load.
  mind eval <dir> --subject <id> [--set <file>] [--only <id,…>] [--backend <b>] [--model <m>] [--json]
                                        Run the job's task set (evals.md, at
                                        least 20 real tasks) with the soul alone
                                        and with recall, grade each answer by
                                        its phrases, and say which kinds of work
                                        it cannot do yet. Turns held at level 1.
  mind basis record <owner|consent|contract|legitimate-interest|legal-obligation> --subject <id> --uses <memory,persona,fine-tune> [--expires YYYY-MM-DD|never] [--approved-by <name>] [--note <text>]
                                        Record on what basis a subject's data
                                        may come in, and for which uses — typed
                                        at a terminal. memory ingest and persona
                                        extract read nothing without one (S7.3).
  mind basis show --subject <id>      The records, active, expired or revoked.
  mind basis revoke <record-id> --subject <id>
                                        Stop what comes in next on it.
  mind chat users --subject <id>       Who the agent answers in chat apps.
  mind chat allow <platform> <user-id> --subject <id> [--label <name>]
                                        Let one person be answered: typed at a
                                        terminal, never by a flag.
  mind chat remove <platform> <user-id> --subject <id>
                                        Stop answering them.
  mind chat serve <dir> --subject <id> --token-file <path> [--platform telegram] [--once]
             [--backend <b>] [--model <m> | --model <backend>=<m>,…]
                                        Answer allowed people on Telegram. Each
                                        answer is a level-1 turn, screened by the
                                        filter and the local judge; it says it is
                                        an AI first; anyone else gets nothing.
                                        --backend and --model go to each turn,
                                        read as turn reads them.
  mind update [--check] [--yes]       Is there a newer release? --check only
                                        asks; without --yes it says what it would
                                        replace; --yes installs this machine's
                                        build after checking its SHA256SUMS.
                                        Once a day, at a terminal, commands also
                                        check by themselves and say so in one
                                        line (MIND_NO_UPDATE_CHECK=1 stops it).
  mind help                          This message

A soul is two files — ${ROLE_FILE} (role knowledge) and ${PERSON_FILE} (personal
traits) — so that one can be deleted without the other.

\`--as <dir>\` goes before the command and fills in \`<dir> --subject <id>\` for
\`soul check\`, \`soul apply\`, \`soul verify\`, \`turn\` and \`worn\`. It takes the
directory of a soul or of an agent, never a name: Mind keeps no registry of
agents, and the subject is read out of ${ROLE_FILE} and checked against
${PERSON_FILE} rather than taken from the directory. \`--as\` together with
\`--subject\`, or with a directory argument, is refused — two answers to one
question is how the wrong identity gets applied.

Mind wears an identity; it does not have one (D-011). Nothing stores which one
is on, so \`worn\` derives it from the markers in the files themselves and is
right about a file something else edited a second ago. Two subjects with blocks
on the same machine is reported as a switch that did not finish, not as an
average.

An agent is a git repository. Everything git holds there is Markdown a human can
read with Mind uninstalled; everything under ${DERIVED_DIR}/ is derived, and deleting
it is always safe (I-2). Data flagged personal belongs in neither — it lives
outside the repository entirely (D-014). Mind never commits and never pushes.

That last sentence is a claim about Mind's own code, and it is the only shape
of it that can be proven: \`git\` is reachable from here through one allowlist of
local verbs, and no path in this program reaches a remote. It is *not* a claim
that a push cannot happen on this machine. A vendor CLI Mind spawns for a turn
has its own shell tool and can push from inside its own process; \`--no-verify\`
skips the hooks; and a clone arrives with no hooks at all. \`mind guard status\`
prints the full list rather than letting the short sentence stand alone.

\`soul apply\` writes into a delimited block and never touches a byte outside it.
Originals are copied under \$XDG_STATE_HOME/mind/backups/ before every write,
and the command to restore each one is printed. Backends: ${PHASE_A_BACKENDS.join(", ")}.
Text written into a cloud CLI's instruction file is uploaded on every turn it takes.

\`soul verify\` spends a real turn on every backend it measures, three questions
at a time, ${DEFAULT_RUNS} times over. It reports four levels — ${Object.keys(LEVEL_LEGEND).join(" / ")} —
and never collapses them into pass/fail.

\`turn\` prints the answer on stdout and the route it took on stderr, so a pipe
gets the answer and a human gets to see which backend was reached. With
\`--route auto\` (the default), an acting turn with recalled pieces held from cloud
puts the fenced local CLI chain first when it is ready; otherwise the usual chain
is ${PHASE_A_BACKENDS.join(" → ")}. \`--route local\` and \`--route cloud\` steer that
choice, while an explicit \`--backend\` chain wins. A backend that exits 0 having
printed nothing counts as a miss, not an answer.

\`--prompt <text>\` puts the prompt on this process's command line, where shell
history, \`ps\` and terminal scrollback can all see it — and \`ledger forget\`
cannot reach any of them. \`--prompt-file <path>\` reads it from a file instead,
and \`--prompt-file -\` from standard input, which is the safer of the two ways
to ask something you would not want kept.

The ledger lives under \$XDG_STATE_HOME/mind/ledger/<subject>/, one JSONL file
per month, readable with \`jq\` and deletable with \`rm\`. One line is written for
each backend that was really handed the prompt, so a chain that fell through
writes more than one. Nothing Mind does reads it back into a prompt, and
deleting the whole tree changes no agent's behaviour. \`--private\` records the
turn without its text — no prompt, no answer, and no hash of either, because a
short prompt is guessable from its hash.

Each line records what the turn used in **tokens the backend itself printed** —
never money. A vendor's own price is an API list price a subscription holder
does not pay, and a local model's would be 0, which claims electricity is free.
\`unreported\` means Mind has not surveyed that backend; \`missing\` means one
that usually prints a count did not, which is how a vendor changing its output
shape looks from here.

Raw observer capture lives under \$XDG_DATA_HOME/mind/<subject>/personal/observer/,
and nowhere else (D-025). It is personal by default: it records what the owner did,
nothing can rebuild it, so \`.mind/\` — which a rebuild sweeps — would lose it and
git — which remembers what it is asked to forget — must not have it. Nothing
reachable from that code can open a socket or start a process, which is a claim
about Mind's own code and not about this machine: a vendor CLI running as you
can read those files and has tools of its own. \`observe purge\` counts the
directory again after deleting and exits 1 if anything is left.

What may enter git out of that capture is one thing only: **integers, keyed by
words Mind holds in its own source** — the month, the kind, the outcome, the
origin, the vendor, and tool or program names from a built-in list. A path, a
project directory, a session id, an instant, or the name of an MCP server never
does, and that is by construction rather than by filtering: the keys are built
from those lists and looked up, so no string out of a record can become one.
Anything not on a list is counted as \`other\`. The reason is that what enters git
cannot be taken back out, so what enters git must not identify anybody in the
first place. Per-action rows stay in the personal store, where \`observe purge\`
and \`erase\` can delete them.

\`erase\` is AC1's five places and two statuses. soul, observer data, the RAG
collection and the ledger have deleters here; a LoRA adapter (S6.3) does not
exist in this program at all, and the output says "4 of 4 places that exist
were visited · 1 of 5 are not built" rather than a 5 nobody checked. If anything
turns up at the address D-014 reserves for the adapter, erase exits 1 and
issues no certificate: it will not certify a deletion over a directory nothing
in this repository claims. The RAG collection is dropped whole on a loopback
Qdrant; if Mind wrote one and cannot reach the store, erase refuses too.

An identity lives in three places, not one — the repository, Mind's block
inside every vendor instruction file \`soul apply\` wrote to, and the backups
taken before those writes, which contain the blocks written by earlier runs.
All three go. What is *searched* afterwards is the whole state root, the whole
data root, those instruction files and the agent's working tree minus .git;
what is not searched is printed every run, vendor transcripts and git objects
first. That search is coarse for text without word boundaries and says so.

\`doctor\` answers "is this machine ready?" and nothing wider. It never spends a
turn: the CLIs are checked with \`--version\`, which is also how it reports
**drift** — a vendor whose installed release is not the one \`src/exec/registry.ts\`
was measured against, because those differences move between releases and the
failures they cause are silent. Its "which identity is on" half is \`worn\`, called
rather than re-answered. Exit 1 is the local route only: a missing commercial CLI
is a machine with fewer hands, not a broken one (I-1).

The autonomy dial (\`${AUTONOMY_FILE}\`, beside the soul, in git) points the opposite
way to its name. Every vendor's read-only flag (kimi's since S12.6) has gone onto
every turn Mind starts since before the dial, so **level 1 — the default in every
category — is what Mind has always done**, and levels 2 and 3 are the new
thing: at 2 that flag is not sent, and the turn may write files and run commands.
A turn runs at \`min(write, run, reach)\`, never the maximum, so raising one
category alone changes nothing — which \`autonomy set\` tells you as you set it
rather than letting you find out later. \`reach\` cannot be set to 3 at all (I-6).
\`${AUTONOMY_MAX_ENV}\` is a ceiling and never a floor: nothing anywhere in Mind
raises a level, because a variable that could would be one an agent running as
you could export for itself.

At level 1 a turn that lands on a vendor with no read-only mechanism is
**refused**, not run and hoped over. None is left since kimi got a profile file,
and \`mind backends\` names one the day a vendor declares it; running there
means raising write, run and reach to 2 together, which somebody has to mean.

Proposals live in a store of their own, outside git and outside the ledger:
\$XDG_DATA_HOME/mind/<subject>/personal/proposals/, one JSON file each. Outside
git because what/why/impact are free text about what you do (D-014); outside the
ledger because a refusal has to be read back into the next decision and the
ledger is the one record nothing may read back (D-022, D-029). Deleting this
store is allowed to change something — the agent forgets it was told no, which is
the whole of what it is for, and \`rm\` on one file forgets one refusal.

"The same thing" is compared **exactly**: the text of \`what\`, normalised, with
whitespace collapsed and case ignored, and nothing else. Reword one sentence and
it is a new proposal to Mind. That is why every run of \`proposal new\`,
\`decide\` and \`show\` prints this subject's refusals in full, unfiltered — the
wider comparison is yours to make, and a program that guessed which ones were
similar enough to show you would be the loose comparison again, hidden.

Not built, and said rather than implied: Mind does not turn an agent's own
actions into proposals, and cannot at present — it borrows vendor CLIs (D-002)
and sees a turn's output and exit code, never the tool calls inside it. The
caller of \`proposal new\` is a person or the script driving \`turn\`.

The brake is a file: \`\$XDG_STATE_HOME/mind/${STOP_FILE}\`. Its contents are never read,
so \`touch\` sets it and \`rm\` clears it, and neither needs Mind to be working —
which is the point, because \`mind stop\` does. It is deliberately not in git: a
committed brake would travel to every clone and stop machines nobody stopped.
\`mind stop\` also ends running turns, and it will not signal a process it cannot
identify: a pid is reused, so a record whose process start time no longer matches
is reported and left alone, with the command printed for you to run once you have
looked. **Ctrl-C is not a substitute** — measured 2026-09-22, a child started as a
shell background job ignores SIGINT by POSIX default and survived a group SIGINT
that a group SIGTERM killed.

Not built yet (see .scrum/backlog.md):
  mind run <name>          Act on its own, on a trigger it chose  [S5.3]
  mind deploy apply        Do what the plan says, after a phrase typed at a terminal  [S13.2–S13.4]
  mind deploy status       What runs there                                             [S13.5]
  mind deploy update       A newer binary or agent onto it                             [S13.5]
  mind deploy destroy      The machine and its disk gone, and the provider asked again [S13.5]
`;
