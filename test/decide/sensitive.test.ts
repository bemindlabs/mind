/**
 * D-153 — the sensitive-actions list: fixed, add-only, and with nothing to switch it off.
 *
 * The floor below is the guard. Every category and every rule that has shipped is named here with an example
 * it must still catch. Removing a category or a rule, renaming one, or narrowing one until its example passes
 * unflagged fails this file. **Add to the floor when a rule is added; never take anything out of it.**
 */

import { describe, expect, test } from "bun:test";
import {
  COMMIT_RULES,
  KNOWN_KINDS,
  SENSITIVE_CATEGORIES,
  SENSITIVE_MEANING,
  SENSITIVE_RULES,
  classifyAction,
  normaliseText,
  type ActionDescriptor,
  type SensitiveCategory,
} from "../../src/decide/sensitive.ts";

const ORIGIN = "https://shop.example";
const click = (text: string, role = "button"): ActionDescriptor => ({ kind: "click", origin: ORIGIN, text, role });
const type = (text: string, valueClass: ActionDescriptor["valueClass"] = "text", role = "textbox"): ActionDescriptor => ({
  kind: "type",
  origin: ORIGIN,
  text,
  role,
  ...(valueClass === undefined ? {} : { valueClass }),
});

/** The categories D-153 names. Never shrinks. */
const CATEGORY_FLOOR: readonly SensitiveCategory[] = ["payment", "send", "delete", "credentials", "terms"];

/**
 * Every rule that has shipped, with the actions it must catch — several each, in English and Thai where the
 * rule has both, so narrowing a rule to keep one example passing still fails. Never shrinks.
 */
const RULE_FLOOR: readonly { readonly id: string; readonly category: SensitiveCategory; readonly examples: readonly ActionDescriptor[] }[] = [
  { id: "payment.words", category: "payment", examples: [click("Pay now"), click("Place order"), click("Checkout"), click("Subscribe"), click("ชำระเงิน"), click("สั่งซื้อ")] },
  { id: "payment.card-value", category: "payment", examples: [type("Card", "card"), type("Anything at all", "card")] },
  { id: "send.words", category: "send", examples: [click("Send"), click("Reply all"), click("Publish"), click("Post"), click("ส่งข้อความ"), click("แชร์")] },
  { id: "delete.words", category: "delete", examples: [click("Delete repository"), click("Remove"), click("Move to trash"), click("Close account"), click("ลบไฟล์")] },
  { id: "credentials.value", category: "credentials", examples: [type("Anything", "password"), type("Code", "otp"), type("Key", "secret")] },
  { id: "credentials.field", category: "credentials", examples: [type("Password"), type("API key"), type("Verification code"), type("รหัสผ่าน"), type("Passwort"), type("Mot de passe"), type("Contraseña"), type("パスワード"), type("密码"), type("密碼"), type("비밀번호"), type("Wachtwoord"), type("Hasło"), type("Senha")] },
  { id: "credentials.grant", category: "credentials", examples: [click("Sign in"), click("Log in"), click("Continue with Google"), click("เข้าสู่ระบบ"), click("Anmelden"), click("Se connecter"), click("Iniciar sesión"), click("ログイン"), click("登录"), click("로그인")] },
  { id: "credentials.allow", category: "credentials", examples: [click("Allow"), click("Authorize app"), click("Grant permission"), click("อนุญาต")] },
  {
    id: "credentials.login-submit",
    category: "credentials",
    examples: [
      { kind: "click", origin: ORIGIN, text: "Go", role: "button", submitsForm: true, formHasPassword: true },
      { kind: "press", origin: ORIGIN, text: "user", role: "textbox", key: "Enter", formHasPassword: true },
      { kind: "submit", origin: ORIGIN, formHasPassword: true },
      { kind: "type", origin: ORIGIN, text: "user", role: "textbox", valueClass: "text", submits: true, formHasPassword: true },
    ],
  },
  { id: "terms.words", category: "terms", examples: [click("I agree"), click("Accept all"), click("I consent"), click("ยอมรับ")] },
  {
    id: "terms.checkbox",
    category: "terms",
    examples: [
      { kind: "check", origin: ORIGIN, text: "Terms of Service", role: "checkbox" },
      { kind: "check", origin: ORIGIN, text: "I have read the privacy policy", role: "checkbox" },
      { kind: "check", origin: ORIGIN, text: "ข้อกำหนดการใช้งาน", role: "checkbox" },
    ],
  },
];

