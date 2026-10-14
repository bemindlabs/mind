/**
 * `docker/browser/describe.cjs` against element fixtures (reviews of PR #24, findings 1, 3 and 4): what the
 * list is told about an element decides whether it is held, so every case the review found is pinned here,
 * and the classification it leads to is asked of the same `classifyAction` the container bundles.
 */

import { describe, expect, test } from "bun:test";
import { classifyAction } from "../../src/decide/sensitive.ts";
import { el, fakeDoc, FakeEl } from "../support/fake-dom.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { describeElement } = require("../../docker/browser/describe.cjs") as {
  describeElement: (element: unknown, behavior?: string) => Record<string, unknown> & { text: string; role: string; secret?: string };
};

const PAGE = "http://shop.example/cart?item=3#top";

describe("describe.cjs: role and text (finding 1)", () => {
  test("an explicit role=button on a div or a span reads its visible text, and the list holds it", () => {
    const doc = fakeDoc(PAGE);
    const send = el(doc, "div", { role: "button" }, "Send");
    const remove = el(doc, "span", { role: "button" }, "Delete");
    expect(describeElement(send)).toMatchObject({ role: "button", text: "Send" });
    expect(describeElement(remove)).toMatchObject({ role: "button", text: "Delete" });
    expect(classifyAction({ kind: "click", origin: "http://shop.example", role: "button", text: "Send" }).categories).toContain("send");
    expect(classifyAction({ kind: "click", origin: "http://shop.example", role: "button", text: "Delete" }).categories).toContain("delete");
  });

  test("every clickable role, an onclick element and a tabindex element read their text; a plain textbox does not", () => {
    const doc = fakeDoc(PAGE);
    for (const role of ["link", "menuitem", "tab", "option", "switch", "treeitem"]) expect(describeElement(el(doc, "div", { role }, "Pay now")).text).toBe("Pay now");
    expect(describeElement(el(doc, "div", { onclick: "x()" }, "Remove")).text).toBe("Remove");
    expect(describeElement(el(doc, "div", { tabindex: "0" }, "Post")).text).toBe("Post");
    expect(describeElement(el(doc, "input", { type: "text", name: "q" }, "")).text).toBe("q");
  });

  test("the accessible name first: aria-label, then aria-labelledby, then labels", () => {
    const doc = fakeDoc(PAGE);
    el(doc, "span", { id: "lbl" }, "Wire money");
    expect(describeElement(el(doc, "div", { role: "button", "aria-label": "Close account" }, "x")).text).toBe("Close account");
    expect(describeElement(el(doc, "div", { role: "button", "aria-labelledby": "lbl" }, "→")).text).toBe("Wire money");
    const field = el(doc, "input", { type: "text" });
    field.labels = [el(doc, "label", {}, "Passwort")];
    expect(describeElement(field).text).toBe("Passwort");
  });
});

