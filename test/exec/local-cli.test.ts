import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import {
  LITELLM_KEY_FILE_ENV,
  LOCAL_BACKENDS,
  LOCAL_MODEL,
  LocalCliExec,
  isLocalCliId,
  liteLLMKeyFile,
  parseLiteLLMKey,
  readLiteLLMKey,
} from "../../src/exec/local-cli.ts";
import type { VendorSpec } from "../../src/exec/registry.ts";
import { subjectId } from "../../src/types.ts";
import { LOOSENED, RESTRAINED } from "../support/restraint.ts";

const SUBJECT = subjectId("example");
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

interface Capture {
  readonly spec: VendorSpec;
  readonly request: TurnRequest;
  readonly argv: readonly string[];
}

function harness(): {
  readonly captures: Capture[];
  readonly makeCli: (spec: VendorSpec) => ExecBackend;
} {
  const captures: Capture[] = [];
  return {
    captures,
    makeCli: (spec) => ({
      id: spec.id,
      display: spec.display,
      kind: "cli",
      identityStrength: spec.identity.strength,
      available: async () => ({ ok: true, detail: `/fixture/bin/${spec.binary}` }),
      run: async (request): Promise<TurnResult> => {
        captures.push({ spec, request, argv: spec.headlessArgv(request) });
        return {
          backend: spec.id,
          text: "answered",
          confidence: "confirmed",
          identityStrength: spec.identity.strength,
          evidence: { source: spec.id, prompt: request.prompt, raw: "fixture" },
        };
      },
    }),
  };
}

async function fixture() {
  const home = await temp("mind-local-cli-");
  const state = join(home, "state");
  const work = join(home, "agent");
  const keyFile = join(home, "fixture-litellm.env");
  await mkdir(work);
  await writeFile(keyFile, `IGNORED=x\nexport LITELLM_API_KEY='synthetic-key-value'\n`);
  return {
    home,
    state,
    work,
    keyFile,
    env: {
      XDG_STATE_HOME: state,
      [LITELLM_KEY_FILE_ENV]: keyFile,
      PATH: "/fixture/bin",
      USER: "fixture-user",
      OWNER_CLOUD_SECRET: "must-not-be-inherited",
    },
  };
}

describe("the registered local CLI ids", () => {
  test("are the chosen claude to grok chain and nothing else", () => {
    expect(LOCAL_BACKENDS).toEqual(["claude-local", "grok-local"]);
    expect(isLocalCliId("claude-local")).toBe(true);
    expect(isLocalCliId("grok-local")).toBe(true);
    expect(isLocalCliId("claude")).toBe(false);
  });
});

describe("LiteLLM key source", () => {
  test("parses dotenv assignments without evaluating them, with the last one winning", () => {
    expect(parseLiteLLMKey([
      "LITELLM_API_KEY=first # comment",
      "export LITELLM_API_KEY=\"second#kept=whole\"",
      "OTHER=value",
    ].join("\n"))).toBe("second#kept=whole");
    expect(parseLiteLLMKey("LITELLM_API_KEY=   # empty")).toBeUndefined();
    // The master key is read only to refuse it (D-124).
    expect(parseLiteLLMKey("LITELLM_MASTER_KEY=admin")).toBeUndefined();
    expect(parseLiteLLMKey("LITELLM_MASTER_KEY=admin", "LITELLM_MASTER_KEY")).toBe("admin");
  });

  test("readLiteLLMKey: the virtual key, or why not — a missing file is told apart for doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-litellm-key-"));
    try {
      const at = (name: string) => join(dir, name);
      await writeFile(at("ok"), "LITELLM_API_KEY=virtual\n");
      await writeFile(at("master"), "LITELLM_MASTER_KEY=admin\n");
      await writeFile(at("empty"), "OTHER=1\n");
      expect(await readLiteLLMKey(at("ok"))).toEqual({ ok: true, key: "virtual" });
      const master = await readLiteLLMKey(at("master"));
      expect(master.ok === false && !master.absent && master.reason.includes("holds only LITELLM_MASTER_KEY")).toBe(true);
      const empty = await readLiteLLMKey(at("empty"));
      expect(empty).toEqual({ ok: false, absent: false, reason: "the LiteLLM key file has no non-empty LITELLM_API_KEY" });
      const missing = await readLiteLLMKey(at("nope"));
      expect(missing.ok === false && missing.absent).toBe(true);
      const unreadable = await readLiteLLMKey(dir); // a directory: read fails, but it is there
      expect(unreadable.ok === false && !unreadable.absent).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defaults under the owner's home and accepts only explicit path spelling", () => {
    expect(liteLLMKeyFile("/home/example", {})).toBe("/home/example/.secrets/.env.mind-litellm");
    expect(liteLLMKeyFile("/home/example", { [LITELLM_KEY_FILE_ENV]: "~/private/key.env" }))
      .toBe("/home/example/private/key.env");
    expect(liteLLMKeyFile("/home/example", { [LITELLM_KEY_FILE_ENV]: "/run/key.env" }))
      .toBe("/run/key.env");
  });
});

