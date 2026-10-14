/**
 * `install.sh` (n5), run against a fake release directory served over file:// — no network, nothing published.
 * It must verify the checksum before it installs, refuse on a mismatch, never need root, pin a version, ask for
 * mind-<os>-<arch> only, and print the group-writable hint.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitFor } from "../support/wait.ts";

const SCRIPT = resolve(import.meta.dir, "..", "..", "install.sh");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const BIN = "#!/bin/sh\necho mind\n";

const platform = async () => {
  const os = (await Bun.$`uname -s`.text()).trim() === "Darwin" ? "darwin" : "linux";
  const m = (await Bun.$`uname -m`.text()).trim();
  return { os, arch: m === "x86_64" || m === "amd64" ? "x64" : "arm64" };
};

async function release(files: Record<string, string>, tag = "v0.10.9") {
  const root = await mkdtemp(join(tmpdir(), "mind-install-rel-"));
  scratch.push(root);
  await mkdir(join(root, tag), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, tag, name), content);
  return root;
}

/** Every tool the script uses and nothing else (so a `cosign` on this machine cannot leak in), plus fakes. */
const TOOLS = ["sh", "curl", "uname", "id", "mktemp", "mkdir", "awk", "sed", "grep", "head", "cut", "cp", "chmod", "mv", "rm", "ln", "cat", "sha256sum", "dirname", "basename", "tr", "printf", "sleep"];
async function toolbox(extra: Record<string, string> = {}, without: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "mind-install-tools-"));
  scratch.push(dir);
  for (const tool of TOOLS) {
    if (without.includes(tool)) continue;
    const real = Bun.which(tool);
    if (real !== null) await symlink(real, join(dir, tool));
  }
  for (const [name, body] of Object.entries(extra)) {
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, name), 0o755);
  }
  return dir;
}

async function run(root: string, args: string[] = [], env: Record<string, string> = {}, umaskValue = "022", tools?: string) {
  const home = await mkdtemp(join(tmpdir(), "mind-install-home-"));
  scratch.push(home);
  const tmp = await mkdtemp(join(tmpdir(), "mind-install-tmp-"));
  scratch.push(tmp);
  const path = tools ?? (await toolbox());
  const child = Bun.spawn(["sh", "-c", `umask ${umaskValue}; exec sh "$0" "$@"`, SCRIPT, ...args], {
    env: { PATH: path, HOME: home, TMPDIR: tmp, MIND_BASE_URL: `file://${root}`, MIND_VERSION: "v0.10.9", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr, home, tmp, dir: env["MIND_INSTALL_DIR"] ?? join(home, ".local", "bin") };
}

describe("install.sh", () => {
  test("installs under ~/.local/bin by default, after the checksum", async () => {
    const { os, arch } = await platform();
    const root = await release({
      [`mind-${os}-${arch}`]: BIN,
      SHA256SUMS: `${sha(BIN)}  mind-${os}-${arch}\n`,
    });
    const r = await run(root);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("checksum ok (mind-");
    expect(await readFile(join(r.dir, "mind"), "utf8")).toBe(BIN);
    expect((await stat(join(r.dir, "mind"))).mode & 0o111).not.toBe(0);
  });

  test("a release with no mind-<os>-<arch> refuses, and nothing is installed", async () => {
    const { os, arch } = await platform();
    const root = await release({ [`other-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  other-${os}-${arch}\n` });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`has no mind-${os}-${arch}`);
    expect(existsSync(join(r.dir, "mind"))).toBe(false);
  });

  test("a checksum that does not match refuses, and nothing is installed", async () => {
    const { os, arch } = await platform();
    const root = await release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${"0".repeat(64)}  mind-${os}-${arch}\n` });
    const r = await run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("checksum mismatch");
    expect(existsSync(join(r.dir, "mind"))).toBe(false);
  });

  test("a binary the list does not mention, a release with no list, a missing binary and an unknown version all refuse", async () => {
    const { os, arch } = await platform();
    const unlisted = await run(await release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  something-else\n` }));
    expect(unlisted.code).toBe(1);
    expect(unlisted.stderr).toContain("does not list");
    const noList = await run(await release({ [`mind-${os}-${arch}`]: BIN }));
    expect(noList.code).toBe(1);
    expect(noList.stderr).toContain("no SHA256SUMS");
    const noBinary = await run(await release({ SHA256SUMS: `${sha(BIN)}  x\n` }));
    expect(noBinary.code).toBe(1);
    expect(noBinary.stderr).toContain("has no mind-");
    const unknown = await run(await release({ SHA256SUMS: "" }), [], { MIND_VERSION: "v1.2.3" });
    expect(unknown.code).toBe(1);
    for (const r of [unlisted, noList, noBinary, unknown]) expect(existsSync(join(r.dir, "mind"))).toBe(false);
  });

  test("a version that is not a version is refused before anything is fetched; a bare number gets its v", async () => {
    const { os, arch } = await platform();
    const root = await release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  mind-${os}-${arch}\n` });
    expect((await run(root, [], { MIND_VERSION: "latest" })).code).toBe(1);
    const bare = await run(root, [], { MIND_VERSION: "0.10.9" });
    expect(bare.code, bare.stderr).toBe(0);
  });

  test("--dry-run says what it would do and changes nothing, not even a download", async () => {
    const root = await release({});
    const r = await run(root, ["--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Dry run");
    expect(r.stdout).toContain("no root needed");
    expect(existsSync(join(r.home, ".local"))).toBe(false);
  });

  test("it never uses root: no sudo on any line that runs, and it refuses to run as root", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const code = text.split("\n").filter((line) => !line.trim().startsWith("#"));
    expect(code.filter((line) => /sudo|doas|\bsu\b/.test(line))).toEqual([]);
    expect(text).toContain('[ "$(id -u)" = 0 ]');
    // The scan is not blind: the same filter finds a line that does run it.
    const sample = "# sudo in a comment\nsudo install x y\n".split("\n").filter((line) => !line.trim().startsWith("#"));
    expect(sample.filter((line) => /sudo|doas|\bsu\b/.test(line))).toEqual(["sudo install x y"]);
  });

  test("it prints the group-writable hint, and a stronger line when the umask allows group writes", async () => {
    const { os, arch } = await platform();
    const root = await release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  mind-${os}-${arch}\n` });
    const tight = await run(root, [], {}, "022");
    expect(tight.stdout).toContain("chmod go-w");
    expect(tight.stdout).not.toContain("directories you create are group-writable");
    const loose = await run(root, [], {}, "0002");
    expect(loose.stdout).toContain("Your umask is 0002");
    expect(loose.stdout).toContain("chmod go-w");
  });

  test("--uninstall removes the binary, never data, and says what erase is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-install-un-"));
    scratch.push(dir);
    await writeFile(join(dir, "mind"), BIN);
    await chmod(join(dir, "mind"), 0o755);
    const dry = await run(await release({}), ["--uninstall", "--dry-run"], { MIND_INSTALL_DIR: dir });
    expect(dry.stdout).toContain("would remove");
    expect(existsSync(join(dir, "mind"))).toBe(true);
    const r = await run(await release({}), ["--uninstall"], { MIND_INSTALL_DIR: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(dir, "mind"))).toBe(false);
    expect(r.stdout).toContain("mind erase");
  });

  test("an unknown option is refused", async () => {
    const r = await run(await release({}), ["--yolo"]);
    expect(r.code).toBe(2);
  });
});

