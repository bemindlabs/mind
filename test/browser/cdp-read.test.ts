/**
 * `docker/browser/cdp-read.cjs` against a fake DevTools backend (review of PR #24, last round): where keys go,
 * what is at a point, and whether a password field anywhere holds something — read the way CDP reports the
 * page, closed and declarative shadow roots and frames included. That an isolated world ignores the page's own
 * getters is the browser's to prove, and test/e2e/tasks.e2e.ts case 14 does, in Chromium.
 */

import { describe, expect, test } from "bun:test";
import { el, fakeDoc, FakeEl, type FakeDoc } from "../support/fake-dom.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readerFor, Session } = require("../../docker/browser/cdp-read.cjs") as {
  readerFor: (page: unknown, open: (target: unknown) => Promise<{ send: Send }>) => Reader;
  Session: new (send: Send, sticky: Set<number>) => Reader;
};

type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Info = Record<string, unknown> | null;
interface Reader {
  focused(): Promise<Info>;
  at(x: number, y: number, behavior: string): Promise<Info>;
  passwordFilled(): Promise<boolean>;
}

/** A shadow root as CDP sees it: its type, and what has focus inside it. */
interface FakeRoot {
  readonly kind: "root";
  readonly type: "open" | "closed" | "user-agent";
  readonly children: FakeEl[];
  activeElement: FakeEl | null;
}

/**
 * The page as DevTools reports it. Elements are fake-dom elements; each gets a backend node id the first time
 * it is seen. `roots` and `frames` say what `describeNode` with `pierce` would list; `hits` what a point is.
 */
class FakeBrowser {
  readonly ids = new Map<object, number>();
  readonly byId = new Map<number, object>();
  readonly roots = new Map<FakeEl, FakeRoot>();
  /** An <iframe>'s document and frame id; absent for a frame in another process. */
  readonly frames = new Map<FakeEl, { doc: FakeDoc; id: string; top: FakeEl[] }>();
  readonly docs = new Map<string, { doc: FakeDoc; top: FakeEl[] }>();
  readonly hits = new Map<string, FakeEl>();
  readonly worlds: string[] = [];
  readonly calls: string[] = [];
  failing: string | undefined;
  lostContext = 0;
  /** `DOM.resolveNode` failing this many times as a world of a gone document does. */
  staleNode = 0;

  constructor(main: FakeDoc, top: FakeEl[]) {
    this.docs.set("main", { doc: main, top });
  }

  id(object: object): number {
    if (!this.ids.has(object)) {
      const id = this.ids.size + 1;
      this.ids.set(object, id);
      this.byId.set(id, object);
    }
    return this.ids.get(object)!;
  }

  private object(objectId: unknown): object {
    const found = this.byId.get(Number(String(objectId).slice(4)));
    if (found === undefined) throw new Error(`no object ${String(objectId)}`);
    return found;
  }

  private ref(value: unknown): Record<string, unknown> {
    return value === null || value === undefined ? { type: "object", subtype: "null" } : { type: "object", objectId: `obj-${this.id(value as object)}` };
  }

  private nodeOf(object: object, depth: number): Record<string, unknown> {
    if ((object as FakeRoot).kind === "root") {
      const root = object as FakeRoot;
      return { nodeName: "#document-fragment", backendNodeId: this.id(root), shadowRootType: root.type, children: depth === 0 ? undefined : root.children.map((c) => this.nodeOf(c, depth - 1)) };
    }
    if ((object as { location?: unknown }).location !== undefined) {
      const entry = [...this.docs.values()].find((d) => d.doc === object)!;
      return { nodeName: "#document", backendNodeId: this.id(object), children: depth === 0 ? undefined : entry.top.map((c) => this.nodeOf(c, depth - 1)) };
    }
    const element = object as FakeEl;
    const node: Record<string, unknown> = {
      nodeName: element.tagName.toUpperCase(),
      backendNodeId: this.id(element),
      attributes: Object.entries(element.attrs).flat(),
    };
    const root = this.roots.get(element);
    if (root !== undefined) node["shadowRoots"] = [this.nodeOf(root, depth === 0 ? 0 : depth - 1)];
    if (depth !== 0) node["children"] = element.children.map((c) => this.nodeOf(c, depth - 1));
    const frame = this.frames.get(element);
    if (frame !== undefined) {
      node["frameId"] = frame.id;
      node["contentDocument"] = this.nodeOf(frame.doc, depth === 0 ? 0 : depth - 1);
    } else if (element.tagName.toUpperCase() === "IFRAME") {
      node["frameId"] = `oopif-${this.id(element)}`;
    }
    return node;
  }