describe("describe.cjs: credentials (finding 3)", () => {
  test("strong signals make a secret: masked, autocomplete, a name that says password", () => {
    const doc = fakeDoc(PAGE);
    const masked = el(doc, "input", { type: "text" });
    masked.style["-webkit-text-security"] = "disc";
    expect(describeElement(masked).secret).toBe("password");
    expect(describeElement(el(doc, "input", { type: "text", name: "user_pwd" })).secret).toBe("password");
    expect(describeElement(el(doc, "input", { type: "text", id: "loginPassword" })).secret).toBe("password");
    expect(describeElement(el(doc, "input", { type: "text", name: "wachtwoord" })).secret).toBe("password");
    expect(describeElement(el(doc, "input", { type: "text", autocomplete: "current-password" })).secret).toBe("password");
    expect(describeElement(el(doc, "input", { type: "text", autocomplete: "one-time-code" })).secret).toBe("otp");
  });

  test("a field that only may take a code asks (maybeCode), and is not a secret for sure (second review)", () => {
    const doc = fakeDoc(PAGE);
    for (const attrs of [{ name: "pin" }, { id: "otpInput" }, { type: "tel", name: "sms_code", maxlength: "6" }, { inputmode: "numeric", maxlength: "1" }]) {
      const field = describeElement(el(doc, "input", { type: "text", ...attrs }));
      expect([field.secret, field.maybeCode], JSON.stringify(attrs)).toEqual([undefined, true]);
    }
  });

  test("the lookalikes are left alone: a ZIP code, a promo code, a one-digit quantity, a shipping PIN code field", () => {
    const doc = fakeDoc(PAGE);
    for (const attrs of [
      { name: "zip_code", inputmode: "numeric", maxlength: "5" },
      { name: "postal-code", type: "tel", maxlength: "5" },
      { name: "promo_code" },
      { name: "coupon_code", inputmode: "numeric", maxlength: "6" },
      { name: "qty", inputmode: "numeric", maxlength: "1" },
      { name: "quantity", type: "number", maxlength: "1" },
      { name: "shipping_pin_code", inputmode: "numeric", maxlength: "6" },
      { name: "shipping" },
    ]) {
      const field = describeElement(el(doc, "input", { type: "text", ...attrs }));
      expect([field.secret, field.maybeCode], JSON.stringify(attrs)).toEqual([undefined, false]);
    }
  });

  test("a form's fields are its elements — a password field joined with form= counts", () => {
    const doc = fakeDoc(PAGE);
    const form = el(doc, "form", { id: "login", action: "/session", method: "post" });
    const button = el(doc, "button", { type: "submit" }, "Go");
    form.append(button);
    const outside = el(doc, "input", { type: "password", form: "login" });
    form.elements = [button, outside];
    button.form = form;
    expect(describeElement(button)).toMatchObject({ submitsForm: true, formHasPassword: true, formAction: "/session", formMethod: "post" });
    expect(classifyAction({ kind: "click", origin: "http://shop.example", role: "button", text: "Go", submitsForm: true, formHasPassword: true }).categories).toContain("credentials");
  });

  test("round 3: whether the form's password field holds anything is read — never what, nor how long — and what text can be dropped into", () => {
    const doc = fakeDoc(PAGE);
    const form = el(doc, "form", { id: "signin", action: "/session" });
    const user = el(doc, "input", { type: "text", name: "user" });
    const secret = el(doc, "input", { type: "password" }) as FakeEl & { value?: string };
    const go = el(doc, "div", { role: "button" }, "Continue");
    form.append(user);
    form.append(secret);
    form.append(go);
    form.elements = [user, secret];
    expect(describeElement(go)).toMatchObject({ formHasPassword: true, passwordFilled: false, editable: false });
    secret.value = "hunter2-dragged-in";
    const described = describeElement(go);
    expect(described).toMatchObject({ passwordFilled: true });
    expect(JSON.stringify(described)).not.toContain("hunter2");
    expect(JSON.stringify(described)).not.toContain("18");
    expect(describeElement(user)).toMatchObject({ editable: true, passwordFilled: true });
    expect(describeElement(secret)).toMatchObject({ editable: true, secret: "password" });
    const pad = el(doc, "div", {}, "notes") as FakeEl & { isContentEditable?: boolean };
    pad.isContentEditable = true;
    expect(describeElement(pad)).toMatchObject({ editable: true });
  });

  test("a clickable joined to a form with form= sees the form's password field (second review, finding 6)", () => {
    const doc = fakeDoc(PAGE);
    const form = el(doc, "form", { id: "signin", action: "/session" });
    const secret = el(doc, "input", { type: "password" });
    form.append(secret);
    form.elements = [secret];
    const outside = el(doc, "div", { role: "button", form: "signin" }, "Continue");
    expect(describeElement(outside)).toMatchObject({ text: "Continue", clickable: true, formHasPassword: true });
    const inside = el(doc, "div", { onclick: "go()" }, "Continue");
    form.append(inside);
    expect(describeElement(inside)).toMatchObject({ clickable: true, formHasPassword: true });
  });

});

