/**
 * `docker/browser/record.cjs` in Bun, against a fake page (review of PR #24, finding 8): the held action, the
 * owner's yes, and what is checked again before it is let through — a click's element, the focused element for
 * keystrokes — plus D-160's refusal, D-159's pairing and the dialog's own page (finding 7).
 *
 * The module reads where it writes and the runner's public key from the environment at load, so it is loaded
 * once here with those pointed at a temporary directory and a fresh key pair. The owner's yes is written as the
 * task's runner writes it: signed with the private key (`releaseSignature`), which never enters the container.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { releaseSignature } from "../../src/task/approvals.ts";
import { waitFor } from "../support/wait.ts";

// Each case waits on a file another async path writes; a loaded CI runner is slower than 5 s at that.
setDefaultTimeout(60_000);

const KEYS = generateKeyPairSync("ed25519");
const PUBLIC = KEYS.publicKey.export({ type: "spki", format: "der" }).toString("base64");
let dir = "";
let record: {
  __test: {
    patchLocators: (page: FakePage) => void;
    patchKeyboard: (page: FakePage) => void;
    patchDialogs: (page: FakePage) => void;
    patchDrag: (page: FakePage) => void;
    patchMouse: (page: FakePage) => void;
    setReader: (make: (page: FakePage) => unknown) => void;
    valueClassOf: (info: Record<string, unknown>) => string;
    promptValueClass: (message: string) => string;
  };
};

/** What the page says about an element; a test changes it while an action waits. */
type Info = Record<string, unknown>;
const BUTTON: Info = { tag: "button", type: "", autocomplete: "", role: "button", text: "Delete", submitsForm: true, formHasPassword: false, formAction: "/delete?id=A", formMethod: "post", context: "Note A" };
const FIELD: Info = { tag: "input", type: "text", autocomplete: "", role: "textbox", textEntry: true, text: "Message", submitsForm: false, formHasPassword: false, formAction: "/send", formMethod: "post" };

/**
 * A locator. Its box says which element a read at its point finds: 2000 the page's `element`, 3000 its own
 * (a drop target's `under`). Focusing it — Playwright's own focus, or `selectText` before a fill — makes it what
 * the reader says has focus.
 */
class FakeLocator {
  constructor(private owner: FakePage, private info?: Info) {}
  page(): FakePage {
    return this.owner;
  }
  async scrollIntoViewIfNeeded() {}
  async boundingBox() {
    return { x: this.info === undefined ? 2000 : 3000, y: 0, width: 10, height: 10 };
  }
  async focus() {
    this.owner.focused = { ...(this.info ?? this.owner.element) };
  }
  async selectText() {
    this.owner.focused = { ...(this.info ?? this.owner.element) };
  }
  async dragTo(_target: FakeLocator) {
    this.owner.done.push("drag");
  }
  async click() {
    this.owner.done.push("click");
  }
  async fill(_value?: string) {
    this.owner.done.push("fill");
  }
}

class FakePage {
  done: string[] = [];
  element: Info = { ...BUTTON };
  focused: Info | null = { ...FIELD };
  handlers: Record<string, ((value: unknown) => void)[]> = {};
  keyboard = {
    press: async (_key?: string) => {
      this.done.push("key");
    },
    type: async (_text?: string) => {
      this.done.push("keys");
    },
    // What a checked fill sends (record.cjs types it into what was checked, not through a second focus).
    insertText: async (_text?: string) => {
      this.done.push("fill");
    },
  };
  constructor(public address = "http://shop.example/notes?list=1") {}
  url() {
    return this.address;
  }
  context() {
    return { tracing: { stop: async () => undefined } };
  }
  /** What a drop target or the point under the mouse is. */
  under: Info = { ...FIELD };
  mouse = {
    move: async (_x: number, _y: number) => undefined,
    down: async () => undefined,
    up: async () => {
      this.done.push("up");
    },
    click: async (_x: number, _y: number) => {
      this.done.push("mouse-click");
    },
  };
  locator(selector?: string) {
    return new FakeLocator(this, selector === "#target" ? this.under : undefined);
  }
  /** Whether any password field on the page holds something (cdp-read.cjs `passwordFilled`). */
  pagePassword: boolean | Promise<boolean> = false;
  /** The page as cdp-read.cjs reads it, from outside its JavaScript. */
  reader() {
    return {
      focused: async () => (this.focused === null ? null : { ...this.focused }),
      at: async (x: number) => ({ ...(x >= 3000 ? this.under : x >= 2000 ? this.element : this.under) }),
      passwordFilled: () => Promise.resolve(this.pagePassword),
    };
  }
  on(event: string, handler: (value: unknown) => void) {
    (this.handlers[event] ??= []).push(handler);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mind-record-"));
  process.env["MIND_OUT"] = join(dir, "out");
  process.env["MIND_RELEASE_PUBKEY"] = PUBLIC;
  process.env["MIND_APPROVAL_WAIT"] = "20";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  record = require("../../docker/browser/record.cjs");
  record.__test.setReader((page) => page.reader());
});