const GOOD = async (tag = "v0.10.9", extra: Record<string, string> = {}) => {
  const { os, arch } = await platform();
  return release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  mind-${os}-${arch}\n`, ...extra }, tag);
};

describe("the version is validated before anything is fetched", () => {
  test.each(["v1/../../../x?y", "latest", "v1.2", "v1.2.3 ", "v1.2.3\nrm", "../v1.2.3", "v1.2.3;x", "v1.2.3/x"])("MIND_VERSION=%p is refused, nothing downloaded or created", async (bad) => {
    const root = await GOOD();
    const r = await run(root, [], { MIND_VERSION: bad });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Nothing was downloaded");
    expect(existsSync(join(r.dir, "mind"))).toBe(false);
    expect(await readdir(r.tmp)).toEqual([]);
  });

  test("a good tag, with a suffix, passes the check", async () => {
    const root = await GOOD("v0.10.9-alpha");
    const r = await run(root, [], { MIND_VERSION: "v0.10.9-alpha" });
    expect(r.code, r.stderr).toBe(0);
  });

  test("the tag the API answers is held to the same rule: a control character, a path, a bad shape", async () => {
    for (const tag of ["v1.0.0\u0001", "v1/../x", "latest", "v1.0"]) {
      const api = await mkdtemp(join(tmpdir(), "mind-install-api-"));
      scratch.push(api);
      await writeFile(join(api, "releases.json"), `[{"tag_name": "${tag.replace("\u0001", "\x01")}"}]`);
      const root = await GOOD();
      const r = await run(root, [], { MIND_VERSION: "", MIND_API_URL: `file://${api}/releases.json` });
      expect(r.code, tag).toBe(1);
      expect(r.stderr).toContain("not a version");
      expect(existsSync(join(r.dir, "mind"))).toBe(false);
    }
  });

  test("a good tag from the API is used", async () => {
    const api = await mkdtemp(join(tmpdir(), "mind-install-api-"));
    scratch.push(api);
    await writeFile(join(api, "releases.json"), '[{"tag_name": "v0.10.9", "prerelease": true}]');
    const r = await run(await GOOD(), [], { MIND_VERSION: "", MIND_API_URL: `file://${api}/releases.json` });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("mind v0.10.9 for");
  });
});