/** Every commit rule that has shipped, with the steps it must catch. Never shrinks. */
const COMMIT_FLOOR: readonly { readonly id: string; readonly examples: readonly ActionDescriptor[] }[] = [
  {
    id: "commit.submit",
    examples: [
      { kind: "submit", origin: ORIGIN },
      { kind: "submit", origin: ORIGIN, text: "Next" },
      // TASK-01: a form's submit control commits whatever its label says — a click, a key on it, a check on it.
      { kind: "click", origin: ORIGIN, text: "Book now", role: "button", submitsForm: true },
      { kind: "click", origin: ORIGIN, text: "Place bid", role: "button", submitsForm: true, formMethod: "get", formRole: "form" },
      { kind: "press", origin: ORIGIN, text: "Withdraw", role: "button", key: "Space", submitsForm: true },
      { kind: "check", origin: ORIGIN, text: "Create account", role: "checkbox", submitsForm: true },
    ],
  },
  {
    id: "commit.form-post",
    examples: [
      { kind: "click", origin: ORIGIN, text: "Expand", role: "button", formMethod: "post", formRole: "form" },
      { kind: "click", origin: ORIGIN, text: "Next page", role: "link", formMethod: "POST" },
      { kind: "click", origin: ORIGIN, text: "Close", role: "button", formMethod: "dialog" },
    ],
  },
  {
    id: "commit.enter",
    examples: [
      { kind: "press", origin: ORIGIN, key: "Enter" },
      { kind: "press", origin: ORIGIN, key: "Control+Enter" },
      { kind: "press", origin: ORIGIN, text: "Return" },
      { kind: "type", origin: ORIGIN, text: "Message", role: "textbox", submits: true },
    ],
  },
  { id: "commit.confirm", examples: [click("Submit"), click("Confirm"), click("OK"), click("Proceed"), click("ยืนยัน"), click("ตกลง")] },
];

