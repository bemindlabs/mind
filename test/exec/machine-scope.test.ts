import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_READ_DIRS, fenceSupport } from "../../src/exec/fence.ts";
import { BUN } from "../support/bare-path.ts";
import { MAX_GRANTS, machineNotice, machinePlan, machineVerdict, type MachineInput } from "../../src/exec/machine-scope.ts";

/** A small disk: directories as keys, their entries as values; a name ending `.txt` is a file. */
const TREE: Record<string, string[]> = {
  "/": ["home", "usr", "etc", "run", "proc", "tmp", "data", "var"],
  "/home": ["dev", "ann"],
  "/home/dev": [".secrets", ".ssh", ".config", ".local", "work", "notes.txt"],
  "/home/dev/.config": ["gh", "other"],
  "/home/dev/.local": ["share", "state"],
  "/home/dev/.local/share": ["mind", "foo"],
  "/home/dev/.local/state": ["mind"],
  "/home/dev/.secrets": ["tokens"],
  "/home/dev/.ssh": ["id_ed25519"],
  "/home/dev/.config/gh": ["hosts.yml"],
  "/home/dev/.config/other": [],
  "/home/dev/.local/share/mind": ["agent"],
  "/home/dev/.local/share/foo": [],
  "/home/dev/.local/state/mind": ["ledger"],
  "/home/dev/work": ["repo"],
  "/home/ann": [],
  "/usr": [],
  "/etc": [],
  "/run": ["docker.sock"],
  "/proc": [],
  "/tmp": [],
  "/data": [],
  "/var": ["run"],
};

/** Everything not listed as a directory key above that the tests name: a file, a socket, or a leaf directory. */
const FILES = new Set(["/home/dev/notes.txt", "/run/docker.sock"]);

const RED = [
  "/home/dev/.secrets",
  "/home/dev/.ssh",
  "/home/dev/.config/gh",
  "/home/dev/.local/share/mind",
  "/home/dev/.local/state/mind",
];

function input(overrides: Partial<MachineInput> = {}): MachineInput {
  return {
    redLines: RED,
    system: ["/usr", "/etc"],
    listDir: (path) => TREE[path],
    isDir: (path) => !FILES.has(path),
    real: (path) => path,
    ...overrides,
  };
}

function plan(overrides: Partial<MachineInput> = {}) {
  const verdict = machinePlan(input(overrides));
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.plan;
}

