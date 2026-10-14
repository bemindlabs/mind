// Recording, and D-153's always-pause list, for every page the MCP server opens
// (D-151) — independent of what the model asks for.
//
// Recording:
// - a Playwright trace per browser context, named per context, started with
//   `live: true` so the action log, DOM snapshots, screencast frames and
//   network log are written as they happen and survive a `docker kill`;
// - a full-page screenshot after every load, in <out>/screens.
//
// Sensitive actions (src/decide/sensitive.ts, bundled here as sensitive.cjs):
// before Playwright touches an element — click, type/fill, press, check,
// select, upload — or the keyboard types into the focused element, the action
// is described — read through CDP in an isolated world, never in the page's
// own JavaScript (cdp-read.cjs; describe.cjs: kind, the element's role and accessible text,
// the kind of value being typed — never the value — the form it is in and
// where it goes) and handed to `classifyAction`. Paying, sending, deleting,
// credentials, accepting terms: **held**. So is a form's submit control — a
// click, a key or a check on it, whatever its label says — and any click
// inside a form that does not GET (TASK-01); a submit control is a button whose
// type is not button, reset or menu, or an input of type submit or image. A
// held action is recorded in <out>/held.jsonl with the kind, the rule ids and
// the reasons, never a value. An element that cannot be described is held too
// (the list errs towards stopping).
// Not held, because the list sees the element and not the script behind it: a
// click on a control that is not a form's submit and is not in a POST form (a
// `type=button`, or a link, that a script wires to a purchase) unless its words
// are on the list, and a Tab or an Escape on a submit control, which cannot
// activate it. src/decide/sensitive.ts says the same in its header.
//
// What a held action does next (D-156, release.cjs): in a container started
// for a task (MIND_APPROVAL_WAIT > 0 and the task's release public key), it pauses
// and waits for the owner's answer to that exact action, and goes ahead once
// on a yes. A no, an answer that does not verify, or no answer in time: it does
// not happen, and the model is told which. A credential is never released
// (D-160). In a container started by hand there is nobody to ask: refused at
// once. After a yes the element — or, for keystrokes, the focused element — is
// described again; if anything about it changed, it is not the action that was
// approved, and it does not happen.
//
// Dialogs (re-review of PR #19, round 3): accepting a page's `confirm` or
// `prompt` is an action too, classified like any other step:
// - `confirm` (and any type this file does not know): a `submit` whose text is
//   the message — held at every level;
// - `prompt`: typing into a field labelled with the message, its value class
//   inferred from the message — held when the list flags it;
// - `alert` and `beforeunload`: allowed.
// A held dialog is dismissed (always allowed) so the page is not left wedged.
// D-159: a confirm held right after a released action on the same page names
// that action (`follows`), so the owner sees the two as a pair.
//
// Navigation (defence in depth behind the guard's URL check): `page.goto` is
// refused for anything but http:, https: and about:blank.
//
// If anything is ever typed into a password field anyway, that context's
// trace is stopped first and not restarted.
//
// Files are 600 and directories 700: the entrypoint's umask, and modes here.
// Paths and the key file can be pointed elsewhere by the environment, which is
// how test/browser/record.test.ts runs this file in Bun against a fake page.
"use strict";

const { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { classifyAction } = require("./sensitive.cjs");
const { descriptorOf, digestOf, waitForRelease } = require("./release.cjs");
const { readerFor } = require("./cdp-read.cjs");

/**
 * How the page is read (cdp-read.cjs): through CDP, in an isolated world, never in the page's own JavaScript.
 * Swappable only for test/browser/record.test.ts.
 */
let readerOf = (page) => readerFor(page);

/** How long the page is given to be read. A page stuck in a script answers nothing: read as "cannot say". */
const READ_MS = 3000;

async function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

const OUT = process.env.MIND_OUT || "/out";
// The task's release *public* key (review of PR #24, round 3): enough to check that a release was signed by the
// task's runner, nothing that could sign one. Public, so it may sit in the environment.
const PUBLIC_KEY = process.env.MIND_RELEASE_PUBKEY || "";
const WAIT_SECONDS = Math.max(0, Math.min(3600, Number(process.env.MIND_APPROVAL_WAIT || "0") || 0));
/** How soon after a released action a dialog on the same page counts as that action's (D-159). */
const PAIR_WINDOW_MS = 10_000;

const RELEASE_IO = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write: (path, text) => {
    mkdirSync(`${OUT}/pending`, { recursive: true, mode: 0o700 });
    mkdirSync(`${OUT}/release`, { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  },
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf8"),
  rename: (from, to) => renameSync(from, to),
  log: (line) => {
    mkdirSync(OUT, { recursive: true, mode: 0o700 });
    appendFileSync(`${OUT}/held.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
  },
};

const ANSWERED = {
  deny: "the owner said no (D-156). Do not try it again, or another way; carry on without it, or finish and say what is left.",
  expired: "nobody answered in time, which counts as no (D-156). Do not try it another way.",
  "not-allowed":
    "a password or another credential is never entered for you yet — not even with a yes — until a store exists that fills it without the model seeing it (D-160). Do not try it another way; finish and say what is left.",
  invalid: "the answer that came back could not be verified, so it counts as no (D-156).",
  changed: "the page changed while it waited, so this is not the action that was approved (D-156). Ask again if it is still needed.",
};

/** The last action released, and on which page: what a dialog right after it is paired with (D-159). */
let lastReleased = null;
/** Per dialog: the released action it opened right after, decided when it opened (not when it is answered). */
const dialogFollows = new WeakMap();

/** Hold an action the list flagged: wait for the owner's answer where a task can ask, refuse it where not. */
async function ask(action, classification, recheck, pageOf, follows) {
  const answer = await waitForRelease(action, classification, { waitSeconds: WAIT_SECONDS, publicKey: PUBLIC_KEY, dir: OUT, follows }, RELEASE_IO);
  if (answer.verdict === "no-channel") throw held(action, classification);
  if (answer.verdict !== "approve") throw held(action, classification, ANSWERED[answer.verdict] ?? ANSWERED.invalid);
  if (recheck !== undefined) {
    const now = await recheck();
    if (now === null || digestOf(descriptorOf(now)) !== answer.digest) {
      RELEASE_IO.log({ id: answer.id, answered: "changed" });
      throw held(action, classification, ANSWERED.changed);
    }
  }
  RELEASE_IO.log({ id: answer.id, released: true });
  lastReleased = { id: answer.id, page: pageOf, at: Date.now() };
}

let sequence = 0;
let traces = 0;
const contexts = new WeakMap();
const patchedProtos = new WeakSet();
const patchedKeyboards = new WeakSet();


/** What an action is aimed at, from what the page said about its element — and the page's own address. */
function targetOf(page, info) {
  const target = {
    path: pathOf(page),
    role: info.role,
    text: info.text,
    submitsForm: info.submitsForm,
    formHasPassword: info.formHasPassword,
  };
  if (info.type !== undefined && info.type !== "") target.inputType = info.type;
  for (const field of ["formRole", "formAction", "formMethod", "href", "context", "frameOrigin", "framePath"]) {
    if (info[field] !== undefined && info[field] !== "") target[field] = info[field];
  }
  return target;
}

/** The page's path, query and fragment. */
function pathOf(page) {
  try {
    const url = new URL(page.url());
    return url.pathname + url.search + url.hash;
  } catch {
    return "";
  }
}

function valueClassOf(info) {
  if (info.secret === "password" || info.secret === "otp") return info.secret;
  if (info.autocomplete.includes("cc-")) return "card";
  if (info.autocomplete.includes("one-time-code")) return "otp";
  if (info.autocomplete.includes("password") || info.type === "password") return "password";
  const byType = { email: "email", tel: "phone", url: "url", number: "number", date: "date", search: "search", file: "file" };
  return byType[info.type] || "text";
}

function origin(page) {
  try {
    return new URL(page.url()).origin;
  } catch {
    return "";
  }
}

function held(action, classification, answered) {
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  appendFileSync(
    `${OUT}/held.jsonl`,
    `${JSON.stringify({ at: new Date().toISOString(), kind: action.kind, origin: action.origin, role: action.role, rules: classification.rules, reasons: classification.reasons })}\n`,
    { mode: 0o600 },
  );
  const error = new Error(
    `mind held this action: ${classification.reasons.join("; ") || classification.rules.join(", ")}. ` +
      (answered === undefined
        ? "It waits for a person's yes (D-153), and this browser was started with no way to ask for one."
        : `It did not happen: ${answered}`),
  );
  error.name = "MindHeld";
  return error;
}

async function stopTrace(context, why) {
  const state = contexts.get(context);
  if (state === undefined || state.stopped) return;
  state.stopped = true;
  try {
    await context.tracing.stop();
  } catch {
    // Already stopped or closing: either way nothing more is recorded.
  }
  mkdirSync(`${OUT}/trace`, { recursive: true, mode: 0o700 });
  writeFileSync(
    `${OUT}/trace/${state.name}.stopped.txt`,
    `${new Date().toISOString()} trace ${state.name} stopped before ${why}; nothing after this point was recorded for this context.\n`,
    { mode: 0o600 },
  );
}

/**
 * Two kinds of step the list does not hold on its own, held here — to *ask* (they are not D-160's "never"),
 * after the second review of PR #24:
 * - typing into a field that may take a one-time code or a PIN (`maybeCode`: pin/otp/code in its name with a
 *   numeric shape, a one-box numeric field) — not a ZIP, a promo code or a quantity;
 * - a clickable in a form that holds a password field — a "Continue" div with role=button, or one joined with
 *   form= — whatever it says.
 */
function alsoAsk(classification, info, kind, extra = {}) {
  // Review of PR #24, round 3: a form whose password field already holds something (dragged or pasted in, or
  // put there by the page) is never submitted — by a control in it, or by Enter in one of its fields (D-160).
  const enter = kind === "press" && /(?:^|[^a-z])(?:enter|return|numpadenter)$/iu.test(String(extra.key ?? ""));
  if (info.passwordFilled === true && (((kind === "click" || kind === "press") && info.clickable === true) || info.submitsForm === true || enter || extra.submits === true)) {
    return withFilledPassword(classification);
  }
  if (classification.sensitive) return classification;
  if (info.maybeCode === true && (kind === "fill" || kind === "type" || kind === "press")) {
    return { sensitive: true, categories: [], rules: ["code.maybe"], reasons: ["this field may take a one-time code or a PIN, so it waits for a yes"] };
  }
  if (info.clickable === true && info.formHasPassword === true && (kind === "click" || kind === "press")) {
    return { sensitive: true, categories: [], rules: ["form.password-control"], reasons: ["it is a control in a form that holds a password field, so it waits for a yes"] };
  }
  return classification;
}

/** Classify, hold what the list holds, and stop the trace before any password typing. */
async function check(page, info, kind, extra, recheck) {
  const action = {
    kind,
    origin: origin(page),
    ...(info === null ? {} : targetOf(page, info)),
    ...extra,
  };
  // Nothing could be read about the element: the list errs towards stopping.
  let classification = info === null
    ? { sensitive: true, rules: ["undescribed-element"], reasons: ["the element could not be described, so it waits for a yes"] }
    : alsoAsk(classifyAction(action), info, kind, extra);
  if (submitLike(kind, extra, info) && (await passwordFilledAnywhere(page))) classification = withFilledPassword(classification);
  if (info !== null && printableKeys(kind, extra, info)) classification = withNotTextField(classification);
  if (action.valueClass === "password") await stopTrace(page.context(), "typing into a password field");
  if (classification.sensitive) {
    // Nothing could be described: there is nothing an owner could say yes to.
    if (info === null) throw held(action, classification);
    await ask(
      action,
      classification,
      recheck === undefined ? undefined : async () => {
        const again = await recheck();
        return again === null ? null : { ...action, ...again };
      },
      page,
    );
  }
}

/** How each kind finds the element it really acts on (describe.cjs, as Playwright's own retargeting). */
const RETARGET = { click: "click", check: "click", select: "fill", upload: "none" };

/**
 * A step that can submit, send or commit something: any click, check, select, drag or upload; Enter, or any
 * key on a control; typing that ends in Enter; a dialog's accept. Typing into a field, or another key there,
 * is not.
 */
function submitLike(kind, extra, info) {
  if (kind === "fill" || kind === "type") return extra.submits === true;
  if (kind === "press") {
    const enter = /(?:^|[^a-z])(?:enter|return|numpadenter)$/iu.test(String(extra.key ?? ""));
    return enter || (info !== null && info.clickable === true);
  }
  return true;
}

/**
 * Review of PR #24, round 4: does any password field in this page — any frame, open shadow roots included —
 * hold anything? A frame that cannot be asked (and is not gone) counts as yes.
 */
async function passwordFilledAnywhere(page) {
  // No answer in time (a page stuck in a script), an error, a frame that cannot be read: all count as yes.
  const answer = (await within(readerOf(page).passwordFilled(), FILLED_ASK_MS, true)) !== false;
  lastFilled.set(page, answer);
  return answer;
}

/** How long a frame is given to say whether a password field holds something. */
const FILLED_ASK_MS = 3000;

/**
 * Per page, what the last check found. A dialog is judged by it: while a dialog is open the page runs no
 * script, so it cannot be asked then. A page never checked counts as holding one.
 */
const lastFilled = new WeakMap();

/**
 * Default deny for keys (review of PR #24, last round): typing, inserted text, or a printable key (pasting
 * with Control+V included) whose target — after following focus down through frames and shadow roots — is not
 * itself a text field asks for a yes. Where keys go inside such an element (a closed shadow root, for one)
 * cannot be read. Tab, arrows, Escape and other keys that print nothing, and Enter or Space on a button or a
 * link, are left as they were.
 */
function printableKeys(kind, extra, info) {
  if (info.textEntry === true) return false;
  if (kind === "type" || kind === "fill") return true;
  if (kind !== "press") return false;
  const key = String(extra.key ?? "");
  const last = key.includes("+") && key.length > 1 ? key.slice(key.lastIndexOf("+") + 1) || "+" : key;
  const space = last === " " || last === "Space";
  if (space && ["button", "link", "checkbox", "radio", "switch", "menuitem", "tab", "option"].includes(String(info.role))) return false;
  return space || [...last].length === 1;
}

function withNotTextField(classification) {
  if (classification.rules.includes("keys.not-a-text-field")) return classification;
  return {
    sensitive: true,
    categories: classification.categories ?? [],
    rules: [...classification.rules, "keys.not-a-text-field"],
    reasons: [...classification.reasons, "the keys would go to something that is not a text field, and where they land inside it cannot be read, so it waits for a yes"],
  };
}

/** D-160: submitting anything while a password field on the page holds something is never done for you. */
const FILLED_PASSWORD = {
  rule: "credentials.filled-password",
  reason: "a password field on this page already holds something, and this step could send it — never done for you (D-160)",
};

function withFilledPassword(classification) {
  return {
    sensitive: true,
    categories: [...new Set([...(classification.categories ?? []), "credentials"])],
    rules: [...new Set([...classification.rules, FILLED_PASSWORD.rule])],
    reasons: [...classification.reasons, FILLED_PASSWORD.reason],
  };
}

const LOCATOR_KINDS = {
  click: "click",
  dblclick: "click",
  tap: "click",
  fill: "fill",
  type: "type",
  pressSequentially: "type",
  press: "press",
  check: "check",
  uncheck: "check",
  setChecked: "check",
  selectOption: "select",
  setInputFiles: "upload",
};

/** What a kind carries besides its target: the value class of what is typed, the key pressed. */
function extraFor(kind, info, args) {
  const extra = {};
  if (kind === "fill" || kind === "type") {
    if (info !== null) extra.valueClass = valueClassOf(info);
    extra.submits = false;
  }
  if (kind === "press") {
    extra.key = String(args[0] ?? "");
    if (info !== null) extra.valueClass = valueClassOf(info);
  }
  return extra;
}

function allowedUrl(raw) {
  if (String(raw).trim() === "about:blank") return true;
  try {
    const url = new URL(String(raw).trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function patchNavigation(page) {
  const proto = Object.getPrototypeOf(page);
  if (proto.__mindGoto === true) return;
  const original = proto.goto;
  proto.goto = async function (url, ...rest) {
    if (!allowedUrl(url)) {
      const error = new Error("mind refused this URL: only http:, https: and about:blank are opened");
      error.name = "MindRefusedUrl";
      throw error;
    }
    return original.call(this, url, ...rest);
  };
  proto.__mindGoto = true;
}

/** The value class a prompt's message asks for. Never the value itself. */
function promptValueClass(message) {
  const text = String(message).toLowerCase();
  if (/(pass(word|phrase|code)?|รหัสผ่าน|\bpin\b|passwort|kennwort|mot de passe|contraseña|パスワード|密码|密碼|비밀번호)/u.test(text)) return "password";
  if (/(one[- ]time|otp|verification code|2fa|two[- ]factor|รหัสยืนยัน|验证码|驗證碼|認証コード|인증)/u.test(text)) return "otp";
  if (/(card number|credit card|cvv|cvc|expiry|บัตร)/u.test(text)) return "card";
  if (/(secret|token|api key|private key|recovery)/u.test(text)) return "secret";
  if (/e-?mail/u.test(text)) return "email";
  return "text";
}

/** Describe accepting this dialog as a step D-153's list can judge, or null when accepting is harmless. */
function dialogAction(page, dialog) {
  const type = typeof dialog.type === "function" ? dialog.type() : "";
  const message = typeof dialog.message === "function" ? String(dialog.message()).slice(0, 300) : "";
  if (type === "alert" || type === "beforeunload") return null;
  if (type === "prompt") {
    return { kind: "type", origin: origin(page), path: pathOf(page), role: "textbox", text: message, valueClass: promptValueClass(message), submits: false };
  }
  // confirm, and any type not known here: accepting commits whatever the page asked.
  return { kind: "submit", origin: origin(page), path: pathOf(page), role: "button", text: message };
}

function patchDialogs(page) {
  page.on("dialog", (dialog) => {
    // D-159: paired when it opens — on the page of the action just released, within the window — so a model
    // that takes its time to answer it does not lose the pair, and a later dialog never gains one.
    const opened = Date.now();
    if (lastReleased !== null && lastReleased.page === page && opened - lastReleased.at <= PAIR_WINDOW_MS && !dialogFollows.has(dialog)) {
      dialogFollows.set(dialog, lastReleased.id);
      lastReleased = null;
    }
    const proto = Object.getPrototypeOf(dialog);
    if (patchedProtos.has(proto)) return;
    patchedProtos.add(proto);
    const original = proto.accept;
    proto.accept = async function (...args) {
      // The dialog's own page, not the first tab's (review of PR #24, finding 7).
      const own = (typeof this.page === "function" ? this.page() : null) || page;
      const action = dialogAction(own, this);
      if (action !== null) {
        if (action.valueClass === "password" || action.valueClass === "otp" || action.valueClass === "secret") {
          await stopTrace(own.context(), `answering a prompt that asks for a ${action.valueClass}`);
        }
        let classification = classifyAction(action);
        // Not asked now — the page is stopped on this dialog, and would never answer (see lastFilled).
        if (action.kind === "submit" && lastFilled.get(own) !== false) classification = withFilledPassword(classification);
        if (classification.sensitive) {
          try {
            // The dialog stays open while it waits (Playwright MCP has cleared its modal state already).
            await ask({ ...action, kind: `dialog-${action.kind}` }, classification, undefined, own, dialogFollows.get(this));
          } catch (error) {
            // Not left open: a held dialog is dismissed, which is always allowed.
            await this.dismiss().catch(() => undefined);
            throw error;
          }
        }
      }
      return original.apply(this, args);
    };
  });
}

/** The keyboard's own methods, before patchKeyboard: what a locator step uses once it has been checked. */
const rawKeyboards = new WeakMap();

function rawKeyboard(page) {
  return rawKeyboards.get(page.keyboard) ?? page.keyboard;
}

/** Where Playwright's pointer lands on this locator: the centre of its box, or the `position` asked for. */
async function pointOf(locator, options) {
  if (typeof locator.scrollIntoViewIfNeeded === "function") await locator.scrollIntoViewIfNeeded({ timeout: READ_MS }).catch(() => undefined);
  const box = await locator.boundingBox({ timeout: READ_MS }).catch(() => null);
  if (box === null || box === undefined) return null;
  const position = options !== null && typeof options === "object" ? options.position : undefined;
  return {
    x: box.x + (position !== undefined && Number.isFinite(position.x) ? position.x : box.width / 2),
    y: box.y + (position !== undefined && Number.isFinite(position.y) ? position.y : box.height / 2),
  };
}

/** The element a pointer step on this locator reaches, read at the point it lands (cdp-read.cjs). */
async function readAt(locator, kind, options) {
  const point = await pointOf(locator, options);
  if (point === null) return null;
  return within(readerOf(locator.page()).at(point.x, point.y, RETARGET[kind] ?? "none"), READ_MS, null);
}

/** The options argument of each locator method that takes a pointer position. */
const OPTIONS_AT = { click: 0, dblclick: 0, tap: 0, check: 0, uncheck: 0, setChecked: 1, selectOption: 1, setInputFiles: 1 };

/** Inputs Playwright's `fill` sets a value on instead of typing it in. */
const SET_VALUE_TYPES = ["color", "date", "time", "datetime-local", "month", "range", "week"];

function patchLocators(page) {
  const proto = Object.getPrototypeOf(page.locator("html"));
  if (patchedProtos.has(proto)) return;
  patchedProtos.add(proto);
  const originals = {};
  for (const name of ["focus", "selectText"]) originals[name] = proto[name];
  for (const [method, kind] of Object.entries(LOCATOR_KINDS)) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = async function (...args) {
      const page_ = this.page();
      // Keys and filled text go where focus is once Playwright has focused the element, so it is focused here
      // first (Playwright's own focus, in its own world) and focus is then read — through every shadow root and
      // frame — from outside the page's JavaScript. A pointer step is read at the point it lands. (Review of
      // PR #24, last round: nothing about an element is read in the page's world any more.)
      const read =
        kind === "fill"
          ? async () => {
              // As Playwright's fill: the element focused (a host delegates focus inward), then its text — a
              // label's control's — selected and focused. Either may not apply; focus is read after both.
              const focusing = await originals.focus.call(this, { timeout: READ_MS }).then(() => true, () => false);
              const selecting = await originals.selectText.call(this, { timeout: READ_MS }).then(() => true, () => false);
              if (!focusing && !selecting) return null;
              return within(readerOf(page_).focused(), READ_MS, null);
            }
          : kind === "type" || kind === "press"
            ? async () => {
                try {
                  await originals.focus.call(this, { timeout: READ_MS });
                } catch {
                  return null;
                }
                return within(readerOf(page_).focused(), READ_MS, null);
              }
            : () => readAt(this, kind, args[OPTIONS_AT[method] ?? 0]);
      const info = await read();
      // After a yes: the element read again — where it goes, its role and text, and what kind of value it takes
      // now (review of PR #24, finding 4).
      const recheck = async () => {
        const now = await read();
        return now === null ? null : { origin: origin(page_), ...targetOf(page_, now), ...extraFor(kind, now, args) };
      };
      await check(page_, info, kind, extraFor(kind, info, args), recheck);
      // Keys and text are sent to what was just checked — not through a second focus the page could redirect.
      const keys = rawKeyboard(page_);
      if (kind === "press") return keys.press(args[0], args[1]);
      if (kind === "type") return keys.type(args[0], args[1]);
      if (kind === "fill") {
        const latest = await within(readerOf(page_).focused(), READ_MS, null);
        if (latest !== null && latest.tag === "input" && SET_VALUE_TYPES.includes(latest.type)) return original.apply(this, args);
        const value = String(args[0] ?? "");
        return value === "" ? keys.press("Delete") : keys.insertText(value);
      }
      return original.apply(this, args);
    };
  }
}

/**
 * A drop is judged by where it lands (review of PR #24, round 3): onto something text can go into it is typing,
 * with that field's value class — so a drop onto a password field is D-160's "never" — and onto anything else
 * it is a "drag", a kind the list does not know, so it waits for a yes.
 */
function dropAction(info) {
  if (info === null) return { kind: "drag", extra: {} };
  return info.editable === true ? { kind: "type", extra: { valueClass: valueClassOf(info), submits: false } } : { kind: "drag", extra: {} };
}

/** `browser_drag` is `locator.dragTo(target)`: the target is described, not the source. */
function patchDrag(page) {
  const proto = Object.getPrototypeOf(page.locator("html"));
  if (proto.__mindDrag === true) return;
  proto.__mindDrag = true;
  const original = proto.dragTo;
  if (typeof original !== "function") return;
  proto.dragTo = async function (target, ...rest) {
    // Where it is dropped: the target's centre, or the position asked for, read at that point.
    const read = () => readAt(target, "select", rest[0] !== null && typeof rest[0] === "object" && rest[0].targetPosition !== undefined ? { position: rest[0].targetPosition } : undefined);
    const info = await read();
    const { kind, extra } = dropAction(info);
    const recheck = async () => {
      const now = await read();
      return now === null ? null : { origin: origin(this.page()), ...targetOf(this.page(), now), ...dropAction(now).extra, kind: dropAction(now).kind };
    };
    await check(this.page(), info, kind, extra, recheck);
    return original.call(this, target, ...rest);
  };
  // The page's own selector form goes the same way.
  const pageProto = Object.getPrototypeOf(page);
  if (pageProto.__mindDrag !== true) {
    pageProto.__mindDrag = true;
    pageProto.dragAndDrop = async function (source, target, options) {
      return this.locator(source).dragTo(this.locator(target), options);
    };
  }
}

/**
 * The mouse by coordinates (no served tool drives it today; patched so none can by accident): a button let go
 * after a move is a drop where it lands, and a click is a click on what is under the point.
 */
function patchMouse(page) {
  const mouse = page.mouse;
  if (mouse === undefined || patchedKeyboards.has(mouse)) return;
  patchedKeyboards.add(mouse);
  let at = { x: 0, y: 0 };
  let down = false;
  const under = (x, y) => within(readerOf(page).at(Number(x), Number(y), "click"), READ_MS, null);
  const wrap = (method, before) => {
    const original = mouse[method];
    if (typeof original !== "function") return;
    mouse[method] = async function (...args) {
      await before(...args);
      return original.apply(this, args);
    };
  };
  wrap("move", async (x, y) => {
    at = { x: Number(x), y: Number(y) };
  });
  wrap("down", async () => {
    down = true;
  });
  wrap("up", async () => {
    if (!down) return;
    down = false;
    const info = await under(at.x, at.y);
    const { kind, extra } = dropAction(info);
    await check(page, info, kind, extra, async () => {
      const now = await under(at.x, at.y);
      return now === null ? null : { origin: origin(page), ...targetOf(page, now), ...dropAction(now).extra, kind: dropAction(now).kind };
    });
  });
  for (const method of ["click", "dblclick"]) {
    wrap(method, async (x, y) => {
      at = { x: Number(x), y: Number(y) };
      const info = await under(x, y);
      await check(page, info, "click", {}, async () => {
        const now = await under(x, y);
        return now === null ? null : { origin: origin(page), ...targetOf(page, now) };
      });
    });
  }
}

function patchKeyboard(page) {
  const keyboard = page.keyboard;
  if (patchedKeyboards.has(keyboard)) return;
  patchedKeyboards.add(keyboard);
  const raw = {};
  rawKeyboards.set(keyboard, raw);
  // Where keys go: focus read from outside the page's JavaScript, through every shadow root and frame.
  const focused = () => within(readerOf(page).focused(), READ_MS, null);
  for (const method of ["type", "insertText", "press", "down", "up"]) {
    const original = keyboard[method];
    if (typeof original !== "function") continue;
    raw[method] = (...args) => original.apply(keyboard, args);
    if (method === "up") continue;
    keyboard[method] = async function (...args) {
      const info = await focused();
      const kind = method === "press" || method === "down" ? "press" : "type";
      const extra = { ...(info === null ? {} : { valueClass: valueClassOf(info) }), ...(kind === "press" ? { key: String(args[0] ?? "") } : { submits: false }) };
      // Keystrokes go to whatever has focus when they are released, so the focused element is described again
      // after a yes and has to be the same (review of PR #24, finding 3).
      const recheck = async () => {
        const now = await focused();
        return now === null ? null : { origin: origin(page), ...targetOf(page, now), valueClass: valueClassOf(now) };
      };
      await check(page, info, kind, extra, recheck);
      return original.apply(this, args);
    };
  }
}

exports.default = async function record({ page }) {
  const context = page.context();
  if (!contexts.has(context)) {
    traces += 1;
    const name = `trace-${String(traces).padStart(2, "0")}-${Date.now()}`;
    contexts.set(context, { name, stopped: false });
    await context.tracing.start({ name, screenshots: true, snapshots: true, live: true });
  }
  patchNavigation(page);
  patchDialogs(page);
  patchLocators(page);
  patchKeyboard(page);
  patchDrag(page);
  patchMouse(page);
  mkdirSync(`${OUT}/screens`, { recursive: true, mode: 0o700 });
  page.on("load", () => {
    sequence += 1;
    const name = `${OUT}/screens/${String(sequence).padStart(4, "0")}-${Date.now()}.png`;
    page.screenshot({ path: name, fullPage: true }).catch(() => undefined);
  });
};

// For test/browser/record.test.ts only: the same functions, driven against a fake page.
exports.__test = {
  setReader: (make) => {
    readerOf = make;
  },
  ask,
  check, printableKeys, submitLike, passwordFilledAnywhere, patchLocators, patchKeyboard, patchDialogs, patchDrag, patchMouse, dropAction, alsoAsk, valueClassOf, targetOf, extraFor, promptValueClass };
