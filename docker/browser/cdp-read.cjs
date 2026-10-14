// Reading the page from outside its own JavaScript (review of PR #24, last round).
//
// Everything D-153's list and D-160 are told about an element used to be read in the page's main world, where
// the page can redefine `tagName`, `isContentEditable`, `getAttribute`, `value`, `shadowRoot` — and so make a
// password field in a closed shadow root look like a textarea. This module reads through the Chrome DevTools
// Protocol instead, from the MCP server's side:
//
// - **where keys go**: `document.activeElement`, then on down through every shadow root — open, closed or
//   declarative, which `DOM.describeNode` with `pierce` lists whatever the page did — and through frames;
// - **what is at a point** (a click, a drop): `DOM.getNodeForLocation`, which hit-tests into closed roots;
// - **what an element is**: `describeElement` (describe.cjs) run by `Runtime.callFunctionOn` in an *isolated
//   world* of our own (`Page.createIsolatedWorld`). An isolated world shares the DOM but not the page's
//   JavaScript: its prototypes and getters are the browser's own, whatever the page redefined in its world;
// - **a shadow host is never a text field** (belt and braces): an element with an author shadow root (open,
//   closed or declarative, so also any with delegatesFocus) has `textEntry: false`;
// - **does a password field anywhere hold something**: `DOM.getDocument` with `pierce` lists every input in
//   every root and same-process frame; each is read in the isolated world; a frame with its own process
//   (out-of-process iframe) gets its own session. A field once seen as a password field stays one
//   (`sticky`, by its backend node id), so a show-password toggle does not make it plain text.
//
// Anything that cannot be read — no CDP session, an error, a cross-process frame where keys go — is `null`
// (the caller holds) or, for the page-wide check, "yes".
"use strict";

const { describeElement } = require("./describe.cjs");

const WORLD = "mind-reader";
const GROUP = "mind-reader";

/** Run describeElement on `this` in the isolated world; a text node is read as its parent element. */
const DESCRIBE = `function (behavior) {
  const node = this && this.nodeType === 1 ? this : this && this.parentElement;
  if (!node) return null;
  return (${describeElement.toString()})(node, behavior);
}`;

/** Read one input in the isolated world: is it a password field, and does it hold anything (never what). */
const FIELD = `function () {
  const type = String(this.getAttribute("type") || "").toLowerCase();
  const auto = String(this.getAttribute("autocomplete") || "").toLowerCase();
  let masked = false;
  try {
    const view = (this.ownerDocument && this.ownerDocument.defaultView) || window;
    const security = view.getComputedStyle(this).getPropertyValue("-webkit-text-security");
    masked = security !== "" && security !== "none";
  } catch (error) {
    masked = false;
  }
  return { password: type === "password" || /(^|\\s)(current|new)-password(\\s|$)/.test(auto) || masked, filled: String(this.value || "") !== "" };
}`;

/** Author shadow roots only: inputs and textareas have the browser's own (user-agent) roots inside them. */
function authorRoots(node) {
  return (node.shadowRoots || []).filter((root) => root.shadowRootType !== "user-agent");
}

/** One CDP session (a page, or a frame with its own process) and its isolated worlds by frame. */
class Session {
  constructor(send, sticky) {
    this.send = send;
    this.worlds = new Map();
    this.sticky = sticky;
    this.mainFrameId = undefined;
  }

  async mainFrame() {
    if (this.mainFrameId === undefined) this.mainFrameId = (await this.send("Page.getFrameTree")).frameTree.frame.id;
    return this.mainFrameId;
  }