afterAll(async () => {
  delete process.env["MIND_OUT"];
  delete process.env["MIND_RELEASE_PUBKEY"];
  delete process.env["MIND_APPROVAL_WAIT"];
  await rm(dir, { recursive: true, force: true });
});

/** The pending file the container writes for the next held action, once it is there. */
async function nextPending(seen: Set<string>): Promise<{ id: string; digest: string; follows?: string; approvable?: boolean; action: Info }> {
  let found: string | undefined;
  expect(await waitFor(async () => {
    const names = await readdir(join(dir, "out", "pending")).catch(() => [] as string[]);
    found = names.find((name) => name.endsWith(".json") && !seen.has(name));
    return found !== undefined;
  })).toBe(true);
  seen.add(found!);
  return JSON.parse(await readFile(join(dir, "out", "pending", found!), "utf8"));
}

/** The pending files there now: taken *before* an action starts, so its own file is never mistaken for an old one. */
async function pendingNow(): Promise<Set<string>> {
  return new Set(await readdir(join(dir, "out", "pending")).catch(() => [] as string[]));
}

/** The owner's answer, as the runner writes it: signed with the runner's private key. */
async function answer(id: string, digest: string, verdict: "approve" | "deny", key = KEYS.privateKey) {
  await writeFile(join(dir, "out", "release", `${id}.json`), JSON.stringify({ id, digest, verdict, sig: releaseSignature(key, id, digest, verdict) }));
}