  readonly send: Send = async (method, params = {}) => {
    this.calls.push(method);
    if (this.failing !== undefined && method === this.failing) throw new Error(`${method} failed`);
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main" } } };
      case "Page.createIsolatedWorld":
        this.worlds.push(String(params["frameId"]));
        return { executionContextId: this.worlds.length };
      case "Runtime.evaluate": {
        if (this.lostContext > 0) {
          this.lostContext -= 1;
          throw new Error("Cannot find context with specified id");
        }
        const frameId = this.worlds[Number(params["contextId"]) - 1]!;
        const doc = this.docs.get(frameId)!.doc;
        return { result: this.ref(doc.activeElement ?? doc.body) };
      }
      case "DOM.describeNode":
        return { node: this.nodeOf(this.object(params["objectId"] ?? `obj-${String(params["backendNodeId"])}`), 1) };
      case "DOM.resolveNode":
        if (this.staleNode > 0) {
          this.staleNode -= 1;
          throw new Error("Node with given id does not belong to the document");
        }
        return { object: this.ref(this.byId.get(Number(params["backendNodeId"]))) };
      case "Runtime.callFunctionOn": {
        const target = this.object(params["objectId"]);
        const fn = (0, eval)(`(${String(params["functionDeclaration"])})`) as (...args: unknown[]) => unknown;
        const args = ((params["arguments"] as { value: unknown }[] | undefined) ?? []).map((a) => a.value);
        const value = fn.apply(target, args);
        return params["returnByValue"] === true ? { result: { value: JSON.parse(JSON.stringify(value ?? null)) } } : { result: this.ref(value) };
      }
      case "DOM.getNodeForLocation": {
        const hit = this.hits.get(`${String(params["x"])},${String(params["y"])}`);
        if (hit === undefined) throw new Error("No node found at given location");
        const frame = [...this.docs.entries()].find(([, d]) => d.doc === hit.ownerDocument)?.[0] ?? "main";
        return { backendNodeId: this.id(hit), frameId: frame };
      }
      case "DOM.getDocument":
        return { root: this.nodeOf(this.docs.get("main")!.doc, -1) };
      case "Runtime.releaseObjectGroup":
        return {};
      default:
        throw new Error(`unexpected ${method}`);
    }
  };

  /** A closed (or open, or user-agent) root on `host` holding `children`. */
  root(host: FakeEl, type: FakeRoot["type"], children: FakeEl[], active: FakeEl | null = null): FakeRoot {
    const root: FakeRoot = { kind: "root", type, children, activeElement: active };
    this.roots.set(host, root);
    return root;
  }

  frame(iframe: FakeEl, id: string, doc: FakeDoc, top: FakeEl[]) {
    this.frames.set(iframe, { doc, id, top });
    this.docs.set(id, { doc, top });
  }
}

/** A page with a body, a focusable host, and whatever goes in. */
function page() {
  const doc = fakeDoc("http://login.example/signin");
  const body = el(doc, "body");
  doc.body = body;
  const browser = new FakeBrowser(doc, [body]);
  return { doc, body, browser, reader: new Session(browser.send, new Set()) };
}

/** A password field that is nobody's document's own: it lives only in a shadow root. */
function innerPassword(doc: FakeDoc, value = ""): FakeEl {
  const field = new FakeEl("INPUT", { type: "password", id: "p" }, "", doc);
  field.value = value;
  return field;
}

