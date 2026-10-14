// replycheck.ts — feed captured grok stdout through mind's own extractReply + classify (read-only import).
import { extractReply } from "<repo>/src/exec/cli-exec.ts";
import { classify } from "<repo>/src/exec/backend.ts";
import { VENDORS } from "<repo>/src/exec/registry.ts";
const W = import.meta.dir;
const grok = (VENDORS as any[]).find((v) => v.id === "grok");
for (const [run, exit] of process.argv.slice(2).map((a) => a.split(":"))) {
  const stdout = await Bun.file(`${W}/runs/${run}/stdout.json`).text();
  const reply = extractReply(grok, stdout);
  const conf = classify(reply, Number(exit));
  const isRawJson = reply.trimStart().startsWith("{");
  console.log(JSON.stringify({ run, exit: Number(exit), classify: conf, replyIsWholeJsonDocument: isRawJson, replyHead: reply.slice(0, 70) }));
}