describe("claude-local", () => {
  test("uses a private home, a child-only key, local model aliases and the no-web level-2 grant", async () => {
    const box = await fixture();
    const fake = harness();
    const backend = new LocalCliExec("claude-local", {
      home: box.home,
      env: box.env,
      cwd: () => box.work,
      makeCli: fake.makeCli,
    });

    const result = await backend.run({
      subject: SUBJECT,
      prompt: "change the fixture",
      system: "fixture identity",
      restraint: LOOSENED,
      env: { OWNER_CLOUD_SECRET: "caller-cannot-put-this-back" },
    });
    expect(result.confidence).toBe("confirmed");
    expect(fake.captures).toHaveLength(1);
    const { spec, request, argv } = fake.captures[0]!;
    const child = spec.hardening?.env ?? {};
    const vendorHome = join(box.state, "mind", "vendors", "claude-local");

    expect(spec.inheritEnv).toBe(false);
    expect(child["HOME"]).toBe(vendorHome);
    expect(child["CLAUDE_CONFIG_DIR"]).toBe(join(vendorHome, ".claude"));
    expect(child["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:10400");
    expect(child["ANTHROPIC_AUTH_TOKEN"]).toBe("synthetic-key-value");
    expect(child["OWNER_CLOUD_SECRET"]).toBeUndefined();
    for (const name of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) expect(child[name]).toBe(LOCAL_MODEL);
    expect(child["CLAUDE_CODE_MODEL_CAPABILITIES"])
      .toBe("local-coder=-mid_conv_system,-mid_conv_tool_change,-effort");
    expect(child["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]).toBe("8192");
    expect(child["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]).toBe("118000");

    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Bash");
    expect(argv.join(" ")).not.toMatch(/WebFetch|WebSearch/);
    expect(argv.slice(argv.indexOf("--setting-sources"), argv.indexOf("--setting-sources") + 2)).toEqual([
      "--setting-sources",
      "user",
    ]);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("synthetic-key-value");
    // D-142: the variant takes no model of its own — it runs local-coder, behind the base vendor's flag.
    expect(spec.model).toBeUndefined();
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", LOCAL_MODEL]);
    expect(request.env).toEqual({});
    expect(request.cwd).toBe(box.work);
    expect(request.fence?.tcpPorts).toEqual([10400]);
    expect(request.fence?.writable).toEqual([
      vendorHome,
      join(vendorHome, "scratch"),
      box.work,
    ]);

    const settings = join(vendorHome, ".claude", "settings.json");
    const content = await readFile(settings, "utf8");
    expect(JSON.parse(content).pluginConfigs["agents-md@builtin"].options.instructionFiles)
      .toBe("claude-md");
    expect(content).not.toContain("synthetic-key-value");
    expect((await stat(vendorHome)).mode & 0o777).toBe(0o700);
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
  });
});

describe("grok-local", () => {
  test("writes the one-model config and keeps level 1 to home and scratch", async () => {
    const box = await fixture();
    const fake = harness();
    const backend = new LocalCliExec("grok-local", {
      home: box.home,
      env: box.env,
      cwd: () => box.work,
      makeCli: fake.makeCli,
    });

    await backend.run({ subject: SUBJECT, prompt: "inspect", restraint: RESTRAINED });
    const { spec, request, argv } = fake.captures[0]!;
    const child = spec.hardening?.env ?? {};
    const vendorHome = join(box.state, "mind", "vendors", "grok-local");
    const configPath = join(vendorHome, ".grok", "config.toml");
    const config = await readFile(configPath, "utf8");

    expect(spec.inheritEnv).toBe(false);
    expect(child["HOME"]).toBe(vendorHome);
    expect(child["GROK_HOME"]).toBe(join(vendorHome, ".grok"));
    expect(child["LITELLM_API_KEY"]).toBe("synthetic-key-value");
    expect(child["GROK_DEFAULT_MODEL"]).toBe(LOCAL_MODEL);
    expect(argv.join(" ")).toContain("--tools read_file,grep,list_dir");
    expect(argv.join(" ")).toContain("--disallowed-tools");
    expect(argv.join(" ")).not.toContain("--always-approve");
    expect(argv).not.toContain("synthetic-key-value");
    expect(request.fence).toEqual({
      writable: [vendorHome, join(vendorHome, "scratch")],
      tcpPorts: [10400],
    });

    expect(config).toContain('[models]\ndefault = "local-coder"');
    expect(config).toContain('allowed_models = ["local-coder"]');
    expect(config).toContain('base_url = "http://127.0.0.1:10400/v1"');
    expect(config).toContain('env_key = "LITELLM_API_KEY"');
    expect(config).toContain('exclude = ["LITELLM_API_KEY"]');
    expect(config).toContain("web_fetch = false");
    expect(config).not.toContain("synthetic-key-value");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  test("inherits D-119's acting grant inside the fence", async () => {
    const box = await fixture();
    const fake = harness();
    const backend = new LocalCliExec("grok-local", {
      home: box.home,
      env: box.env,
      cwd: () => box.work,
      makeCli: fake.makeCli,
    });
    await backend.run({ subject: SUBJECT, prompt: "act", restraint: LOOSENED });
    expect(fake.captures[0]!.argv).toContain("--always-approve");
    expect(fake.captures[0]!.request.fence?.writable).toContain(box.work);
  });
});

describe("fail closed", () => {
  test("a missing key refuses before a vendor can run", async () => {
    const box = await fixture();
    await rm(box.keyFile);
    const fake = harness();
    const backend = new LocalCliExec("claude-local", {
      home: box.home,
      env: box.env,
      cwd: () => box.work,
      makeCli: fake.makeCli,
    });
    const result = await backend.run({ subject: SUBJECT, prompt: "anything", restraint: RESTRAINED });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("key file could not be read");
    expect(fake.captures).toEqual([]);
  });

  test("a file with only the proxy's master key is refused, not used (D-124)", async () => {
    // A master key can add routes and callbacks to LiteLLM, which is not fenced:
    // a turn holding it could send data out through the proxy.
    const box = await fixture();
    await writeFile(box.keyFile, "LITELLM_MASTER_KEY=synthetic-master\n");
    const fake = harness();
    const backend = new LocalCliExec("claude-local", {
      home: box.home,
      env: box.env,
      cwd: () => box.work,
      makeCli: fake.makeCli,
    });
    const result = await backend.run({ subject: SUBJECT, prompt: "anything", restraint: RESTRAINED });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("holds only LITELLM_MASTER_KEY");
    expect(fake.captures).toEqual([]);
  });

  test("a non-loopback configured endpoint refuses before a vendor can run", async () => {
    const box = await fixture();
    const fake = harness();
    const backend = new LocalCliExec("grok-local", {
      home: box.home,
      env: box.env,
      cwd: () => box.work,
      baseUrl: "https://models.example.com:10400",
      makeCli: fake.makeCli,
    });
    const result = await backend.run({ subject: SUBJECT, prompt: "anything", restraint: RESTRAINED });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("loopback literal");
    expect(fake.captures).toEqual([]);
  });
});

describe("a local turn handed a task's browser (D-155)", () => {
  test("the fence gains exactly the container's port, and nothing else changes", async () => {
    const box = await fixture();
    const backend = new LocalCliExec("claude-local", { home: box.home, env: box.env, cwd: () => box.work });
    const plain = backend.prepare({ subject: SUBJECT, prompt: "p", restraint: LOOSENED });
    const handed = backend.prepare({
      subject: SUBJECT,
      prompt: "p",
      restraint: LOOSENED,
      browser: { port: 30_731, dir: box.home, token: "ab".repeat(32), operate: 1 },
    });
    expect(handed.fence?.tcpPorts).toEqual([10400, 30_731]);
    expect(handed.fence?.writable).toEqual(plain.fence?.writable ?? []);
  });

  test("a port outside the browser band is refused before anything is read or written", async () => {
    const box = await fixture();
    const fake = harness();
    const backend = new LocalCliExec("claude-local", {
      home: box.home,
      env: box.env,
      cwd: () => box.work,
      makeCli: fake.makeCli,
    });
    const result = await backend.run({
      subject: SUBJECT,
      prompt: "p",
      restraint: LOOSENED,
      browser: { port: 10_401, dir: box.home, token: "ab".repeat(32), operate: 1 },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("is not a browser task's");
    expect(fake.captures).toHaveLength(0);
  });
});