describe("describe.cjs: where it goes (findings 2 and 4)", () => {
  test("form targets and links keep their query and fragment", () => {
    const doc = fakeDoc(PAGE);
    const form = el(doc, "form", { action: "/delete?id=A#confirm", method: "POST" });
    const button = el(doc, "button", {}, "Delete");
    form.append(button);
    button.form = form;
    form.elements = [button];
    expect(describeElement(button)).toMatchObject({ formAction: "/delete?id=A#confirm", formMethod: "post" });
    const own = el(doc, "button", { formaction: "/other?x=1" }, "Delete");
    form.append(own);
    own.form = form;
    expect(describeElement(own).formAction).toBe("/other?x=1");
    const link = el(doc, "a", { href: "https://elsewhere.example/pay?amount=5#now" }, "Pay");
    expect(describeElement(link).href).toBe("https://elsewhere.example/pay?amount=5#now");
  });

  test("the row is found across shadow roots", () => {
    const doc = fakeDoc(PAGE);
    const row = el(doc, "li", {}, "Note B — Remember the milk");
    const host = el(doc, "note-card");
    row.append(host);
    const inner = el(doc, "div");
    inner.shadowHost = host;
    const button = el(doc, "button", {}, "Delete");
    inner.append(button);
    expect(describeElement(button).context).toBe("Note B — Remember the milk");
  });

  test("inside a frame, the frame's own origin and address are named; at the top, none", () => {
    const framed = fakeDoc("https://pay.example/checkout?s=9#card", true);
    expect(describeElement(el(framed, "button", {}, "Pay"))).toMatchObject({ frameOrigin: "https://pay.example", framePath: "/checkout?s=9#card" });
    const top = fakeDoc(PAGE);
    expect(describeElement(el(top, "button", {}, "Pay")).frameOrigin).toBeUndefined();
  });
});

describe("describe.cjs: which button submits (TASK-01)", () => {
  /** A button in a form, described as the list is told about it. */
  function inForm(attrs: Record<string, string>, method = "get") {
    const doc = fakeDoc(PAGE);
    const form = el(doc, "form", { action: "/search", method });
    const button = el(doc, "button", attrs, "Book now");
    form.append(button);
    form.elements = [button];
    button.form = form;
    return describeElement(button);
  }

  test("a type the HTML spec does not know is a submit button (its invalid-value default), and its formmethod wins", () => {
    // The probe: a GET form, a button type=x formmethod=post. It posts, so it is held whatever its label.
    const described = inForm({ type: "x", formmethod: "post" });
    expect(described).toMatchObject({ submitsForm: true, formMethod: "post", clickable: true, role: "button", text: "Book now" });
    const verdict = classifyAction({
      kind: "click",
      origin: "http://shop.example",
      role: described.role,
      text: described.text,
      submitsForm: described.submitsForm as boolean,
      formMethod: described.formMethod as string,
    });
    expect(verdict.sensitive).toBe(true);
    expect(verdict.rules).toContain("commit.submit");
  });

  test("only no type, submit and a type nobody knows submit; button, reset and menu do not, in any case", () => {
    for (const type of ["submit", "SUBMIT", "x", "Submit-Now", "bogus value"]) {
      expect(inForm({ type }).submitsForm, `type=${type}`).toBe(true);
    }
    expect(inForm({}).submitsForm, "no type").toBe(true);
    expect(inForm({ type: "" }).submitsForm, "empty type").toBe(true);
    for (const type of ["button", "BUTTON", "reset", "menu"]) {
      expect(inForm({ type }).submitsForm, `type=${type}`).toBe(false);
    }
  });
});

