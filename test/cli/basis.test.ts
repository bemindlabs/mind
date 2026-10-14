/** S7.3 through the binary (D-077): record is typed at a terminal; show and revoke are not. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("mind basis", () => {
  test("show nothing, record refused without a terminal, show and revoke a record, usage", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-basis-cli-"));
    scratch.push(home);
    const env = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), MIND_NO_UPDATE_CHECK: "1" };
    const run = async (args: readonly string[]) => {
      const child = Bun.spawn([BUN, "run", BIN, "basis", ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      await child.exited;
      return { code: child.exitCode ?? -1, stdout, stderr };
    };
    expect((await run(["show", "--subject", "example"])).stdout).toContain("no basis on record");
    const refused = await run(["record", "owner", "--subject", "example", "--uses", "memory"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("record basis for example");

    const dir = join(home, "state", "mind", "basis", "example");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "records.json"), JSON.stringify([{ id: "b1", subject: "example", basis: "consent", approvedBy: "HR", at: "2026-09-25T00:00:00Z", uses: ["memory"], expires: "2027-12-31", note: "signed form", revokedAt: null }]));
    const shown = await run(["show", "--subject", "example"]);
    expect(shown.stdout).toMatch(/b1\s+active\s+consent/);
    expect(shown.stdout).toContain("until 2027-12-31");
    expect((await run(["revoke", "b1", "--subject", "example"])).code).toBe(0);
    expect(JSON.parse(await readFile(join(dir, "records.json"), "utf8"))[0].revokedAt).not.toBeNull();
    expect((await run(["show", "--subject", "example"])).stdout).toMatch(/b1\s+revoked/);
    expect((await run(["revoke", "b1", "--subject", "example"])).code).toBe(1);
    expect((await run(["revoke", "zz", "--subject", "example"])).code).toBe(1);

    for (const args of [[], ["wat"], ["show"], ["record", "--subject", "example"], ["record", "vibes", "--subject", "example", "--uses", "memory"], ["record", "owner", "--subject", "example"], ["record", "owner", "--subject", "example", "--uses", "memory", "--expires", "2001-01-01"], ["revoke", "--subject", "example"]]) {
      expect((await run(args)).code, args.join(" ")).toBe(2);
    }
  }, 60_000);
});
