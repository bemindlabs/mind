// D-156 — a held action waits for the owner's answer instead of being refused outright.
//
// When D-153's list holds an action (record.cjs) and the container was started for a task that can ask
// (`MIND_APPROVAL_WAIT` > 0 and a release public key), the action is not refused: it is written to
// /out/pending/<id>.json — what kind of step, on which element, on which origin, which rules held it; never a
// typed value — and the click, keystroke or dialog answer waits there. mind (the task's runner on the host)
// files it as a pending approval the web page, the app and `mind task approve|deny` show.
//
// The answer comes back as /out/release/<id>.json, written by mind on the host:
//   { id, digest, verdict: "approve" | "deny", sig }
// It is taken only when
// - its id is this action's, and its digest is the digest *this process* computed of the action when it held
//   it (not the digest in the pending file, which is only a copy) — so a yes is bound to exactly that step;
// - its sig is an Ed25519 signature over the id, the digest and the verdict that verifies with the task's
//   release **public** key (review of PR #24, round 3). The private key never leaves the task's runner — a
//   process that is not dumpable — so nothing in this container, and nothing that can read this container's
//   files from the host, holds anything that could sign: a file that was not signed by the runner is not an
//   answer;
// - it arrives before the wait ends (`expiresAt`, and a few seconds' grace for a yes written just in time).
// It is renamed to <id>.used before anything is done with it, and this process waits on each id once: one
// approval releases one action, once. No answer in time is a no.
//
// D-160 (the owner, 2026-10-05): a credential — typing into a password field, submitting a form that holds
// one, answering a password-like prompt — is never released, and the owner cannot approve one, until a store
// exists that fills values without the model seeing them. Such an action is written to /out/pending with
// `approvable: false`, so every channel shows it ("not allowed yet"), and refused at once: no wait.
//
// Pure apart from the file and clock functions it is handed, so test/task/approvals.test.ts runs it in Bun.
"use strict";

const { createHash, createPublicKey, randomUUID, verify } = require("node:crypto");

const SCHEMA = "mind/held-action@1";
const GRACE_MS = 5000;
/** The fields of an action that say what it is; any other (a value, above all) never leaves this process. */
const FIELDS = ["kind", "origin", "path", "role", "text", "inputType", "valueClass", "key", "submits", "formRole", "submitsForm", "formHasPassword", "formAction", "formMethod", "href", "context", "frameOrigin", "framePath"];

/** The action as an approval names it. */
function descriptorOf(action) {
  const out = {};
  for (const field of FIELDS) {
    const value = action[field];
    if (value === undefined || value === null) continue;
    out[field] = typeof value === "string" ? value.slice(0, 300) : value;
  }
  return out;
}

/** Words that say a field is a password, in the languages D-153's list knows (D-160's strong signal). */
const STRONG_WORDS = "(password|passphrase|passcode|passwort|kennwort|mot de passe|contraseña|wachtwoord|hasło|senha|パスワード|密码|密碼|비밀번호|รหัสผ่าน)";

/**
 * D-160, as tightened after the second review of PR #24: never released — not even with a yes — only on a
 * strong signal: submitting a form that holds a password field (or whose password field already holds something), typing a password, a one-time code or a secret
 * (by the field itself: ever type=password, masked, autocomplete, a name that says so), or typing into a field
 * whose label says password. Other credential-looking steps (a "PIN" label, a field that may take a code,
 * "Sign in") ask, like any held action. The host keeps the same rule (`neverReleased` in
 * src/task/approvals.ts, held equal by test/task/approvals.test.ts).
 */
function neverReleased(descriptor, rules) {
  if (rules.includes("credentials.login-submit") || rules.includes("credentials.filled-password")) return true;
  if (["password", "otp", "secret"].includes(descriptor.valueClass)) return true;
  return ["type", "fill", "dialog-type"].includes(descriptor.kind) && new RegExp(STRONG_WORDS, "iu").test(String(descriptor.text ?? ""));
}