describe("the image carries what the scripts load", () => {
  test("every local module record.cjs and release.cjs require is copied by the Dockerfile", async () => {
    const dir = new URL("../../docker/browser/", import.meta.url);
    const dockerfile = await Bun.file(new URL("Dockerfile", dir)).text();
    const copied = dockerfile.split("\n").filter((line) => line.startsWith("COPY")).join(" ");
    for (const script of ["record.cjs", "release.cjs", "describe.cjs"]) {
      const source = await Bun.file(new URL(script, dir)).text();
      for (const match of source.matchAll(/require\("\.\/([^"]+)"\)/g)) expect(copied, `${script} requires ${match[1]}`).toContain(` ${match[1]}`);
    }
    // And every script under the image's `/opt/mind` directory that the entrypoint or the MCP config names.
    const named: string[] = [];
    for (const script of ["entrypoint.sh", "mcp-config.mjs"]) {
      const source = await Bun.file(new URL(script, dir)).text();
      for (const match of source.matchAll(/\/opt\/mind\/([a-z-]+\.(?:cjs|mjs|sh))/g)) {
        named.push(match[1]!);
        expect(copied, `${script} names ${match[1]}`).toContain(match[1]!);
      }
    }
    // The loop above used to look for a directory the Dockerfile no longer has, and checked nothing: it must find some.
    expect(named.length).toBeGreaterThan(0);
    expect(named).toContain("guard.mjs");
  });
});

describe("describe.cjs: the element an action really lands on (review of PR #24, round 4)", () => {
  /**
   * The review's repro: `fill` on a <label> fills its control (Playwright follows the label), and a
   * <button type=button onclick="f.submit()">Weiter</button> outside the form submits it.
   */
  function repro() {
    const doc = fakeDoc("http://login.example/signin");
    const form = el(doc, "form", { id: "f", action: "/login", method: "post" });
    const userLabel = el(doc, "label", {}, "Benutzer");
    const user = el(doc, "input", { name: "u" });
    userLabel.append(user);
    userLabel.control = user;
    const pwLabel = el(doc, "label", {}, "Kennung");
    const pw = el(doc, "input", { type: "password", name: "p" });
    pwLabel.append(pw);
    pwLabel.control = pw;
    form.append(userLabel, pwLabel);
    form.elements = [user, pw];
    user.form = form;
    pw.form = form;
    const weiter = el(doc, "button", { type: "button", onclick: "f.submit()" }, "Weiter");
    return { doc, form, userLabel, user, pwLabel, pw, weiter };
  }

  test("fill on a label is described as its control: a password label is a password field", () => {
    const { pwLabel, userLabel } = repro();
    expect(describeElement(pwLabel, "fill")).toMatchObject({ tag: "input", secret: "password", role: "textbox" });
    expect(describeElement(userLabel, "fill")).toMatchObject({ tag: "input", role: "textbox" });
    // As given, the label alone says nothing of the kind — the bypass.
    expect(describeElement(pwLabel).secret).toBeUndefined();
    expect(classifyAction({ kind: "fill", origin: "http://login.example", role: "textbox", text: "Kennung", valueClass: "password" }).sensitive).toBe(true);
  });

  test("a click lands on the closest button or link, and a label passes it to its control", () => {
    const doc = fakeDoc(PAGE);
    const button = el(doc, "button", {}, "Delete account");
    const icon = el(doc, "span", {}, "");
    button.append(icon);
    expect(describeElement(icon, "click")).toMatchObject({ tag: "button", text: "Delete account" });
    const submit = el(doc, "input", { type: "submit", value: "Pay" });
    const label = el(doc, "label", { for: "x" }, "Go");
    label.control = submit;
    expect(describeElement(label, "click")).toMatchObject({ tag: "input", role: "button" });
  });

});

describe("describe.cjs: where keys land, whatever the page did to its roots (review of PR #24, last round)", () => {
  test("a text field is a text field; a focusable div, a button or a checkbox is not", () => {
    const doc = fakeDoc(PAGE);
    for (const [tag, attrs] of [["input", {}], ["input", { type: "password" }], ["input", { type: "email" }], ["textarea", {}]] as const) {
      expect(describeElement(el(doc, tag, attrs)).textEntry).toBe(true);
    }
    const pad = el(doc, "div");
    pad.isContentEditable = true;
    expect(describeElement(pad).textEntry).toBe(true);
    for (const [tag, attrs] of [["div", { tabindex: "0" }], ["button", {}], ["input", { type: "checkbox" }], ["x-widget", { tabindex: "0" }]] as const) {
      expect(describeElement(el(doc, tag, attrs)).textEntry).toBe(false);
    }
  });

});
