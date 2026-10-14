/**
 * A separate process for `lock.test.ts`, because the lock is between processes and a claim about it made
 * inside one process proves less than it says.
 *
 *   append <id> <start at ms>                     one ledger line for `alpha`, begun at the given instant
 *   hold   <dir> <ms>                             take the lock, print "held", keep it <ms>, let go
 *   crit   <dir> <marker> <start at ms> <grace> <rounds>
 *                                                 <rounds> times: take the lock and, inside it, create <marker>
 *                                                 exclusively — print "overlap" if it is already there — then
 *                                                 remove it
 *
 * Every line printed is one JSON object or one word, and the exit code is 0 unless the lock was not taken.
 * The ledger's machine facts come from `ledgerEnv()`, as they do in `turn`: the test hands this process a
 * temporary HOME and state directory, so that is where they point.
 */

import { open, unlink } from "node:fs/promises";
import { ledgerEnv } from "../../bin/shared.ts";
import { append, LEDGER_VERSION, LOCK_TIMING, withLock, type LedgerEntry } from "../../src/ledger/index.ts";
import { subjectId } from "../../src/types.ts";

const [mode, ...args] = process.argv.slice(2);

async function startAt(ms: string | undefined): Promise<void> {
  const wait = Number(ms) - Date.now();
  if (wait > 0) await Bun.sleep(wait);
}

try {
  if (mode === "append") {
    const [id, at] = args;
    // Long enough that two writes interleaving would show as a broken line.
    const prompt = `${id} `.repeat(1024);
    const entry = {
      v: LEDGER_VERSION,
      kind: "turn",
      id: id!,
      turn: `turn-${id}`,
      at: "2026-09-21T10:00:00.000Z",
      subject: subjectId("alpha"),
      backend: "ollama",
      model: null,
      content: "full",
      prompt,
      prompt_bytes: Buffer.byteLength(prompt),
      text: "answer",
      text_bytes: 6,
      confidence: "confirmed",
      exit: 0,
      duration_ms: 1,
      cost: null,
      identity: "system",
      soul_sha: null,
    } as unknown as LedgerEntry;
    await startAt(at);
    const began = performance.now();
    await append(ledgerEnv(), entry);
    console.log(JSON.stringify({ ok: true, id, ms: performance.now() - began }));
  } else if (mode === "hold") {
    const [dir, ms] = args;
    await withLock(
      dir!,
      async () => {
        console.log("held");
        await Bun.sleep(Number(ms));
      },
      LOCK_TIMING,
      ledgerEnv().machine,
    );
    console.log("released");
  } else if (mode === "crit") {
    const [dir, marker, at, grace, rounds] = args;
    await startAt(at);
    for (let round = 0; round < Number(rounds); round++) {
      await withLock(
        dir!,
        async () => {
          try {
            await (await open(marker!, "wx")).close();
          } catch {
            console.log("overlap");
            return;
          }
          await Bun.sleep(2);
          await unlink(marker!);
        },
        { ...LOCK_TIMING, graceMs: Number(grace) },
        ledgerEnv().machine,
      );
    }
    console.log("done");
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