/** Keys sorted, no whitespace: the same bytes for the same action, on both sides. */
function canonical(descriptor) {
  return JSON.stringify(Object.fromEntries(Object.keys(descriptor).sort().map((key) => [key, descriptor[key]])));
}

function digestOf(descriptor) {
  return `sha256:${createHash("sha256").update(canonical(descriptor)).digest("hex")}`;
}

/** What a release signs: the action's id, its digest and the verdict. */
function releaseMessage(id, digest, verdict) {
  return Buffer.from(`mind-release\n${id}\n${digest}\n${verdict}`);
}

/** Does `sig` (base64) verify for this release under `publicKey` (base64 SPKI DER, Ed25519)? */
function verifyRelease(publicKey, id, digest, verdict, sig) {
  if (typeof sig !== "string" || typeof publicKey !== "string") return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, releaseMessage(id, digest, verdict), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/**
 * Hold `action` until the owner answers. Resolves `{ verdict: "approve" }` when it may go ahead (once), or
 * `{ verdict: "deny" | "expired" | "invalid" | "no-channel" }` when it may not.
 *
 * io: { now(), sleep(ms), write(path, text), exists(path), read(path), rename(from, to), log(line), id() }.
 */
async function waitForRelease(action, classification, settings, io) {
  const { waitSeconds, publicKey, dir = "/out", follows } = settings;
  if (!(waitSeconds > 0) || typeof publicKey !== "string" || publicKey.length < 40) return { verdict: "no-channel" };
  const id = `a-${io.id ? io.id() : randomUUID()}`;
  const descriptor = descriptorOf(action);
  const digest = digestOf(descriptor);
  const filedAt = io.now();
  const expiresAt = filedAt + waitSeconds * 1000;
  const credential = neverReleased(descriptor, classification.rules ?? []);
  io.write(
    `${dir}/pending/${id}.json`,
    `${JSON.stringify({
      schema: SCHEMA,
      id,
      action: descriptor,
      digest,
      rules: classification.rules,
      categories: classification.categories ?? [],
      reasons: classification.reasons,
      filedAt: new Date(filedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      ...(credential ? { approvable: false } : {}),
      // D-159: the released action this one came right after, on the same page — shown as a pair, not bound.
      ...(typeof follows === "string" ? { follows } : {}),
    })}\n`,
  );
  if (credential) {
    io.log({ id, answered: "not-allowed", rules: classification.rules });
    return { verdict: "not-allowed", id, digest };
  }
  io.log({ id, waiting: true, kind: descriptor.kind, origin: descriptor.origin, rules: classification.rules });
  const release = `${dir}/release/${id}.json`;
  while (io.now() < expiresAt + GRACE_MS) {
    if (io.exists(release)) {
      let answer = null;
      try {
        answer = JSON.parse(io.read(release));
      } catch {
        answer = null;
      }
      // Taken before it is acted on: an answer is used once.
      try {
        io.rename(release, `${dir}/release/${id}.used`);
      } catch {
        // Already taken by nobody else (this process is the only reader): carry on with what was read.
      }
      const verdict = answer !== null && (answer.verdict === "approve" || answer.verdict === "deny") ? answer.verdict : null;
      const valid = verdict !== null && answer.id === id && answer.digest === digest && verifyRelease(publicKey, id, digest, verdict, answer.sig);
      const outcome = valid ? verdict : "invalid";
      io.log({ id, answered: outcome });
      return { verdict: outcome, id, digest };
    }
    await io.sleep(250);
  }
  io.log({ id, answered: "expired" });
  return { verdict: "expired", id, digest };
}

module.exports = { SCHEMA, GRACE_MS, FIELDS, STRONG_WORDS, neverReleased, descriptorOf, canonical, digestOf, releaseMessage, verifyRelease, waitForRelease };
