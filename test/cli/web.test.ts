/**
 * D-162 through the binary: `mind web` never prints its key where it may be kept.
 *
 * Run as a systemd service, its stdout and stderr both go to the journal, and whoever reads the journal could
 * open the page. Off a terminal (here, a pipe) the link is printed without its key — the key file's path when
 * there is one, the key masked to four and four when there is not — and `--qr` draws no code, since the code is
 * the link. At a terminal (a pty from util-linux `script`) the whole link is still shown.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const BANNER_END = "Ctrl-C stops the page";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "mind-web-cli-"));
  scratch.push(home);
  const soul = join(home, "agent", "soul");
  await cp(SOUL, soul, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    PATH: await barePath(home),
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    MIND_NO_UPDATE_CHECK: "1",
  };
  return { home, soul, env };
}

/** Every run of 8 characters of the key: none may appear, not only the whole of it. */
function pieces(key: string): string[] {
  return Array.from({ length: key.length - 7 }, (_, i) => key.slice(i, i + 8));
}

/** Read a stream into `into.text` as it arrives. */
function collect(stream: ReadableStream<Uint8Array>, into: { text: string }): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) into.text += decoder.decode(chunk, { stream: true });
  })();
}

/** Start the page with stdout and stderr on pipes, wait for its banner, stop it, and return all it wrote. */
async function runPiped(argv: readonly string[], env: Record<string, string>) {
  const child = Bun.spawn([BUN, "run", BIN, ...argv], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = { text: "" }, err = { text: "" };
  const reading = Promise.all([collect(child.stdout, out), collect(child.stderr, err)]);
  const started = await waitFor(() => out.text.includes(BANNER_END) || child.exitCode !== null);
  child.kill("SIGTERM");
  await child.exited;
  await reading;
  return { started, stdout: out.text, stderr: err.text };
}

describe("mind web off a terminal (D-162)", () => {
  test("with --key-file: the address and the file's path; no key, nor any 8 characters of it, on stdout or stderr", async () => {
    const t = await setup();
    const keyFile = join(t.home, "web.key");
    const run = await runPiped(["web", t.soul, "--subject", "example", "--port", "0", "--key-file", keyFile, "--qr"], t.env);
    expect(run.started, run.stderr).toBe(true);
    const key = (await readFile(keyFile, "utf8")).trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const all = `${run.stdout}\n${run.stderr}`;
    for (const piece of pieces(key)) expect(all).not.toContain(piece);
    expect(run.stdout).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\n/);
    expect(run.stdout).toContain(`the key is in ${keyFile}`);
    expect(run.stdout).toContain("no pairing code here");
    expect(run.stdout).not.toContain("█");
    // The first start made the file, and said where — still without the key.
    expect(run.stderr).toContain(`a page key was written to ${keyFile}`);
  }, 60_000);

  test("without --key-file: the key masked to its first and last four, no longer run of hex anywhere", async () => {
    const t = await setup();
    const run = await runPiped(["web", t.soul, "--subject", "example", "--port", "0"], t.env);
    expect(run.started, run.stderr).toBe(true);
    const all = `${run.stdout}\n${run.stderr}`;
    expect(run.stdout).toMatch(/#t=[0-9a-f]{4}…[0-9a-f]{4}\n/);
    expect(all).not.toMatch(/[0-9a-f]{8,}/);
    expect(run.stdout).toContain("--key-file");
  }, 60_000);
});

// util-linux `script` gives the child a real pty; where it is missing (macOS ships a BSD one with other flags),
// the formatter's own test (test/web/banner.test.ts) still covers the terminal case.
const SCRIPT = process.platform === "linux" ? Bun.which("script") : null;

describe.skipIf(SCRIPT === null)("mind web at a terminal (D-162)", () => {
  test("the whole link, key included, as before", async () => {
    const t = await setup();
    const keyFile = join(t.home, "web.key");
    await writeFile(keyFile, `${"5a".repeat(32)}\n`, { mode: 0o600 });
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    // `exec`, so the page is the pty's own foreground process and the Ctrl-C typed below reaches it.
    const command = "exec " + [BUN, "run", BIN, "web", t.soul, "--subject", "example", "--port", "0", "--key-file", keyFile].map(quote).join(" ");
    const child = Bun.spawn([SCRIPT!, "-qefc", command, "/dev/null"], { cwd: ROOT, env: { ...t.env, PATH: `${t.env["PATH"]}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
    const out = { text: "" };
    const reading = collect(child.stdout, out);
    const started = await waitFor(() => out.text.includes(BANNER_END) || child.exitCode !== null);
    child.stdin.write("\x03");
    await child.stdin.flush();
    const stopped = await waitFor(() => child.exitCode !== null);
    if (!stopped) child.kill("SIGKILL");
    await child.exited;
    await reading;
    expect(stopped).toBe(true);
    expect(started, out.text).toBe(true);
    expect(out.text).toContain(`#t=${"5a".repeat(32)}`);
    expect(out.text).not.toContain("the key is in");
  }, 60_000);
});
