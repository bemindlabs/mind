/** `mind doctor` — is this machine ready, and nothing wider. */

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_OLLAMA_HOST,
  DEFAULT_QDRANT_HOST,
  doctorExit,
  fetchJson,
  pathLookup,
  renderDoctor,
  runDoctor,
  runProbe,
  type DoctorEnv,
} from "../../src/doctor.ts";
import { VENDORS, backend as buildBackend, restrain } from "../../src/exec/index.ts";
import { unitWorkdirHints } from "../../src/exec/workdir.ts";
import { capLine as capText, capSurvey } from "../../src/exec/cap.ts";
import { decideDial, dialEnv } from "../dial.ts";
import { LITELLM_BASE_URL, LOCAL_BACKENDS, liteLLMKeyFile, readLiteLLMKey } from "../../src/exec/local-cli.ts";
import { networkInterfaces } from "node:os";
import { readEnv } from "../../src/env.ts";
import { judgeStatus } from "../../src/egress/index.ts";
import { isKnownBackend } from "../../src/soul/index.ts";
import { subjectId } from "../../src/types.ts";
import { ENGINE_CHECKOUT, parseArgs, usageError } from "../shared.ts";

const DOCTOR_USAGE =
  "usage: mind doctor [--model a,b] [--backend a,b] [--home <dir>] " +
  "[--agent <dir> --subject <id>] [--ollama <url>] [--qdrant <url>] [--no-version] [--json]\n" +
  "  --qdrant defaults to $MIND_QDRANT_URL, then http://127.0.0.1:10300";

/**
 * `mind doctor` — S0.2, kept to parsing and printing.
 *
 * Every probe lives in `src/doctor.ts` behind an injected {@link DoctorEnv}, so
 * this function does three things and no more: read the flags, put this
 * machine's facts into that env, and hand the exit code back. The report is
 * printed as plain lines rather than coloured: it is long, it is the kind of
 * output people paste into an issue, and a table of escape codes is worth less
 * than text that survives being copied.
 */
export async function cmdDoctor(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json", "no-version"]);
  if (positional.length > 0) return usageError(DOCTOR_USAGE);

  const commas = (raw: string | undefined) =>
    (raw ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");

  const named = commas(options.get("backend"));
  for (const name of named) {
    if (!isKnownBackend(name)) return usageError(`unknown backend ${JSON.stringify(name)}`);
  }
  // Every backend by default, not the phase-A chain: this is a survey, and a
  // vendor whose instruction file nobody looked at is exactly where a leftover
  // identity block sits unnoticed (I-3).
  const backends = named.length > 0 ? named : ["ollama", ...VENDORS.map((spec) => spec.id)];

  const rawSubject = options.get("subject");
  let subject;
  if (rawSubject !== undefined && rawSubject !== "") {
    try {
      subject = subjectId(rawSubject);
    } catch (error) {
      return usageError(error instanceof Error ? error.message : String(error));
    }
  }

  const rawAgent = options.get("agent");
  const agent = rawAgent === undefined || rawAgent === "" ? undefined : resolve(rawAgent);
  if (agent !== undefined && subject === undefined) {
    return usageError(
      "--agent needs --subject <id> as well: whether `.mind/` is stale is a question about one " +
        "identity's derived state, and Mind will not take the subject from a directory name (D-014)",
    );
  }

  const askedHome = options.get("home");
  const home = askedHome === undefined || askedHome === "" ? homedir() : resolve(askedHome);

  const host = (asked: string | undefined, fallback: string) =>
    (asked === undefined || asked === "" ? fallback : asked).replace(/\/$/, "");
  const configured = process.env["OLLAMA_HOST"];

  // D-124: only where local action is set up — a key file that is not there means there is nothing to ask.
  const keyFile = liteLLMKeyFile(home, process.env);
  const loaded = await readLiteLLMKey(keyFile);
  const liteLLM = loaded.ok
    ? { url: LITELLM_BASE_URL, key: loaded.key }
    : loaded.absent
      ? undefined
      : { url: LITELLM_BASE_URL, problem: loaded.reason };
  const ownAddresses = Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((address) => address.address.toLowerCase()));

  const env: DoctorEnv = {
    home,
    cwd: process.cwd(),
    env: process.env,
    // `undefined` when this is the compiled binary, and the report says so
    // rather than scanning a virtual filesystem and calling the result clean.
    engineRoot: ENGINE_CHECKOUT,
    which: pathLookup,
    run: runProbe,
    getJson: fetchJson,
    ollamaHost: host(
      options.get("ollama"),
      configured === undefined || configured === "" ? DEFAULT_OLLAMA_HOST : configured,
    ),
    // The flag, else `MIND_QDRANT_URL` as `memory index`, `memory search` and `erase` read it, else the default
    // (B7 of the first stranger run: doctor ignored the variable and listed a store the other commands never asked).
    qdrantHost: host(options.get("qdrant"), readEnv("QDRANT_URL", process.env) || DEFAULT_QDRANT_HOST),
    models: commas(options.get("model")),
    backends,
    probeVersions: !options.has("no-version"),
    ownAddresses,
    ...(liteLLM === undefined ? {} : { liteLLM }),
    ...(agent === undefined ? {} : { agent }),
    ...(subject === undefined ? {} : { subject }),
  };

  const report = await runDoctor(env);
  // D-163 (Q4-D2): with the dial above 1, which of these backends are held at write/run 1. Needs the agent,
  // because the dial is the agent's own file; a short line, and nothing when nothing is capped.
  const capped =
    agent !== undefined && subject !== undefined
      ? capSurvey(
          [...backends, ...LOCAL_BACKENDS.filter((id) => !backends.includes(id))].filter((id) => id !== "ollama"),
          restrain((await decideDial(agent, dialEnv(), subject)).effective),
          buildBackend,
          subject,
        )
      : undefined;
  const capLine = capped === undefined ? undefined : capText(capped);
  // D-163: a service unit whose WorkingDirectory a loosened turn would be refused in. Read-only.
  const unitHints = await unitWorkdirHints(home, process.env, agent);
  // D-181: where the egress judge stands. The needles are not counted: `doctor` does not open the personal store, so
  // the line says the judge reads only against a list and leaves the list to `mind egress needles`.
  const judgeLine = judgeStatus(process.env);
  const extra = {
    ...(capLine === undefined || capped === undefined ? {} : { cap: { capped: capped.capped, fenced: capped.fenced } }),
    ...(unitHints.length === 0 ? {} : { units: unitHints }),
    egressJudge: judgeLine,
  };
  if (options.has("json")) console.log(JSON.stringify({ ...report, ...extra }, null, 2));
  else {
    for (const line of renderDoctor(report)) console.log(line);
    if (capLine !== undefined) console.log(capLine);
    for (const hint of unitHints) console.log(hint);
    console.log(judgeLine);
  }

  return doctorExit(report);
}