describe("cdp-read.cjs: where keys go (last review)", () => {
  test("repro (a): a contenteditable tabindex div with a declarative closed root, focus inside — the password field is found", async () => {
    const { doc, body, browser, reader } = page();
    const host = el(doc, "div", { tabindex: "0", contenteditable: "true", shadowrootdelegatesfocus: "" });
    host.isContentEditable = true;
    body.append(host);
    const field = innerPassword(doc);
    browser.root(host, "closed", [field], field);
    doc.activeElement = host;
    expect(await reader.focused()).toMatchObject({ tag: "input", secret: "password", textEntry: true });
  });

  test("a shadow host is never a text field — contenteditable, or a tagName that says textarea — when focus is on it", async () => {
    const { doc, body, browser, reader } = page();
    const host = el(doc, "div", { tabindex: "0", contenteditable: "true" });
    host.isContentEditable = true;
    body.append(host);
    browser.root(host, "closed", [innerPassword(doc)], null);
    doc.activeElement = host;
    expect(await reader.focused()).toMatchObject({ tag: "div", shadowHost: true, textEntry: false, editable: false });
    // What a page-defined tagName getter would make the main world say; the shadow root is CDP's, not the page's.
    const fake = new FakeEl("TEXTAREA", {}, "", doc);
    body.append(fake);
    browser.root(fake, "closed", [], null);
    doc.activeElement = fake;
    expect(await reader.focused()).toMatchObject({ shadowHost: true, textEntry: false });
  });

  test("an open root is followed too; the browser's own roots inside an input are not a host", async () => {
    const { doc, body, browser, reader } = page();
    const host = el(doc, "div", { tabindex: "0" });
    body.append(host);
    const field = innerPassword(doc);
    browser.root(host, "open", [field], field);
    doc.activeElement = host;
    expect(await reader.focused()).toMatchObject({ secret: "password" });
    const plain = el(doc, "input", { name: "q" });
    body.append(plain);
    browser.root(plain, "user-agent", [], null);
    doc.activeElement = plain;
    expect(await reader.focused()).toMatchObject({ tag: "input", textEntry: true });
  });

  test("into a same-process frame; a frame of its own process cannot be read, so nothing is said", async () => {
    const { doc, body, browser, reader } = page();
    const iframe = el(doc, "iframe");
    body.append(iframe);
    const inner = fakeDoc("http://login.example/inner", true);
    const innerBody = el(inner, "body");
    inner.body = innerBody;
    const field = el(inner, "input", { type: "password" });
    innerBody.append(field);
    inner.activeElement = field;
    browser.frame(iframe, "child", inner, [innerBody]);
    doc.activeElement = iframe;
    expect(await reader.focused()).toMatchObject({ secret: "password", frameOrigin: "http://login.example" });
    expect(browser.worlds).toContain("child");
    const remote = el(doc, "iframe", { src: "http://other.example/" });
    body.append(remote);
    doc.activeElement = remote;
    expect(await reader.focused()).toBeNull();
  });

  test("nothing focused reads the body; a world lost to a navigation is made again", async () => {
    const { browser, reader } = page();
    expect(await reader.focused()).toMatchObject({ tag: "body", textEntry: false });
    browser.lostContext = 1;
    expect(await reader.focused()).toMatchObject({ tag: "body" });
    expect(browser.worlds.length).toBe(2);
  });
});

describe("cdp-read.cjs: what is at a point", () => {
  test("a point over a closed root hits the field inside it; a point over a frame of its own process says nothing", async () => {
    const { doc, body, browser, reader } = page();
    const host = el(doc, "div", { tabindex: "0" });
    body.append(host);
    const field = innerPassword(doc);
    browser.root(host, "closed", [field]);
    browser.hits.set("10,20", field);
    expect(await reader.at(10.4, 19.6, "click")).toMatchObject({ tag: "input", secret: "password" });
    // After a navigation the world is of the old document, and fails its own way: made again, read again.
    browser.staleNode = 1;
    expect(await reader.at(10, 20, "click")).toMatchObject({ secret: "password" });
    const remote = el(doc, "iframe");
    body.append(remote);
    browser.hits.set("50,50", remote);
    expect(await reader.at(50, 50, "click")).toBeNull();
    // A click on a span in a button is the button's (describeElement's retarget, run in the isolated world).
    const button = el(doc, "button", {}, "Delete account");
    const icon = el(doc, "span");
    button.append(icon);
    body.append(button);
    browser.hits.set("70,70", icon);
    expect(await reader.at(70, 70, "click")).toMatchObject({ tag: "button", text: "Delete account" });
  });
});

