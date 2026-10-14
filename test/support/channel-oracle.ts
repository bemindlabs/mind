/**
 * A backend that can only repeat what the channel carried.
 *
 * S1.6 AC2 says a second identity must not be able to answer the first one's
 * questions. What Mind owns of that claim is the **channel** — the block in
 * each instruction file, and the system field of a request — and a test that
 * asked a real model would be measuring the model's discretion rather than
 * Mind's isolation, on a machine where the answer changes with the weather.
 *
 * So this is the most leaky backend that could exist: it reads its whole
 * instruction file (or the whole system field) and hands it back as the answer,
 * with the run's nonce attached. It has no memory, no training and no
 * judgement, which makes it exactly the right instrument for one question:
 *
 * > After the switch, is the first identity's text still reachable at all?
 *
 * A pass here is strong in the direction that matters. It is not "the model
 * declined to say"; it is "everything the channel carried was said, and the
 * other identity's facts were not in it". A failure is equally unambiguous:
 * the text was still there for anything downstream to read.
 *
 * It cannot say anything about what a real model does with a real context, and
 * `test/soul/isolation.real.test.ts` is the opt-in run that looks at that.
 */

import { readFile } from "node:fs/promises";
import { classify, type Availability, type ExecBackend, type TurnRequest, type TurnResult } from "../../src/exec/backend.ts";

/** How the protocol line in every probe names the token it wants back. */
const NONCE_PATTERN = /and nothing else:\s*(\S+)\s+followed by/;

export interface OracleOptions {
  /** Must match the id of the target being measured, or `verify` finds no file. */
  readonly id?: string;
  readonly display?: string;
  /**
   * The instruction file this backend reads.
   *
   * Absent means the backend has no file and answers only from
   * {@link TurnRequest.system} — the shape `ollama` has.
   */
  readonly path?: string;
}

/** Everything the channel carried, as one answer. */
export function channelOracle(options: OracleOptions = {}): ExecBackend {
  const id = options.id ?? "claude";
  const path = options.path;

  return {
    id,
    display: options.display ?? `${id} (channel oracle)`,
    kind: "cli",
    identityStrength: path === undefined ? "system" : "user",

    available(): Promise<Availability> {
      return Promise.resolve({ ok: true, detail: "synthetic backend — always available" });
    },

    async run(request: TurnRequest): Promise<TurnResult> {
      const nonce = request.prompt.match(NONCE_PATTERN)?.[1] ?? "";

      // The system field wins when there is one, because that is what `verify`
      // hands a backend whose channel is the request. A file-channel backend is
      // given no system text at all, and reads the file the way a CLI would.
      let channel = request.system;
      if (channel === undefined && path !== undefined) {
        channel = await readFile(path, "utf8").catch(() => undefined);
      }

      const text =
        channel === undefined || channel.trim().length === 0
          ? `${nonce} unknown`
          : `${nonce} ${channel}`;

      return {
        backend: id,
        text,
        confidence: classify(text, 0),
        identityStrength: path === undefined ? "system" : "user",
        evidence: {
          source: id,
          prompt: request.prompt,
          raw: text,
          exitCode: 0,
        },
      };
    },
  };
}