describe("machinePlan", () => {
  test("grants everything but the red lines, walking around each one", () => {
    expect(plan().grants).toEqual([
      "/data",
      "/home/ann",
      "/home/dev/.config/other",
      "/home/dev/.local/share/foo",
      "/home/dev/work",
      "/tmp",
      "/var",
    ]);
  });

  test("no granted directory holds, or is, a red line", () => {
    for (const grant of plan().grants) {
      for (const line of RED) {
        expect(line === grant || line.startsWith(`${grant}/`), `${grant} holds ${line}`).toBe(false);
      }
    }
  });

  test("never grants the volatile or system places, nor the sockets in /run", () => {
    const grants = plan().grants;
    for (const place of ["/proc", "/run", "/usr", "/etc", "/dev", "/sys", "/boot"]) {
      expect(grants.some((grant) => grant === place || grant.startsWith(`${place}/`)), place).toBe(false);
    }
  });

  test("a file at the top is left out with a note, not granted", () => {
    expect(plan().notes).toContain("/home/dev/notes.txt is not a directory and is not granted");
  });

  test("a red line added by the owner is walked around the same way", () => {
    const grants = plan({ redLines: [...RED, "/home/dev/work"] }).grants;
    expect(grants).not.toContain("/home/dev/work");
    expect(grants).toContain("/home/ann");
  });

  test("a red line that is a symlink is judged by where it really points", () => {
    // `/tmp/link` points at the secrets: a grant on /tmp would let the vendor reach them through it? No — Landlock
    // follows the link to the target, which is not granted; but a *granted* path whose real location is a red line
    // must be dropped, so the plan resolves before it judges.
    const real = (path: string) => (path === "/home/dev/work" ? "/home/dev/.secrets" : path);
    expect(plan({ real }).grants).not.toContain("/home/dev/.secrets");
    expect(plan({ real }).grants).not.toContain("/home/dev/work");
  });

  test("a directory that holds a red line and cannot be listed refuses the scope, never grants it whole", () => {
    const verdict = machinePlan(input({ listDir: (path) => (path === "/home/dev" ? undefined : TREE[path]) }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("holds a red line and cannot be listed");
  });

  test("too many grants refuses the scope", () => {
    const many = Array.from({ length: MAX_GRANTS + 2 }, (_, i) => `d${i}`);
    const verdict = machinePlan(
      input({ listDir: (path) => (path === "/" ? many : []), isDir: () => true, redLines: ["/d0/x"] }),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("machineVerdict, over the real filesystem", () => {
  test("on this machine it plans without granting a red line, and refuses nothing it should not", () => {
    const home = process.env["HOME"]!;
    const lines = [`${home}/.secrets`, `${home}/.ssh`];
    const verdict = machineVerdict(lines, ["/usr", "/etc", "/bin", "/lib"]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.plan.grants.length).toBeGreaterThan(3);
    for (const grant of verdict.plan.grants) {
      for (const line of lines) expect(line === grant || line.startsWith(`${grant}/`), `${grant} holds ${line}`).toBe(false);
    }
  });
});

describe("machineNotice", () => {
  test("says how much, what is closed, and that deletion is still possible", () => {
    const text = machineNotice({ grants: ["/a", "/b"], notes: [] }, ["/x/.secrets"]);
    expect(text).toContain("2 directories");
    expect(text).toContain("1 red line it cannot open at all (/x/.secrets)");
    expect(text).toContain("tripwire catches some broad deletes, but can be bypassed");
  });
});

describe.skipIf(!fenceSupport().ok)("the real kernel under a machine plan", () => {
  const ENTRY = join(import.meta.dir, "..", "..", "bin", "mind.ts");
  const scratch: string[] = [];
  afterEach(async () => {
    for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
  });

  /** A home with red lines, a nested red line, ordinary directories, and a vendor home the fence needs. */
  async function fixture() {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "mind-machine-")));
    scratch.push(root);
    const home = join(root, "home");
    for (const dir of [".secrets", ".config/gh", ".config/other", "work", "elsewhere", "vendor-home"]) {
      await mkdir(join(home, dir), { recursive: true });
    }
    await writeFile(join(home, ".secrets", "canary"), "SECRETSECRET");
    await writeFile(join(home, ".config", "gh", "hosts"), "GHTOKENGHTOKEN");
    await writeFile(join(home, ".config", "other", "x"), "fine");
    await writeFile(join(home, "work", "in.txt"), "inside the work");
    await writeFile(join(home, "elsewhere", "e.txt"), "elsewhere ok");
    const red = [join(home, ".secrets"), join(home, ".config", "gh")];
    return { root, home, red };
  }

  test("reads and writes land everywhere in the plan, and the red lines stay shut to a shell and its children", async () => {
    const f = await fixture();
    const verdict = machineVerdict(f.red, SYSTEM_READ_DIRS, f.root);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const script = `
      const fs = require("node:fs");
      const out = {};
      const read = (name, path) => { try { out[name] = fs.readFileSync(path, "utf8").slice(0, 8); } catch (cause) { out[name] = cause.code; } };
      const write = (name, path) => { try { fs.writeFileSync(path, "x"); out[name] = "wrote"; } catch (cause) { out[name] = cause.code; } };
      read("work", ${JSON.stringify(join(f.home, "work", "in.txt"))});
      read("elsewhere", ${JSON.stringify(join(f.home, "elsewhere", "e.txt"))});
      read("sibling", ${JSON.stringify(join(f.home, ".config", "other", "x"))});
      read("secret", ${JSON.stringify(join(f.home, ".secrets", "canary"))});
      read("gh", ${JSON.stringify(join(f.home, ".config", "gh", "hosts"))});
      write("writeElsewhere", ${JSON.stringify(join(f.home, "elsewhere", "new.txt"))});
      write("writeSecrets", ${JSON.stringify(join(f.home, ".secrets", "new.txt"))});
      try { fs.readdirSync(${JSON.stringify(join(f.home, ".secrets"))}); out.listSecrets = "ok"; } catch (cause) { out.listSecrets = cause.code; }
      try { fs.readdirSync(${JSON.stringify(f.home)}); out.listHome = "ok"; } catch (cause) { out.listHome = cause.code; }
      const cat = Bun.spawnSync(["cat", ${JSON.stringify(join(f.home, ".secrets", "canary"))}], { stdout: "pipe", stderr: "pipe" });
      out.grandchild = cat.exitCode === 0 ? "read it" : "refused";
      console.log(JSON.stringify(out));
    `;
    const child = Bun.spawn(
      [BUN, "run", ENTRY, "__fence", "--confine-reads", "--rw", join(f.home, "vendor-home"), ...verdict.plan.grants.flatMap((path) => ["--rw", path]), "--", BUN, "-e", script],
      { cwd: join(f.home, "work"), stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, MIND_NO_UPDATE_CHECK: "1" } },
    );
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim()), stderr).toEqual({
      work: "inside t",
      elsewhere: "elsewher",
      sibling: "fine",
      secret: "EACCES",
      gh: "EACCES",
      writeElsewhere: "wrote",
      writeSecrets: "EACCES",
      listSecrets: "EACCES",
      // The one cost of the walk: a directory that is only above a red line cannot be listed. A bot goes by path.
      listHome: "EACCES",
      grandchild: "refused",
    });
  }, 60_000);

  test("without the plan the same turn reads nothing of the elsewhere directory: the plan is what widens it", async () => {
    const f = await fixture();
    const child = Bun.spawn(
      [BUN, "run", ENTRY, "__fence", "--confine-reads", "--rw", join(f.home, "vendor-home"), "--", BUN, "-e", `try { require("node:fs").readFileSync(${JSON.stringify(join(f.home, "elsewhere", "e.txt"))}); console.log("read"); } catch (cause) { console.log(cause.code); }`],
      { cwd: join(f.home, "work"), stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, MIND_NO_UPDATE_CHECK: "1" } },
    );
    expect((await new Response(child.stdout).text()).trim()).toBe("EACCES");
    await child.exited;
  }, 60_000);
});