describe("cdp-read.cjs: a password field anywhere that holds something", () => {
  test("in a closed root, in a frame — read for emptiness only; a field once seen as a password field stays one", async () => {
    const { doc, body, browser, reader } = page();
    const host = el(doc, "div", { tabindex: "0" });
    body.append(host);
    const field = innerPassword(doc);
    browser.root(host, "closed", [field]);
    expect(await reader.passwordFilled()).toBe(false);
    field.value = "hunter2";
    expect(await reader.passwordFilled()).toBe(true);
    // A show-password toggle: the same field, now type=text, still counts.
    field.attrs["type"] = "text";
    expect(await reader.passwordFilled()).toBe(true);
    // Once a field is known as a password field, typing into it is typing a password, whatever it says now.
    browser.roots.get(host)!.activeElement = field;
    doc.activeElement = host;
    expect(await reader.focused()).toMatchObject({ secret: "password" });
    field.value = "";
    expect(await reader.passwordFilled()).toBe(false);
    const iframe = el(doc, "iframe");
    body.append(iframe);
    const inner = fakeDoc("http://login.example/inner", true);
    const innerBody = el(inner, "body");
    inner.body = innerBody;
    const deep = el(inner, "input", { autocomplete: "current-password" });
    deep.value = "x";
    innerBody.append(deep);
    browser.frame(iframe, "child", inner, [innerBody]);
    expect(await reader.passwordFilled()).toBe(true);
  });
});

describe("cdp-read.cjs: readerFor — sessions, frames of their own process, failures", () => {
  function playwrightPage(main: FakeBrowser, frames: { frame: object; browser?: FakeBrowser; failing?: boolean; detached?: boolean }[]) {
    const mainFrame = {};
    const pageLike = {
      frames: () => [mainFrame, ...frames.map((f) => f.frame)],
      mainFrame: () => mainFrame,
    };
    for (const f of frames) (f.frame as { isDetached: () => boolean }).isDetached = () => f.detached === true;
    const open = async (target: unknown) => {
      if (target === pageLike) return { send: main.send };
      const own = frames.find((f) => f.frame === target);
      if (own?.browser === undefined) throw new Error("This frame does not have a separate CDP session");
      return { send: own.failing === true ? async () => Promise.reject(new Error("gone")) : own.browser.send };
    };
    return { pageLike, open };
  }

  test("a frame with its own process is asked through its own session; one in the page's process is not asked twice", async () => {
    const { browser } = page();
    const remoteDoc = fakeDoc("http://pay.example/");
    const remoteBody = el(remoteDoc, "body");
    remoteDoc.body = remoteBody;
    const card = el(remoteDoc, "input", { type: "password" });
    remoteBody.append(card);
    const remote = new FakeBrowser(remoteDoc, [remoteBody]);
    const { pageLike, open } = playwrightPage(browser, [{ frame: {} }, { frame: {}, browser: remote }]);
    const reader = readerFor(pageLike, open);
    expect(await reader.passwordFilled()).toBe(false);
    card.value = "x";
    expect(await reader.passwordFilled()).toBe(true);
  });

  test("anything that cannot be read: keys and points say nothing (the step is held); the page-wide check says yes", async () => {
    const { browser } = page();
    browser.failing = "Runtime.evaluate";
    const broken = playwrightPage(browser, []);
    const reader = readerFor(broken.pageLike, broken.open);
    expect(await reader.focused()).toBeNull();
    browser.failing = "DOM.getNodeForLocation";
    expect(await reader.at(1, 1, "click")).toBeNull();
    browser.failing = "DOM.getDocument";
    expect(await reader.passwordFilled()).toBe(true);
    // No CDP at all.
    const none = readerFor({ frames: () => [] }, async () => Promise.reject(new Error("not Chromium")));
    expect(await none.focused()).toBeNull();
    expect(await none.passwordFilled()).toBe(true);
    // A frame of its own process that errors counts as yes — unless it is gone.
    const { browser: fine } = page();
    const erring = playwrightPage(fine, [{ frame: {}, browser: fine, failing: true }]);
    expect(await readerFor(erring.pageLike, erring.open).passwordFilled()).toBe(true);
    const { browser: fine2 } = page();
    const gone = playwrightPage(fine2, [{ frame: {}, browser: fine2, failing: true, detached: true }]);
    expect(await readerFor(gone.pageLike, gone.open).passwordFilled()).toBe(false);
  });
});
