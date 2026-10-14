/**
 * What a repository already holds, and what saying so is for (AC5).
 *
 * The facts are deliberately small — a commit count and a list of remote URLs —
 * because they are the two things that decide how much of `GIT_UNDELETABLE`
 * has already happened. No visibility check appears here and none should: only
 * the host knows whether a remote is private, Mind does not ask hosts
 * anything, and an unchecked "private" printed beside a URL would be the most
 * expensive sentence in this repository.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_UNDELETABLE, historyFacts, historySentence } from "../../src/guard/history.ts";
import { git } from "../support/trap-git.ts";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mind-history-"));
  scratch.push(parent);
  const path = join(parent, "agent");
  expect((await git(parent, ["init", "-q", path])).code).toBe(0);
  return path;
}

/** A repository with two commits and two remotes — a history worth hiding. */
async function repoWithHistory(): Promise<string> {
  const agent = await repo();
  await writeFile(join(agent, "a.md"), "a\n");
  await git(agent, ["add", "-A"]);
  await git(agent, ["commit", "-q", "-m", "first"]);
  await writeFile(join(agent, "a.md"), "b\n");
  await git(agent, ["add", "-A"]);
  await git(agent, ["commit", "-q", "-m", "second"]);
  await git(agent, ["remote", "add", "origin", "file:///tmp/origin.git"]);
  await git(agent, ["remote", "add", "backup", "file:///tmp/backup.git"]);
  return agent;
}

describe("the facts Mind can get without asking anybody", () => {
  test("an empty repository is zero commits and no remotes, not an error", async () => {
    const facts = await historyFacts(await repo());
    expect(facts.readable).toBe(true);
    if (!facts.readable) throw new Error("unreachable — asserted above");
    expect(facts.commits).toBe(0);
    expect(facts.remotes).toEqual([]);
  });

  test("commits are counted and every configured remote is named", async () => {
    const facts = await historyFacts(await repoWithHistory());
    expect(facts.readable).toBe(true);
    if (!facts.readable) throw new Error("unreachable — asserted above");
    expect(facts.commits).toBe(2);
    expect([...facts.remotes].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "backup", url: "file:///tmp/backup.git" },
      { name: "origin", url: "file:///tmp/origin.git" },
    ]);
  });
});

describe("the two ways there is no number, which are not the same way", () => {
  // odd2 H3. These used to be one answer — `commits: 0, remotes: []` — and it
  // was the same answer an empty repository gives. Three callers read this
  // function and printed that zero as a fact.

  test("a directory that is no repository says so, and carries no count", async () => {
    const plain = await mkdtemp(join(tmpdir(), "mind-history-plain-"));
    scratch.push(plain);

    const facts = await historyFacts(plain);
    expect(facts.readable).toBe(false);
    if (facts.readable) throw new Error("unreachable — asserted above");
    expect(facts.why).toBe("not-a-repository");
    expect(Object.keys(facts)).not.toContain("commits");
  });

  test("a real history git refuses to read is UNKNOWN, never zero", async () => {
    // The dangerous direction, and the one the odd2 probe had backwards. This
    // repository has two commits and two remotes; the only thing wrong with it
    // is that git cannot parse its config — which is also what `safe.directory`
    // looks like from in here when a checkout is owned by another uid, the
    // ordinary state inside a container or under `sudo`.
    //
    // Under the old shape this answered `commits: 0, remotes: []`, and the
    // erase certificate printed `git 0 commit(s) · no remote configured` over a
    // history that holds both. A document that claims *less* than the truth
    // about what git kept is what S0.4 AC5 exists to forbid.
    const agent = await repoWithHistory();
    await writeFile(join(agent, ".git", "config"), "[core\nthis is not a config file at all\n");

    const facts = await historyFacts(agent);
    expect(facts.readable).toBe(false);
    if (facts.readable) throw new Error("unreachable — asserted above");
    expect(facts.why).toBe("unreadable");
    // git's own words reach the reader, because "could not read it" without
    // saying why is a sentence nobody can act on.
    expect(facts.detail).toContain("config");

    const sentence = historySentence(facts);
    expect(sentence).toContain("UNKNOWN");
    expect(sentence).not.toContain("0 commit");
    expect(sentence.toLowerCase()).not.toContain("no remote is configured");
  });

  test("no sentence this function writes ever says `0 commit(s)`", async () => {
    // The wording rule, asked of every state at once rather than of each
    // caller: a zero on this line is the thing a reader quotes later.
    const plain = await mkdtemp(join(tmpdir(), "mind-history-plain2-"));
    scratch.push(plain);
    for (const dir of [plain, await repo(), await repoWithHistory()]) {
      expect(historySentence(await historyFacts(dir))).not.toContain("0 commit");
    }
  });
});