describe("record.cjs, driven without a browser", () => {
  const seen = new Set<string>();

  test("a yes for the click lets it happen once; a page that re-points the form while it waits gets no click", async () => {
    const page = new FakePage();
    record.__test.patchLocators(page as never);
    const clicking = page.locator().click();
    const held = await nextPending(seen);
    expect(held.action).toMatchObject({ kind: "click", text: "Delete", formAction: "/delete?id=A", path: "/notes?list=1", context: "Note A" });
    await answer(held.id, held.digest, "approve");
    await clicking;
    expect(page.done).toEqual(["click"]);

    const swapped = page.locator().click();
    const second = await nextPending(seen);
    page.element = { ...BUTTON, formAction: "/delete?id=B", context: "Note B" };
    await answer(second.id, second.digest, "approve");
    await expect(swapped).rejects.toThrow("the page changed while it waited");
    expect(page.done).toEqual(["click"]);
  });

  test("a no, and a yes signed with any other key, are not a yes", async () => {
    const page = new FakePage();
    const one = page.locator().click();
    const a = await nextPending(seen);
    await answer(a.id, a.digest, "deny");
    await expect(one).rejects.toThrow("the owner said no");
    const two = page.locator().click();
    const b = await nextPending(seen);
    await answer(b.id, b.digest, "approve", generateKeyPairSync("ed25519").privateKey);
    await expect(two).rejects.toThrow("could not be verified");
    expect(page.done).toEqual([]);
  });

  test("keystrokes: the focused element is described again after a yes — moved, refused; the same, released once", async () => {
    const page = new FakePage();
    record.__test.patchKeyboard(page as never);
    const moved = page.keyboard.press("Enter");
    const a = await nextPending(seen);
    expect(a.action).toMatchObject({ kind: "press", key: "Enter", formAction: "/send" });
    page.focused = { ...FIELD, text: "Other", formAction: "/other" };
    await answer(a.id, a.digest, "approve");
    await expect(moved).rejects.toThrow("the page changed while it waited");
    expect(page.done).toEqual([]);

    page.focused = { ...FIELD };
    const same = page.keyboard.press("Enter");
    const b = await nextPending(seen);
    await answer(b.id, b.digest, "approve");
    await same;
    expect(page.done).toEqual(["key"]);
  });

  test("D-160: typing into a field that was a password field is refused at once, and filed as not approvable", async () => {
    const page = new FakePage();
    page.element = { ...FIELD, text: "Secret", secret: "password" };
    await expect(page.locator().fill("x")).rejects.toThrow("D-160");
    const filed = await nextPending(seen);
    expect(filed.approvable).toBe(false);
    expect(page.done).toEqual([]);
    expect(record.__test.valueClassOf({ autocomplete: "", type: "text", secret: "otp" })).toBe("otp");
    expect(record.__test.promptValueClass("Bitte Passwort eingeben")).toBe("password");
    expect(record.__test.promptValueClass("请输入验证码")).toBe("otp");
  });

  test("D-159: a confirm right after a released click on the same page names it; finding 7: the dialog's own page", async () => {
    const first = new FakePage("http://shop.example/one");
    const other = new FakePage("http://shop.example/two");
    record.__test.patchDialogs(first as never);
    class FakeDialog {
      accepted = 0;
      dismissed = 0;
      constructor(private owner: FakePage) {}
      type() {
        return "confirm";
      }
      message() {
        return "Delete this note?";
      }
      page() {
        return this.owner;
      }
      async accept() {
        this.accepted += 1;
      }
      async dismiss() {
        this.dismissed += 1;
      }
    }
    // The prototype is patched when the first dialog appears.
    first.handlers["dialog"]![0]!(new FakeDialog(first));
    const clicking = other.locator().click();
    const click = await nextPending(seen);
    await answer(click.id, click.digest, "approve");
    await clicking;
    // A dialog opens on the page that was clicked (the second tab's): paired when it opens, judged on its own page.
    record.__test.patchDialogs(other as never);
    const dialog = new FakeDialog(other);
    other.handlers["dialog"]!.forEach((handler) => handler(dialog));
    const accepting = dialog.accept();
    const confirm = await nextPending(seen);
    expect(confirm.action).toMatchObject({ kind: "dialog-submit", path: "/two", text: "Delete this note?" });
    expect(confirm.follows).toBe(click.id);
    await answer(confirm.id, confirm.digest, "approve");
    await accepting;
    expect(dialog.accepted).toBe(1);
    // A second dialog on the same page is not paired (the pair is used), and on another page nothing is.
    const second = new FakeDialog(other);
    other.handlers["dialog"]!.forEach((handler) => handler(second));
    const elsewhere = new FakeDialog(first);
    first.handlers["dialog"]!.forEach((handler) => handler(elsewhere));
    void second;
    // Round 4: a dialog is judged by its page's last check (it cannot be asked while the dialog is open); a page
    // never checked counts as holding a password, so its confirm would be D-160's never. Checked here, empty.
    const { passwordFilledAnywhere } = record.__test as unknown as { passwordFilledAnywhere: (page: unknown) => Promise<boolean> };
    const unchecked = new FakeDialog(new FakePage("http://shop.example/three"));
    await expect(unchecked.accept()).rejects.toThrow("D-160");
    expect(await passwordFilledAnywhere(first)).toBe(false);
    const fresh = await pendingNow();
    const refused = elsewhere.accept();
    const lone = await nextPending(fresh);
    expect(lone.follows).toBeUndefined();
    await answer(lone.id, lone.digest, "deny");
    await expect(refused).rejects.toThrow("the owner said no");
    expect([elsewhere.accepted, elsewhere.dismissed]).toEqual([0, 1]);
  });
});

describe("record.cjs asks for two kinds of step the list leaves alone (second review of PR #24)", () => {
  test("typing into a field that may take a code asks — and a yes lets it through; it is not D-160's never", async () => {
    const page = new FakePage();
    page.element = { ...FIELD, text: "Code", maybeCode: true };
    const before = await pendingNow();
    const typing = page.locator().fill("123");
    const held = await nextPending(before);
    expect(held.approvable).toBeUndefined();
    await answer(held.id, held.digest, "approve");
    await typing;
    expect(page.done).toEqual(["fill"]);
  }, 60_000);

  test("a neutral Continue in a form that holds a password field asks", async () => {
    const page = new FakePage();
    page.element = { ...BUTTON, text: "Continue", role: "button", submitsForm: false, clickable: true, formHasPassword: true, formAction: "/session" };
    const before = await pendingNow();
    const clicking = page.locator().click();
    const held = await nextPending(before);
    expect(held.action).toMatchObject({ text: "Continue" });
    await answer(held.id, held.digest, "deny");
    await expect(clicking).rejects.toThrow("the owner said no");
    expect(page.done).toEqual([]);
  }, 60_000);
});