  async world(frameId) {
    if (!this.worlds.has(frameId)) {
      const { executionContextId } = await this.send("Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniversalAccess: false });
      this.worlds.set(frameId, executionContextId);
    }
    return this.worlds.get(frameId);
  }

  /**
   * Run `body`, and once more with fresh worlds if it failed: a world goes with its document, and a stale one
   * fails in more than one way ("Cannot find context", "does not belong to the document").
   */
  async withWorlds(body) {
    try {
      return await body();
    } catch {
      this.worlds.clear();
      this.mainFrameId = undefined;
      return await body();
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
    }
  }

  async evaluate(frameId, expression) {
    const { result } = await this.send("Runtime.evaluate", { expression, contextId: await this.world(frameId), objectGroup: GROUP });
    return result.subtype === "null" || result.objectId === undefined ? null : result.objectId;
  }

  async resolve(backendNodeId, frameId) {
    const { object } = await this.send("DOM.resolveNode", { backendNodeId, executionContextId: await this.world(frameId), objectGroup: GROUP });
    return object.objectId;
  }

  async call(objectId, functionDeclaration, args = [], byValue = true) {
    const { result, exceptionDetails } = await this.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: byValue,
      objectGroup: GROUP,
    });
    if (exceptionDetails !== undefined) throw new Error(`in the page: ${exceptionDetails.text}`);
    if (byValue) return result.value;
    return result.subtype === "null" || result.objectId === undefined ? null : result.objectId;
  }

  async node(objectId) {
    return (await this.send("DOM.describeNode", { objectId, depth: 1, pierce: true })).node;
  }

  /** describeElement in the isolated world, with what only CDP can say added: a shadow host is no text field. */
  async describe(objectId, node, behavior) {
    const info = await this.call(objectId, DESCRIBE, [behavior]);
    if (info === null || info === undefined) return null;
    if (authorRoots(node).length > 0) {
      info.shadowHost = true;
      info.textEntry = false;
      info.editable = false;
    }
    if (this.sticky.has(node.backendNodeId) && (info.tag === "input" || info.textEntry === true)) info.secret = "password";
    if (info.secret === "password") this.sticky.add(node.backendNodeId);
    return info;
  }

  /** The element keys go to: focus followed through every shadow root and same-process frame. */
  async focused() {
    return this.withWorlds(async () => {
      let frameId = await this.mainFrame();
      let objectId = await this.evaluate(frameId, "document.activeElement || document.body");
      for (let hops = 0; hops < 64 && objectId !== null; hops += 1) {
        const node = await this.node(objectId);
        const roots = authorRoots(node);
        if (roots.length > 0) {
          const root = await this.resolve(roots[0].backendNodeId, frameId);
          const inner = await this.call(root, "function () { return this.activeElement; }", [], false);
          if (inner !== null) {
            objectId = inner;
            continue;
          }
          return this.describe(objectId, node, "none");
        }
        if (node.nodeName === "IFRAME" || node.nodeName === "FRAME") {
          // A frame with its own process is not in this session: where its keys go cannot be read here.
          if (node.contentDocument === undefined || node.frameId === undefined) return null;
          frameId = node.frameId;
          objectId = await this.evaluate(frameId, "document.activeElement || document.body");
          continue;
        }
        return this.describe(objectId, node, "none");
      }
      return null;
    });
  }

  /** The element at a viewport point, as a click or a drop there finds it. */
  async at(x, y, behavior) {
    return this.withWorlds(async () => {
      const hit = await this.send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false });
      const frameId = hit.frameId || (await this.mainFrame());
      const objectId = await this.resolve(hit.backendNodeId, frameId);
      const node = await this.node(objectId);
      // Into a frame of its own process nothing here can see.
      if (node.nodeName === "IFRAME" || node.nodeName === "FRAME") return null;
      return this.describe(objectId, node, behavior);
    });
  }

  /** Does any password field this session can see hold something? */
  async passwordFilled() {
    return this.withWorlds(async () => {
      const { root } = await this.send("DOM.getDocument", { depth: -1, pierce: true });
      const inputs = [];
      const walk = (node, frameId) => {
        if (node.nodeName === "INPUT") inputs.push({ backendNodeId: node.backendNodeId, frameId });
        for (const child of node.children || []) walk(child, frameId);
        for (const shadow of node.shadowRoots || []) walk(shadow, frameId);
        if (node.contentDocument !== undefined) walk(node.contentDocument, node.frameId || frameId);
      };
      walk(root, await this.mainFrame());
      for (const input of inputs) {
        const field = await this.call(await this.resolve(input.backendNodeId, input.frameId), FIELD);
        const password = field.password === true || this.sticky.has(input.backendNodeId);
        if (field.password === true) this.sticky.add(input.backendNodeId);
        if (password && field.filled === true) return true;
      }
      return false;
    });
  }
}

/** Per page: its session, the sessions of its out-of-process frames, and the fields seen as passwords. */
const readers = new WeakMap();

/**
 * The reader for a Playwright page. `open(target)` makes a CDP session for a page or a frame (Playwright's
 * `context.newCDPSession`); it throws for a frame that has no session of its own.
 */
function readerFor(page, open = (target) => page.context().newCDPSession(target)) {
  let reader = readers.get(page);
  if (reader !== undefined) return reader;
  const sticky = new Set();
  const sessions = new Map();
  const sessionOf = async (target) => {
    if (!sessions.has(target)) {
      sessions.set(
        target,
        (async () => {
          const cdp = await open(target);
          return new Session((method, params) => cdp.send(method, params), sticky);
        })(),
      );
    }
    try {
      return await sessions.get(target);
    } catch (error) {
      // A frame in the page's own process has no session of its own, for good: remembered as none. Anything
      // else may pass, so it is asked again next time.
      if (target !== page && /separate CDP session/i.test(String(error && error.message))) sessions.set(target, Promise.resolve(null));
      else sessions.delete(target);
      throw error;
    }
  };
  reader = {
    /** What keys typed now reach, or null when that cannot be read. */
    async focused() {
      try {
        return await (await sessionOf(page)).focused();
      } catch {
        return null;
      }
    },
    /** What a click or a drop at this viewport point reaches, or null. */
    async at(x, y, behavior) {
      try {
        return await (await sessionOf(page)).at(x, y, behavior);
      } catch {
        return null;
      }
    },
    /** Any password field holding anything, in the page or any frame; anything unreadable counts as yes. */
    async passwordFilled() {
      try {
        if (await (await sessionOf(page)).passwordFilled()) return true;
      } catch {
        return true;
      }
      const frames = typeof page.frames === "function" ? page.frames() : [];
      const main = typeof page.mainFrame === "function" ? page.mainFrame() : frames[0];
      for (const frame of frames) {
        if (frame === main) continue;
        let session;
        try {
          session = await sessionOf(frame);
        } catch (error) {
          // In the page's own process: already walked with the page. Any other failure: cannot say.
          if (/separate CDP session/i.test(String(error && error.message))) continue;
          if (!(typeof frame.isDetached === "function" && frame.isDetached())) return true;
          continue;
        }
        // Known to have no session of its own.
        if (session === null) continue;
        try {
          if (await session.passwordFilled()) return true;
        } catch {
          if (!(typeof frame.isDetached === "function" && frame.isDetached())) return true;
        }
      }
      return false;
    },
  };
  readers.set(page, reader);
  return reader;
}

module.exports = { readerFor, Session, authorRoots, DESCRIBE, FIELD, WORLD };
