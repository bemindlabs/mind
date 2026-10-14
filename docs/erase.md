# What `mind erase` removes

```sh
mind erase <subject> (--agent <dir> | --no-agent) --by <text> [--personal] [--needle <text>]... [--vectors-not-reached <collection>] [--yes]
```

Without `--yes` it is a dry run: it prints every place it would remove, how much is in each, what it will search
afterwards and what it will not, and writes nothing. With `--yes` it removes, reads the disk back, searches for the
subject again and issues a certificate whose verdict is one of four words:

| verdict | what it means |
|---|---|
| `dry-run` | nothing was written; this is what `--yes` would do |
| `nothing-found` | nothing of this subject was here, so nothing was erased. It is also what a mistyped id produces, and the certificate says to check the spelling |
| `erased-and-verified` | something was found, it went, and the subject id (and every `--needle`) is findable nowhere it must not be |
| `erased-with-remainder` | it went, and something is still there: a file that could not be deleted, a hit in a place Mind does not delete for you, a place nobody could read. The certificate names each one |

The verdict is never `erased-and-verified` while a file is left in a place that was to be emptied, while the certificate
lists a place as `not reached`, or while it lists notes as `yours to delete` (next section).

## Your own notes: `memory/imported/`

`mind memory ingest` copies your notes into `memory/imported/<name>/` in the agent's repository, where recall reads them.
**`erase` does not remove them.** They are files of your git repository, copied from files that are yours, and nothing in them
says which subject they belong to, so they are not on the data map and the search for the subject id does not look for
them. A run that left them in place and still said `erased-and-verified` would be claiming a place it never examined, so
instead:

- the dry run and the certificate **list every one of them by path** as `yours to delete`
  (`verification.yoursToDelete` in the JSON), and say that this document certifies nothing about them;
- while one is still there the verdict is `erased-with-remainder` (exit 1), after everything the data map names has gone.

Delete them yourself (`git rm -r memory/imported/<name>` for what git tracks), and keep in mind that `memory ingest` copies
them back for as long as the source folder still holds them. Run `erase` again to get a verdict without the remainder (it then
reads `nothing-found` unless something else is left; the first run's certificate is the evidence of the erasure). The rest
of `memory/` is yours in the same way and is not listed.

## The places

This list is the data map (`src/erase/map.ts`). `erase` removes what it names, and `mind deploy plan` moves what it
names, so the two cannot disagree about where a subject's data is.

| place | where | goes |
|---|---|---|
| the soul and the derived directory | the agent's repository: `soul/` and the derived `.mind/` (and the directory an earlier release derived into) | whole; the agent's git history is not rewritten, and the certificate says what git keeps |
| the apply backups, the level-3 confirmations, the run records, the browser task records, the trigger fire times, the vector-store marker | under the state root, one directory per subject | whole |
| the A2A peers, the chat allowlist, the bot approvals, the push handles, the basis records | under the state root, one directory per subject | whole |
| the personal directory | under the data root, one directory per subject: raw capture, proposals, tasks | whole |
| the agent's signing key | under the data root, beside the personal directory | whole; `--personal` keeps it |
| the turn ledger | under the state root | line by line, then the directory |
| the vector collection | Qdrant, by name | dropped whole, or not at all. `memory index` leaves the marker that says Mind wrote there only once the store has answered, so a machine with no Qdrant has none and `erase` goes on. With a marker and a store that does not answer, `erase` refuses; `--vectors-not-reached <collection>` (the exact name the refusal prints) goes on without it, and the certificate then lists `not reached: vector collection <name>` and is `erased-with-remainder`, never verified (D-187) |
| Mind's block in each vendor instruction file | `CLAUDE.md` and the like | the block only; a block edited by hand refuses the run |
| the local backends' homes | `<state root>/vendors/claude-local`, `<state root>/vendors/grok-local` | whole, when the subject is tied to the home (next section) |

## Local backends: `claude-local` and `grok-local`

A turn on a local backend runs the real vendor CLI with a home of Mind's own. Whatever the vendor writes while it
runs lands there: its session transcripts, its prompt history, its tool output, its scratch directory. A transcript
holds the text of the turn: the question, the identity that went with it and the answer. Those homes are inside the
state root, so the search afterwards reads them, and a hit there turns the verdict into `erased-with-remainder`.
`erase` also plans and removes them, so that it does not have to report a mess it could have cleaned.

**They cannot be erased per subject.** There is one home per backend, for every subject that ran a turn there. A
vendor CLI files its sessions by its own session ids and by the directory the turn ran in, not by who asked, and
`--private` only withholds the text from Mind's own ledger, not from the vendor's files. Nothing in the home says
whose text a file holds. So when `erase` removes a home it removes it **whole**, and says so: other subjects' transcripts in it go
with it. Nothing in Mind reads one back (each turn starts a fresh vendor session), and the next local turn makes the
home and its config again.

**When a subject is tied to a home.** A home goes only when one of two facts, both read from disk, ties this subject
to it:

- the subject's own ledger holds a line whose backend is that local backend: the subject ran a turn there; or
- a needle of the run (the subject id, the soul's name, any `--needle`) is inside it, in a file or in a name.

A home nothing ties to the subject is **left alone, and the plan and the certificate say so** (`NOT TOUCHED, AND NOT
CERTIFIED`). Removing a shared home for any id at all would make a mistyped id delete other subjects' transcripts and
then certify the typo. If this subject's text could be in a home anyway (its ledger was forgotten earlier, and the
text carries neither its id nor its name), run `erase` again with `--needle <a phrase from it>`: a hit ties the home
to the run, and it then goes whole.

`--personal` removes a tied home whole as well: a vendor transcript carries no personal flag, so it cannot be split
into personal and not, which is also why the whole ledger goes.

A home that is there and cannot be read refuses the whole run, with nothing deleted: Mind cannot say whether the
subject's transcripts are in it, and a certificate over a place nobody could look into would be false.

**What the dry run and the certificate print.** The dry run lists each home that goes as a line of the plan, with its
file count and byte count, and prints a note for every home that holds something: which it is (removed whole, or left
alone) and why. After the run, the certificate says that the home was removed whole and read back, or, if a file is
still there, `TRANSCRIPTS REMAIN` and the path of every file, under `verification`. The same paths are in the JSON
under `verification.where`.

## What it does not reach

The certificate prints this list on every run, the dry run included.

- The cloud CLIs' own transcripts (`~/.claude/projects/*.jsonl` and the like). Mind does not read them and does not
  delete them. A zero in the search says nothing about them.
- A local backend's home that nothing ties to the subject, as above.
- Shell history, the process list and terminal scrollback.
- Git history and every clone and remote of the agent's repository. Mind does not rewrite history.
- Any other service on the network, and any snapshot or backup another program took.
- Freed disk blocks. Mind does not run `shred`: on an SSD, a journal or a snapshotting filesystem it cannot keep
  that promise.