describe("drags, the mouse and a filled password field (review of PR #24, round 3)", () => {
  test("a drop onto a password field is typing a password: refused at once, not approvable, nothing dropped", async () => {
    const page = new FakePage();
    record.__test.patchDrag(page as never);
    page.under = { ...FIELD, text: "Password", type: "password", secret: "password", editable: true };
    const before = await pendingNow();
    await expect(page.locator("#source").dragTo(page.locator("#target"))).rejects.toThrow("D-160");
    const filed = await nextPending(before);
    expect(filed.action).toMatchObject({ kind: "type", valueClass: "password" });
    expect(filed.approvable).toBe(false);
    expect(page.done).toEqual([]);
  });

  test("a drop onto a plain text field is typing text and goes; onto anything else it is a drag that asks", async () => {
    const page = new FakePage();
    page.under = { ...FIELD, editable: true };
    await page.locator("#source").dragTo(page.locator("#target"));
    expect(page.done).toEqual(["drag"]);
    page.under = { ...BUTTON, text: "Bin", submitsForm: false, editable: false };
    const before = await pendingNow();
    const dragging = page.locator("#source").dragTo(page.locator("#target"));
    const held = await nextPending(before);
    expect(held.action).toMatchObject({ kind: "drag", text: "Bin" });
    await answer(held.id, held.digest, "deny");
    await expect(dragging).rejects.toThrow("the owner said no");
    expect(page.done).toEqual(["drag"]);
  });

  test("the page's selector form of a drag goes the same way", async () => {
    const page = new FakePage();
    page.under = { ...FIELD, type: "password", secret: "password", editable: true };
    const before = await pendingNow();
    await expect((page as unknown as { dragAndDrop: (a: string, b: string) => Promise<void> }).dragAndDrop("#source", "#target")).rejects.toThrow("D-160");
    await nextPending(before);
    expect(page.done).toEqual([]);
  });

  test("the mouse by coordinates: a button let go over a password field after a move is refused; a click asks", async () => {
    const page = new FakePage();
    record.__test.patchMouse(page as never);
    page.under = { ...FIELD, type: "password", secret: "password", editable: true };
    await page.mouse.move(10, 10);
    await page.mouse.down();
    await page.mouse.move(50, 60);
    const before = await pendingNow();
    await expect(page.mouse.up()).rejects.toThrow("D-160");
    await nextPending(before);
    page.under = { ...BUTTON };
    const again = await pendingNow();
    const clicking = page.mouse.click(5, 5);
    const held = await nextPending(again);
    expect(held.action).toMatchObject({ kind: "click", text: "Delete" });
    await answer(held.id, held.digest, "deny");
    await expect(clicking).rejects.toThrow("the owner said no");
    expect(page.done).toEqual([]);
  });

  test("D-160: any control, or Enter, in a form whose password field already holds something is never released", async () => {
    const page = new FakePage();
    page.element = { ...BUTTON, text: "Continue", submitsForm: false, clickable: true, formHasPassword: true, passwordFilled: true, formAction: "/session" };
    const before = await pendingNow();
    await expect(page.locator().click()).rejects.toThrow("D-160");
    const filed = await nextPending(before);
    expect(filed.approvable).toBe(false);
    expect(filed.action).toMatchObject({ text: "Continue" });
    record.__test.patchKeyboard(page as never);
    page.focused = { ...FIELD, text: "Username", formHasPassword: true, passwordFilled: true };
    const enter = await pendingNow();
    await expect(page.keyboard.press("Enter")).rejects.toThrow("D-160");
    expect((await nextPending(enter)).approvable).toBe(false);
    expect(page.done).toEqual([]);
  });
});