describe("the list is fixed and add-only (D-153)", () => {
  test("every category ever listed is still listed, in D-153's order", () => {
    for (const category of CATEGORY_FLOOR) expect(SENSITIVE_CATEGORIES).toContain(category);
    expect(SENSITIVE_CATEGORIES.slice(0, CATEGORY_FLOOR.length)).toEqual([...CATEGORY_FLOOR]);
    for (const category of SENSITIVE_CATEGORIES) {
      expect(SENSITIVE_MEANING[category].en).not.toBe("");
      expect(SENSITIVE_MEANING[category].th).not.toBe("");
    }
  });

  test("every rule ever shipped is still there, in its category, and still catches its example", () => {
    const ids = SENSITIVE_RULES.map((rule) => rule.id);
    for (const floor of RULE_FLOOR) {
      const rule = SENSITIVE_RULES.find((r) => r.id === floor.id);
      expect(rule, `rule ${floor.id} was removed or renamed`).toBeDefined();
      expect(rule!.category).toBe(floor.category);
      expect(floor.examples.length).toBeGreaterThan(1);
      for (const example of floor.examples) {
        const verdict = classifyAction(example);
        expect(verdict.rules, `${floor.id} no longer catches ${JSON.stringify(example)}`).toContain(floor.id);
        expect(verdict.sensitive).toBe(true);
        expect(verdict.categories).toContain(floor.category);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every commit rule ever shipped is still there and still catches its examples", () => {
    for (const floor of COMMIT_FLOOR) {
      expect(COMMIT_RULES.some((rule) => rule.id === floor.id), `commit rule ${floor.id} was removed or renamed`).toBe(true);
      expect(floor.examples.length).toBeGreaterThan(1);
      for (const example of floor.examples) {
        const verdict = classifyAction(example);
        expect(verdict.rules, `${floor.id} no longer catches ${JSON.stringify(example)}`).toContain(floor.id);
        expect(verdict.sensitive).toBe(true);
      }
    }
  });

  test("patterns are source strings, so nothing a caller can reach is a RegExp to recompile (review of #18)", () => {
    for (const rule of SENSITIVE_RULES) for (const source of rule.text ?? []) expect(typeof source).toBe("string");
    // The attack the review measured: recompile every pattern to one that never matches. There is no RegExp to
    // reach; calling compile on anything the module hands out is not possible, and the list still catches.
    const reachable: unknown[] = SENSITIVE_RULES.flatMap((rule) => [...(rule.text ?? [])]);
    expect(reachable.some((value) => value instanceof RegExp)).toBe(false);
    expect(() => {
      (SENSITIVE_RULES[0] as unknown as { text: unknown }).text = [];
    }).toThrow();
    expect(classifyAction(click("Pay now")).sensitive).toBe(true);
  });

  test("every category has at least one rule", () => {
    for (const category of SENSITIVE_CATEGORIES) expect(SENSITIVE_RULES.some((rule) => rule.category === category)).toBe(true);
  });

  test("nothing in it can be changed at run time", () => {
    expect(Object.isFrozen(SENSITIVE_CATEGORIES)).toBe(true);
    expect(Object.isFrozen(SENSITIVE_RULES)).toBe(true);
    expect(Object.isFrozen(SENSITIVE_MEANING)).toBe(true);
    expect(Object.isFrozen(KNOWN_KINDS)).toBe(true);
    expect(Object.isFrozen(COMMIT_RULES)).toBe(true);
    for (const rule of COMMIT_RULES) expect(Object.isFrozen(rule)).toBe(true);
    for (const rule of SENSITIVE_RULES) {
      expect(Object.isFrozen(rule)).toBe(true);
      if (rule.text !== undefined) expect(Object.isFrozen(rule.text)).toBe(true);
      if (rule.values !== undefined) expect(Object.isFrozen(rule.values)).toBe(true);
    }
    expect(() => (SENSITIVE_RULES as SensitiveRuleArray).pop()).toThrow();
    expect(() => (SENSITIVE_CATEGORIES as string[]).splice(0, 1)).toThrow();
  });

  test("the classifier takes the action and nothing else — there is no level, option or allow list to pass", () => {
    expect(classifyAction.length).toBe(1);
  });
});

type SensitiveRuleArray = unknown[];

describe("what pauses, at every level", () => {
  test("payment, in English and Thai", () => {
    for (const text of ["Buy now", "Place order", "Checkout", "Subscribe", "Donate", "Transfer"]) {
      expect(classifyAction(click(text)).categories).toContain("payment");
    }
    expect(classifyAction(click("ชำระเงิน")).categories).toContain("payment");
    expect(classifyAction(click("สั่งซื้อ")).categories).toContain("payment");
  });

  test("sending a message or an e-mail", () => {
    for (const text of ["Send", "Send email", "Post", "Reply all", "Publish", "Share"]) {
      expect(classifyAction(click(text)).categories).toContain("send");
    }
    expect(classifyAction({ kind: "submit", origin: ORIGIN, text: "ส่งข้อความ" }).categories).toContain("send");
  });

  test("deleting", () => {
    for (const text of ["Delete", "Remove", "Move to trash", "Close account"]) {
      expect(classifyAction(click(text)).categories).toContain("delete");
    }
    expect(classifyAction(click("ลบไฟล์")).categories).toContain("delete");
  });

  test("entering credentials: by the value class whatever the label, or by the field's label", () => {
    expect(classifyAction(type("Name", "password")).categories).toEqual(["credentials"]);
    expect(classifyAction(type("Code", "otp")).categories).toEqual(["credentials"]);
    expect(classifyAction(type("API key")).categories).toContain("credentials");
    expect(classifyAction(type("รหัสผ่าน")).categories).toContain("credentials");
    // A field whose role is not known is taken as a field: the list errs towards stopping.
    expect(classifyAction({ kind: "fill", origin: ORIGIN, text: "PIN" }).categories).toContain("credentials");
  });

  test("accepting terms", () => {
    expect(classifyAction(click("Accept all")).categories).toContain("terms");
    expect(classifyAction(click("ยอมรับ")).categories).toContain("terms");
    expect(classifyAction({ kind: "check", origin: ORIGIN, text: "I have read the privacy policy", role: "checkbox" }).categories).toContain("terms");
  });

  test("one action can be in several categories, each said once, in list order", () => {
    const verdict = classifyAction(click("Agree and pay"));
    expect(verdict.categories).toEqual(["payment", "terms"]);
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toContain("on https://shop.example");
    expect(verdict.reasons[0]).toContain("จ่ายเงิน");
  });

  test("a step kind the list does not know pauses rather than being guessed harmless", () => {
    const verdict = classifyAction({ kind: "drag", origin: ORIGIN, text: "Card" });
    expect(verdict.sensitive).toBe(true);
    expect(verdict.rules).toEqual(["unknown-kind"]);
    expect(verdict.reasons[0]).toContain("drag");
    expect(classifyAction({ kind: 7 as unknown as string, origin: ORIGIN }).sensitive).toBe(true);
  });
});

describe("steps that commit, without saying what (review of #18)", () => {
  test("a generic submit, Enter, Confirm or OK waits for a yes, with a reason and no invented category", () => {
    const verdict = classifyAction({ kind: "submit", origin: ORIGIN });
    expect(verdict.sensitive).toBe(true);
    expect(verdict.categories).toEqual([]);
    expect(verdict.rules).toEqual(["commit.submit"]);
    expect(verdict.reasons[0]).toContain("commits whatever the page holds on https://shop.example");
    expect(classifyAction({ kind: "press", origin: ORIGIN, key: "Meta+Enter" }).rules).toContain("commit.enter");
  });

  test("a commit that is also in a category is said as the category", () => {
    const verdict = classifyAction({ kind: "submit", origin: ORIGIN, text: "Pay now" });
    expect(verdict.categories).toEqual(["payment"]);
    expect(verdict.rules).toEqual(["payment.words", "commit.submit"]);
    expect(verdict.reasons).toHaveLength(1);
  });

  test("search is the context that makes a commit harmless", () => {
    expect(classifyAction({ kind: "submit", origin: ORIGIN, formRole: "search" }).sensitive).toBe(false);
    expect(classifyAction({ kind: "press", origin: ORIGIN, key: "Enter", role: "searchbox" }).sensitive).toBe(false);
    expect(classifyAction({ kind: "type", origin: ORIGIN, text: "Search", role: "searchbox", valueClass: "search", submits: true }).sensitive).toBe(false);
    // …but not for anything in the five: a "Pay" button inside a search form still pauses.
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "Pay now", role: "button", formRole: "search" }).categories).toEqual(["payment"]);
  });

  test("keys that do not submit, and typing that does not, do not pause", () => {
    for (const key of ["Tab", "ArrowDown", "Escape", "Shift"]) expect(classifyAction({ kind: "press", origin: ORIGIN, key }).sensitive).toBe(false);
    expect(classifyAction({ kind: "type", origin: ORIGIN, text: "City", role: "textbox", submits: false }).sensitive).toBe(false);
    // Typing "ok" into a field is not answering OK.
    expect(classifyAction({ kind: "type", origin: ORIGIN, text: "OK", role: "textbox" }).sensitive).toBe(false);
  });
});

