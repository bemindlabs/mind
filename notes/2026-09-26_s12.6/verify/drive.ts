// drive.ts <config.json> — one real turn through mind's OWN CliExec + registry.
// Config: { vendor, level (1|2|3), prompt, cwd, home, pathDir, outDir, extraEnv? }
// The LiteLLM key is read from OMV_SECRETS_FILE into request.env ONLY (never process.env,
// never argv, never printed). Everything written to outDir has the key redacted.
import { readFileSync, writeFileSync } from "node:fs";
import { CliExec } from "<repo>/src/exec/cli-exec.ts";
import { vendor } from "<repo>/src/exec/registry.ts";
import { RESTRAINED, LOOSENED, atLevel } from "<repo>/test/support/restraint.ts";
import { subjectId } from "<repo>/src/types.ts";

type Config = {
  vendor: string;
  level: 1 | 2 | 3;
  prompt: string;
  cwd: string;
  home: string;
  pathDir: string;
  outDir: string;
  extraEnv?: Record<string, string>;
};

const config: Config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));

const secretsFile = process.env["OMV_SECRETS_FILE"];
delete process.env["OMV_SECRETS_FILE"];
if (!secretsFile) throw new Error("OMV_SECRETS_FILE not set");
const line = readFileSync(secretsFile, "utf8").split("\n").find((l) => l.startsWith("LITELLM_MASTER_KEY="));
if (!line) throw new Error("LITELLM_MASTER_KEY not found");
const key = line.slice("LITELLM_MASTER_KEY=".length).replace(/"/g, "").trim();
if (key.length === 0) throw new Error("empty key");

const restraint = config.level === 1 ? RESTRAINED : config.level === 2 ? LOOSENED : atLevel(3);

const env: Record<string, string> = {
  HOME: config.home,
  PATH: `${config.pathDir}:/usr/local/bin:/usr/bin:/bin`,
  LITELLM_API_KEY: key,
  OMV_ARGV_LOG: `${config.outDir}/argv.jsonl`,
  ...(config.extraEnv ?? {}),
};

const exec = new CliExec(vendor(config.vendor));
const t0 = Date.now();
const result = await exec.run({
  restraint,
  subject: subjectId("example"),
  prompt: config.prompt,
  cwd: config.cwd,
  env,
  timeoutMs: 600_000,
});
const wall = Date.now() - t0;

let redactions = 0;
const scrub = (s: string): string => {
  if (!s.includes(key)) return s;
  redactions += s.split(key).length - 1;
  return s.split(key).join("[REDACTED-LITELLM-KEY]");
};

const out = {
  vendor: config.vendor,
  level: config.level,
  restraint: { act: restraint.act, loosened: restraint.loosened, unfenced: restraint.unfenced },
  backend: result.backend,
  confidence: result.confidence,
  identityStrength: result.identityStrength,
  text: scrub(result.text),
  raw: scrub(result.evidence.raw),
  usage: result.evidence.usage,
  exitCode: result.evidence.exitCode ?? null,
  durationMs: result.evidence.durationMs,
  wallMs: wall,
};
out["keyRedactions" as keyof typeof out] = redactions as never;
writeFileSync(`${config.outDir}/turn.json`, JSON.stringify(out, null, 1));
writeFileSync(`${config.outDir}/answer.txt`, out.text + "\n");
console.log(
  JSON.stringify({
    confidence: out.confidence,
    exitCode: out.exitCode,
    usage: out.usage,
    textHead: out.text.slice(0, 200),
    rawHead: out.raw.slice(0, 200),
    durationMs: out.durationMs,
    keyRedactions: redactions,
  }),
);