describe("a password field anywhere on the page that holds something (review of PR #24, round 4)", () => {
  test("the repro: Weiter, a type=button outside the form, is never clicked; typing elsewhere still goes", async () => {
    const page = new FakePage("http://login.example/signin");
    record.__test.patchKeyboard(page as never);
    page.pagePassword = true;
    page.element = { tag: "button", type: "button", autocomplete: "", role: "button", text: "Weiter", submitsForm: false, clickable: true, formHasPassword: false };
    const before = await pendingNow();
    await expect(page.locator().click()).rejects.toThrow("D-160");
    const filed = await nextPending(before);
    expect(filed.approvable).toBe(false);
    expect(filed.action).toMatchObject({ kind: "click", text: "Weiter" });
    // Enter anywhere, too.
    const enter = await pendingNow();
    await expect(page.keyboard.press("Enter")).rejects.toThrow("D-160");
    expect((await nextPending(enter)).approvable).toBe(false);
    // Typing into a plain field is not a submit: it goes.
    page.element = { ...FIELD };
    await page.locator().fill("ada");
    expect(page.done).toEqual(["fill"]);
    // With the field empty, the same click is an ordinary click again.
    page.pagePassword = false;
    page.element = { tag: "button", type: "button", autocomplete: "", role: "button", text: "Weiter", submitsForm: false, clickable: true, formHasPassword: false };
    await page.locator().click();
    expect(page.done).toEqual(["fill", "click"]);
  });

  test("what counts as a submit", () => {
    const { submitLike } = record.__test as unknown as { submitLike: (kind: string, extra: Info, info: Info | null) => boolean };
    expect(submitLike("click", {}, null)).toBe(true);
    expect(submitLike("check", {}, null)).toBe(true);
    expect(submitLike("fill", { submits: false }, null)).toBe(false);
    expect(submitLike("type", { submits: true }, null)).toBe(true);
    expect(submitLike("press", { key: "Tab" }, { clickable: false })).toBe(false);
    expect(submitLike("press", { key: "Enter" }, { clickable: false })).toBe(true);
    expect(submitLike("press", { key: " " }, { clickable: true })).toBe(true);
  });

  test("a page that cannot be read, or does not answer in time, counts as holding one", async () => {
    const { passwordFilledAnywhere } = record.__test as unknown as { passwordFilledAnywhere: (page: unknown) => Promise<boolean> };
    const page = new FakePage();
    expect(await passwordFilledAnywhere(page)).toBe(false);
    page.pagePassword = Promise.reject(new Error("no CDP here"));
    expect(await passwordFilledAnywhere(page)).toBe(true);
    // A page stuck in a script never answers: counted as holding one, after the wait — not as empty.
    page.pagePassword = new Promise<boolean>(() => undefined);
    const startedAt = Date.now();
    expect(await passwordFilledAnywhere(page)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe("keys to anything that is not a text field ask (review of PR #24, last round)", () => {
  const DIV: Info = { tag: "div", type: "", autocomplete: "", role: "", text: "", textEntry: false, clickable: true, submitsForm: false, formHasPassword: false };

  test("which keys", () => {
    const { printableKeys } = record.__test as unknown as { printableKeys: (kind: string, extra: Info, info: Info) => boolean };
    const div = DIV;
    const button = { ...DIV, tag: "button", role: "button" };
    expect(printableKeys("type", {}, div)).toBe(true);
    expect(printableKeys("fill", {}, div)).toBe(true);
    expect(printableKeys("fill", {}, { ...FIELD })).toBe(false);
    expect(printableKeys("type", {}, { ...FIELD })).toBe(false);
    for (const key of ["x", "7", "Shift+A", "Control+V", "Meta+v", "Space", " ", "+"]) expect(printableKeys("press", { key }, div), key).toBe(true);
    for (const key of ["Tab", "ArrowDown", "Escape", "Enter", "PageDown", "F5", "Shift+Tab"]) expect(printableKeys("press", { key }, div), key).toBe(false);
    expect(printableKeys("press", { key: "Space" }, button)).toBe(false);
    expect(printableKeys("press", { key: " " }, { ...DIV, role: "link" })).toBe(false);
    expect(printableKeys("press", { key: "x" }, { ...FIELD })).toBe(false);
    expect(printableKeys("click", {}, div)).toBe(false);
  });

  test("typing to a focused div (a closed root the reader cannot see) waits for a yes; a no keeps it untyped; Tab goes", async () => {
    const page = new FakePage();
    record.__test.patchKeyboard(page as never);
    page.focused = { ...DIV };
    const before = await pendingNow();
    const typing = page.keyboard.type("hunter2");
    const held = await nextPending(before);
    expect(held.approvable).toBeUndefined();
    expect((held as unknown as { rules: string[] }).rules).toContain("keys.not-a-text-field");
    await answer(held.id, held.digest, "deny");
    await expect(typing).rejects.toThrow("the owner said no");
    expect(page.done).toEqual([]);
    await page.keyboard.press("Tab");
    expect(page.done).toEqual(["key"]);
  });
});