/**
 * The third way there is no number: there is no git on the machine at all.
 *
 * It needs a subprocess, and the reason is worth writing down because the
 * obvious cheaper version does not work. `Bun.spawn` resolves a bare command
 * against the PATH this process **started** with: mutating `process.env.PATH`
 * and calling `historyFacts` here finds git anyway (measured, bun 1.4.2,
 * 2026-09-22 — the spawn returned exit 0). Only a child started with an
 * explicit `env` is really without git, which is also the closest thing to the
 * machine this is about: the bare container the MVP-lite DoD is defined by,
 * where `git` is on the forbidden list on purpose.
 *
 * So the production function is run, unmodified and with no test-only seam, in
 * a process that genuinely cannot find git.
 */
async function factsWithoutGit(repo: string, path: string): Promise<string> {
  const source = join(import.meta.dir, "..", "..", "src", "guard", "history.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { historyFacts, historySentence } = await import(${JSON.stringify(source)});
       try {
         const facts = await historyFacts(${JSON.stringify(repo)});
         console.log(JSON.stringify({ ...facts, sentence: historySentence(facts) }));
       } catch (error) {
         console.log(JSON.stringify({ threw: String(error) }));
       }`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: path } },
  );
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  // A child that died has no JSON to parse, and "undefined is not an object"
  // three lines further down would hide the reason it died.
  expect(child.exitCode, `the child printed: ${out}\n${err}`).toBe(0);
  return out.trim();
}

describe("the third way, which is a fact about the machine and not the repository", () => {
  // dod1. `historyFacts` had an arm for "this is not a repository" and one for
  // "git would not read it", and none for "there is no git here to ask" — so
  // `mind erase --agent` in a container exited 1 with a stack trace out of a
  // spawn, having deleted nothing. I-4 is failed from that side too: a
  // withdrawal that crashes before it starts removes nothing at all.

  test("no git on PATH is an answer, not a throw, and never a zero", async () => {
    const agent = await repoWithHistory();
    const nowhere = join(agent, "..", "empty-path");
    await mkdir(nowhere, { recursive: true });

    const answer = JSON.parse(await factsWithoutGit(agent, nowhere));
    expect(answer.threw, "historyFacts threw instead of answering").toBeUndefined();
    expect(answer.readable).toBe(false);
    expect(answer.why).toBe("no-git");
    // The runtime's own words, so a reader is told what could not be started.
    expect(answer.detail).toContain("git");

    // This repository has two commits and two remotes. The sentence must not
    // let anybody read the absence of a number as a zero.
    expect(answer.sentence).toContain("UNKNOWN");
    expect(answer.sentence).not.toContain("0 commit");
    expect(answer.sentence.toLowerCase()).not.toContain("no remote is configured");
    // And it must not claim there is no repository either: nothing was asked,
    // so that is unknown too.
    expect(answer.sentence.toLowerCase()).not.toContain("no git repository here");
  }, 30_000);

  test("the control: the same harness with a real PATH counts the history", async () => {
    // Without this, a subprocess that failed for any reason at all — a bad
    // import path, a bun that would not start — would look exactly like proof
    // of the arm above.
    const agent = await repoWithHistory();
    const answer = JSON.parse(await factsWithoutGit(agent, process.env["PATH"] ?? ""));
    expect(answer.readable).toBe(true);
    expect(answer.commits).toBe(2);
    expect(answer.remotes).toHaveLength(2);
  }, 30_000);

  test("`no-git` and `unreadable` do not send the reader to the same place", () => {
    // They are both "could not look", and folding them into one arm would print
    // one instruction at somebody who needs the other.
    const missing = historySentence({
      readable: false,
      why: "no-git",
      detail: 'Executable not found in $PATH: "git"',
    });
    const refused = historySentence({
      readable: false,
      why: "unreadable",
      detail: "fatal: bad config line 1",
    });

    expect(missing).toContain("not installed");
    expect(refused).not.toContain("not installed");
    expect(refused).toContain("could not read this repository");
    expect(missing).not.toContain("could not read this repository");
  });
});

describe("what a commit puts beyond reach", () => {
  test("every mechanism a reader would ask about is named", async () => {
    const all = GIT_UNDELETABLE.join("\n");
    for (const mechanism of ["reflog", "clone", "filter-repo", "packfile"]) {
      expect(all.toLowerCase(), mechanism).toContain(mechanism);
    }
  });

  test("it says Mind will not rewrite history, rather than offering to", () => {
    const last = GIT_UNDELETABLE.at(-1) ?? "";
    expect(last).toContain("does not rewrite history");
  });

  test("nothing here promises a deletion Mind cannot perform", () => {
    // The failure this guards against is a reassuring verb sneaking in: AC5
    // says do not over-promise, and the list is the promise.
    for (const note of GIT_UNDELETABLE) {
      expect(note.toLowerCase()).not.toContain("mind removes");
      expect(note.toLowerCase()).not.toContain("will be deleted");
    }
  });
});