describe("nothing runs until the whole file has arrived", () => {
  test("the last line of the file is the call, and everything else is a definition or a constant", async () => {
    const lines = (await readFile(SCRIPT, "utf8")).trimEnd().split("\n");
    expect(lines.at(-1)).toBe('main "$@"');
    expect(lines.filter((line) => line.startsWith("main "))).toHaveLength(1);
  });

  test("a copy cut at many points changes nothing: no install directory, no temp files, no output files", async () => {
    const { os, arch } = await platform();
    const root = await release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  mind-${os}-${arch}\n` }, "v0.10.9");
    const lines = (await readFile(SCRIPT, "utf8")).split("\n");
    const tools = await toolbox();
    const cuts = [1, 5, 12, 30, 45, 60, 75, 90, 110, 140, 170, lines.length - 3, lines.length - 2];
    for (const cut of cuts) {
      const dir = await mkdtemp(join(tmpdir(), "mind-install-cut-"));
      scratch.push(dir);
      const copy = join(dir, "install.sh");
      await writeFile(copy, `${lines.slice(0, cut).join("\n")}\n`);
      const home = join(dir, "home");
      await mkdir(home);
      const tmp = join(dir, "tmp");
      await mkdir(tmp);
      const child = Bun.spawn(["sh", copy], { env: { PATH: tools, HOME: home, TMPDIR: tmp, MIND_BASE_URL: `file://${root}`, MIND_VERSION: "v0.10.9" }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      await child.exited;
      expect(out, `cut at line ${cut}`).toBe("");
      expect(await readdir(home), `cut at line ${cut}`).toEqual([]);
      expect(await readdir(tmp), `cut at line ${cut}`).toEqual([]);
    }
  });
});