describe("what does not pause", () => {
  test("looking and moving around, whatever the text", () => {
    for (const kind of ["navigate", "scroll", "read", "screenshot", "hover", "back", "wait"]) {
      expect(classifyAction({ kind, origin: ORIGIN, text: "Pay now · Delete" }).sensitive).toBe(false);
    }
  });

  test("ordinary controls and ordinary typing", () => {
    expect(classifyAction(click("Next page")).sensitive).toBe(false);
    expect(classifyAction(click("Display settings")).sensitive).toBe(false); // `display` is not `pay`
    expect(classifyAction(click("Messages", "link")).sensitive).toBe(false);
    expect(classifyAction(type("Search", "search", "searchbox")).sensitive).toBe(false);
    expect(classifyAction(type("City")).sensitive).toBe(false);
    expect(classifyAction({ kind: "click", origin: ORIGIN }).sensitive).toBe(false);
  });

  test("a terms link is only reading; ticking the box is not", () => {
    expect(classifyAction(click("Terms of Service", "link")).sensitive).toBe(false);
    expect(classifyAction(click("Terms of Service", "checkbox")).sensitive).toBe(true);
  });

  test("text is compared normalised: case, spacing and Unicode form", () => {
    expect(normaliseText("  PAY\n  Now ")).toBe("pay now");
    expect(classifyAction(click("  PAY\tNOW  ")).sensitive).toBe(true);
    expect(normaliseText("ชำระ".normalize("NFD"))).toBe("ชำระ".normalize("NFC"));
  });
});

describe("credentials.login-submit (re-review of PR #19)", () => {
  test("a neutral button in a form without a password field is not a login, and a non-submit button in one is not either", () => {
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "Go", role: "button", submitsForm: true, formHasPassword: false }).rules).not.toContain("credentials.login-submit");
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "Show", role: "button", submitsForm: false, formHasPassword: true }).rules).not.toContain("credentials.login-submit");
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "Go", role: "button", submitsForm: true }).rules).not.toContain("credentials.login-submit");
  });

  test("a login submit is held even inside a search-looking form", () => {
    const verdict = classifyAction({ kind: "click", origin: ORIGIN, text: "Go", role: "button", submitsForm: true, formHasPassword: true, formRole: "search" });
    expect(verdict.sensitive).toBe(true);
    expect(verdict.categories).toEqual(["credentials"]);
  });
});