describe("the signature is not silently skipped", () => {
  const SIGNED = { "SHA256SUMS.sig": "sig", "SHA256SUMS.pem": "pem" };
  const cosignOk = { cosign: "exit 0" };
  const cosignBad = { cosign: 'echo "no matching signature" >&2; exit 1' };

  test("a release from the first signed one on needs cosign: without it, refused and nothing installed", async () => {
    const root = await GOOD("v0.11.0", SIGNED);
    const r = await run(root, [], { MIND_VERSION: "v0.11.0" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a verified signature is required");
    expect(r.stderr).toContain("cosign is not installed");
    expect(existsSync(join(r.dir, "mind"))).toBe(false);
  });

  test("with cosign and a signature that verifies, it installs and says so", async () => {
    const root = await GOOD("v0.11.0", SIGNED);
    const r = await run(root, [], { MIND_VERSION: "v0.11.0" }, "022", await toolbox(cosignOk));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("signature ok");
    expect(existsSync(join(r.dir, "mind"))).toBe(true);
  });

  test("a signature that does not verify refuses, with cosign's own words", async () => {
    const root = await GOOD("v0.11.0", SIGNED);
    const r = await run(root, [], { MIND_VERSION: "v0.11.0" }, "022", await toolbox(cosignBad));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not verify");
    expect(r.stderr).toContain("no matching signature");
    expect(existsSync(join(r.dir, "mind"))).toBe(false);
  });

  test("a signed-era release with no .sig, or no .pem, refuses; so does a later one (v1.0.0)", async () => {
    for (const [tag, files] of [["v0.11.0", {}], ["v0.11.0", { "SHA256SUMS.sig": "sig" }], ["v1.0.0", {}]] as const) {
      const r = await run(await GOOD(tag, files), [], { MIND_VERSION: tag }, "022", await toolbox(cosignOk));
      expect(r.code, tag).toBe(1);
      expect(r.stderr).toContain("a verified signature is required");
      expect(existsSync(join(r.dir, "mind"))).toBe(false);
    }
  });

  test("MIND_REQUIRE_SIGNATURE=1 makes an old release need one too", async () => {
    const r = await run(await GOOD(), [], { MIND_REQUIRE_SIGNATURE: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("a verified signature is required");
  });

  test("an old release without one still installs, and says in one plain line that the signature was NOT checked", async () => {
    const r = await run(await GOOD(), []);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter((line) => line.startsWith("WARNING: the signature on SHA256SUMS was NOT checked"))).toHaveLength(1);
  });

  test("the constant that decides is one line, and 0.10.x is before it", async () => {
    const text = await readFile(SCRIPT, "utf8");
    expect(text.match(/^FIRST_SIGNED_TAG="v[0-9.]+"$/gm)).toHaveLength(1);
  });
});

describe("the smaller things", () => {
  test("every curl is https-only, and so are its redirects", async () => {
    const text = await readFile(SCRIPT, "utf8");
    const calls = text.split("\n").filter((line) => /\bcurl\b/.test(line) && !line.trim().startsWith("#") && !line.includes("command -v") && !line.includes("needs curl") && !line.includes("curl exit"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--proto "$proto"');
    expect(calls[0]).toContain('--proto-redir "=https"');
    expect(text).toContain('proto="=https"');
    // file:// is allowed only when a test points the script at a directory by environment variable.
    expect(text).toContain('[ -z "${MIND_BASE_URL:-}${MIND_API_URL:-}" ] || proto="=https,file"');
  });

  test("a failed copy leaves no staged file in the install directory and no temp directory", async () => {
    const { os, arch } = await platform();
    const root = await release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  mind-${os}-${arch}\n` }, "v0.10.9");
    const tools = await toolbox({ cp: "exit 1" }, ["cp"]);
    const dir = await mkdtemp(join(tmpdir(), "mind-install-dir-"));
    scratch.push(dir);
    const r = await run(root, [], { MIND_INSTALL_DIR: dir }, "022", tools);
    expect(r.code).not.toBe(0);
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(r.tmp)).toEqual([]);
  });

  test("the staged file lives inside the install directory (same filesystem, so the move is atomic)", async () => {
    expect(await readFile(SCRIPT, "utf8")).toContain('STAGE="$(mktemp "$DIR/.mind-install.XXXXXX")"');
  });

  test("--help works from a pipe, with no file to read", async () => {
    const child = Bun.spawn(["sh", "-c", `cat "${SCRIPT}" | sh -s -- --help`], { env: { PATH: await toolbox() }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    expect(child.exitCode).toBe(0);
    expect(out).toContain("MIND_REQUIRE_SIGNATURE");
    expect(out).toContain("--uninstall");
  });
});

describe("a signal stops the install", () => {
  test.each([["SIGTERM", 143], ["SIGINT", 130]] as const)("%s mid-download: it cleans up, exits %i and installs nothing", async (signal, code) => {
    const { os, arch } = await platform();
    const root = await release({ [`mind-${os}-${arch}`]: BIN, SHA256SUMS: `${sha(BIN)}  mind-${os}-${arch}\n` }, "v0.10.9");
    // A curl that says it has started and then waits to be released, and then succeeds: the signal is sent while it
    // is held (an event, not a guess at how long the script takes to get there), and only afterwards is it released.
    // If the trap did not stop the script, it would go on past this curl and install.
    const tools = await toolbox({
      curl: 'out=""; while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done; : > "$STUB_STARTED"; while [ ! -e "$STUB_GO" ]; do sleep 0.02; done; : > "$out"; printf 200',
    }, ["curl"]);
    const home = await mkdtemp(join(tmpdir(), "mind-install-home-"));
    const tmp = await mkdtemp(join(tmpdir(), "mind-install-tmp-"));
    const flags = await mkdtemp(join(tmpdir(), "mind-install-flags-"));
    scratch.push(home, tmp, flags);
    const started = join(flags, "started");
    const go = join(flags, "go");
    const child = Bun.spawn(["sh", "-c", `exec sh "${SCRIPT}"`], { env: { PATH: tools, HOME: home, TMPDIR: tmp, STUB_STARTED: started, STUB_GO: go, MIND_BASE_URL: `file://${root}`, MIND_VERSION: "v0.10.9" }, stdout: "pipe", stderr: "pipe" });
    expect(await waitFor(() => existsSync(started)), "the script never reached its first download").toBe(true);
    child.kill(signal);
    await writeFile(go, "");
    const out = await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    await child.exited;
    expect(child.exitCode).toBe(code);
    expect(out).not.toContain("installed");
    expect(existsSync(join(home, ".local", "bin", "mind"))).toBe(false);
    expect(await readdir(tmp)).toEqual([]);
  });

  test("the traps are one place: EXIT cleans up, INT and TERM clean up and exit", async () => {
    const text = await readFile(SCRIPT, "utf8");
    expect(text).toContain("trap cleanup EXIT");
    expect(text).toContain("trap 'cleanup; exit 130' INT");
    expect(text).toContain("trap 'cleanup; exit 143' TERM");
    expect(text).not.toContain("trap cleanup EXIT INT TERM");
  });
});

