/**
 * TASK-01 (security review 2026-10-13): the always-pause floor for browser acting was a word list, and a click on
 * a form's submit control whose label was not on it went through with no yes ("Book now", "Place bid",
 * "Withdraw", "Create account", "Approve", labels in other languages). The floor now also holds by what the step
 * *does*: a submit control (`submitsForm`) on `click`, `press` or `check` is `commit.submit`, and a click inside a
 * form whose method is not GET is `commit.form-post`, whatever the label says.
 *
 * What stays out of the floor, and is pinned here so nobody reads the rule as wider than it is: a link, or a
 * control that is not a submit and not in a POST form, passes unless its words match one of the lists (the
 * classifier cannot see what a script behind a `<button type="button">` will do); and a GET form that is a search
 * still passes.
 */

import { describe, expect, test } from "bun:test";
import { classifyAction, type ActionDescriptor } from "../../src/decide/sensitive.ts";

const ORIGIN = "https://shop.example";

/** A form's submit control, as the container describes it: `<button>` or `<input type=submit>` inside a form. */
const submit = (text: string, extra: Partial<ActionDescriptor> = {}): ActionDescriptor => ({
  kind: "click",
  origin: ORIGIN,
  text,
  role: "button",
  submitsForm: true,
  formHasPassword: false,
  ...extra,
});

/**
 * Labels of submit controls. The review ran 61 of them and 55 went through; it names 40 of the 61 (the other 21
 * are not written down in the review), so those 40 are all here and the rest of the list is added, in more
 * scripts. Six were already held by a word (the first group); the others were not, and are the ones this task
 * is about. The labels are not asserted to be *absent* from the word lists anywhere: adding a word is allowed,
 * and a test that forbade it would be a switch against the list.
 */
const ALREADY_HELD_BY_A_WORD = ["Pay now", "Submit", "Complete purchase", "Pay", "Erase all", "Revoke access"];

const REVIEW_ENGLISH = [
  "Book now", "Reserve", "Order", "Place bid", "Bid now", "Withdraw", "Renew", "Cancel order", "Cancel booking", "Create account",
  "Sign up", "Register", "Continue", "Approve", "Release", "Charge", "Reset", "Install", "Enable", "Block", "Report",
];

const REVIEW_OTHER_LANGUAGES = [
  "Jetzt kaufen", "Comprar ahora", "Payer", "購入する", "支付", "删除", "삭제", "Удалить", "Оплатить", "Senden", "Löschen", "Akzeptieren", "同意",
];

const MORE_ENGLISH = [
  "Book", "Reserve seat", "Make offer", "Hire", "Apply", "Apply for loan", "Enroll", "Join", "Activate", "Claim", "Redeem", "Pledge", "Sponsor",
  "Vote", "Cash out", "Refund", "Withdraw funds", "Transfer ownership", "Cancel", "Unlink", "Link account", "Disable", "Deny", "Reject", "Merge",
  "Deploy", "Launch", "Terminate", "Reboot", "Format", "Archive", "Clear all", "Get started", "Next", "Go", "Save", "Update", "Download", "Verify",
  "Enter", "Add to cart", "Confirm and book", "Sell", "List item", "Bet", "Place bet", "Hold", "Escalate", "Finalize", "Authorize payment",
];

const MORE_OTHER_LANGUAGES = [
  // German
  "Bestellen", "Buchen", "Bezahlen", "Konto erstellen", "Abschicken", "Bestätigen und buchen", "Entfernen",
  // French
  "Supprimer", "Envoyer", "Acheter", "Réserver", "Valider", "Accepter", "Commander", "Créer un compte",
  // Spanish and Portuguese
  "Pagar", "Eliminar", "Enviar", "Aceptar", "Reservar", "Crear cuenta", "Comprar", "Excluir", "Criar conta",
  // Italian
  "Acquista", "Elimina", "Invia", "Paga ora", "Prenota",
  // Dutch, Polish, Turkish, Vietnamese, Indonesian
  "Bestellen en betalen", "Kup teraz", "Wyślij", "Usuń", "Satın al", "Sil", "Gönder", "Mua ngay", "Xóa", "Gửi", "Beli sekarang", "Hapus", "Kirim",
  // Japanese, Chinese, Korean
  "削除", "送信", "同意する", "予約する", "提交", "购买", "下单", "提现", "구매", "결제", "전송", "동의",
  // Russian, Arabic, Hindi
  "Отправить", "Купить", "Принять", "Забронировать", "شراء", "حذف", "إرسال", "ادفع الآن", "खरीदें", "हटाएं", "भेजें",
  // Thai
  "จองเลย", "ถอนเงิน", "สมัคร", "ลงทะเบียน", "ประมูล", "ยืนยันการจอง", "สร้างบัญชี", "อนุมัติ",
];

const LABELS: readonly string[] = [
  ...ALREADY_HELD_BY_A_WORD,
  ...REVIEW_ENGLISH,
  ...REVIEW_OTHER_LANGUAGES,
  ...MORE_ENGLISH,
  ...MORE_OTHER_LANGUAGES,
];

describe("the label table is what the review measured, and more", () => {
  test("at least the 61 labels of the review, each once, and every one the review names", () => {
    expect(new Set(LABELS).size).toBe(LABELS.length);
    expect(ALREADY_HELD_BY_A_WORD.length + REVIEW_ENGLISH.length + REVIEW_OTHER_LANGUAGES.length).toBe(40);
    expect(LABELS.length).toBeGreaterThanOrEqual(61);
    expect(LABELS.length).toBeGreaterThanOrEqual(150);
  });
});

describe("a submit control is held whatever it says (TASK-01)", () => {
  test("every label, on a click on a form's submit control, with nothing else known about the form", () => {
    for (const label of LABELS) {
      const verdict = classifyAction(submit(label));
      expect(verdict.sensitive, `a click on a submit control labelled ${JSON.stringify(label)} passed unheld`).toBe(true);
      expect(verdict.rules, `${JSON.stringify(label)}`).toContain("commit.submit");
    }
  });

  test("…in a GET form that is not a search, in a POST form, and in a form whose method is not said", () => {
    for (const label of LABELS) {
      for (const formMethod of ["get", "post", "dialog", undefined]) {
        const action = submit(label, { formRole: "form", ...(formMethod === undefined ? {} : { formMethod }) });
        const verdict = classifyAction(action);
        expect(verdict.sensitive, `${JSON.stringify(label)} in a ${String(formMethod)} form passed unheld`).toBe(true);
        expect(verdict.rules).toContain("commit.submit");
      }
    }
  });

  test("…and the Enter or Space that presses it, and a check on it", () => {
    for (const label of LABELS) {
      for (const key of ["Enter", "Space", " ", "Control+Enter"]) {
        const verdict = classifyAction(submit(label, { kind: "press", key }));
        expect(verdict.sensitive, `${key} on ${JSON.stringify(label)} passed unheld`).toBe(true);
        expect(verdict.rules).toContain("commit.submit");
      }
      const checked = classifyAction(submit(label, { kind: "check", role: "checkbox" }));
      expect(checked.sensitive, `a check on ${JSON.stringify(label)} passed unheld`).toBe(true);
      expect(checked.rules).toContain("commit.submit");
    }
  });

  test("a Tab or an Escape on it does not press it: no yes for moving on or cancelling, whatever the label (verifier finding, low)", () => {
    const NOT_IN_ANY_LIST = ["Book now", "Place bid", "Withdraw", "Reserve", "จองเลย", "予約する", "Забронировать"];
    for (const label of NOT_IN_ANY_LIST) {
      for (const key of ["Tab", "Escape", "Esc", "tab", "ESCAPE", "Shift+Tab", "Control+Shift+Tab", "ControlOrMeta+Escape", "Alt+Tab"]) {
        for (const formMethod of ["get", "post", undefined]) {
          const verdict = classifyAction(submit(label, { kind: "press", key, ...(formMethod === undefined ? {} : { formMethod }) }));
          expect(verdict.sensitive, `${key} on ${JSON.stringify(label)} in a ${String(formMethod)} form was held`).toBe(false);
          expect(verdict.rules).toEqual([]);
        }
      }
    }
  });

  test("…but it is the key the caller says, never the label: no key, a non-string key, a chord with a key that is not a modifier", () => {
    // A press with no `key` is read by the element's text, and a button called "Escape" or "Tab" is a button.
    for (const label of ["Escape", "Tab", "Esc"]) {
      const verdict = classifyAction(submit(label, { kind: "press" }));
      expect(verdict.sensitive, `a press with no key on a submit control labelled ${label} passed unheld`).toBe(true);
      expect(verdict.rules).toContain("commit.submit");
    }
    for (const key of [undefined, 9, null, {}, ["Tab"], "", " ", "Enter+Tab", "Space+Tab", "a+Tab", "Tab+Enter", "Foo+Tab", "Tab Tab", "Tabs", "Shift + Tab"]) {
      const action = { ...submit("Book now", { kind: "press" }), key } as unknown as ActionDescriptor;
      const verdict = classifyAction(action);
      expect(verdict.sensitive, `${JSON.stringify(key)} on a submit control passed unheld`).toBe(true);
      expect(verdict.rules).toContain("commit.submit");
    }
  });

  test("…and the keys that do press it, and the label words, still hold", () => {
    for (const key of ["Enter", "NumpadEnter", "Space", " ", "Control+Enter", "Shift+Enter", "a", "ArrowDown"]) {
      expect(classifyAction(submit("Book now", { kind: "press", key })).rules, key).toContain("commit.submit");
    }
    // A label from the word lists is held by its word on any key, as before TASK-01.
    const paid = classifyAction(submit("Pay now", { kind: "press", key: "Tab" }));
    expect(paid.categories).toEqual(["payment"]);
    expect(paid.rules).not.toContain("commit.submit");
    // The click and the check are not keys: Tab-or-Escape changes nothing for them.
    expect(classifyAction(submit("Book now", { key: "Tab" })).rules).toContain("commit.submit");
    expect(classifyAction(submit("Book now", { kind: "check", role: "checkbox", key: "Escape" })).rules).toContain("commit.submit");
    // A login's submit control holds for the credentials rule on its own, a Tab included (not changed here).
    expect(classifyAction(submit("Go", { kind: "press", key: "Tab", formHasPassword: true })).categories).toEqual(["credentials"]);
  });

  test("the role and the case do not matter: an <input type=submit>, a button with no role, an upper-case kind", () => {
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "Book now", submitsForm: true }).sensitive).toBe(true);
    expect(classifyAction(submit("Book now", { role: "link" })).sensitive).toBe(true);
    expect(classifyAction(submit("Book now", { kind: "CLICK" })).sensitive).toBe(true);
    expect(classifyAction({ kind: "click", origin: ORIGIN, submitsForm: true }).sensitive).toBe(true);
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "", role: "button", submitsForm: true }).sensitive).toBe(true);
  });

  test("an unlisted label says it commits, and invents no category", () => {
    const verdict = classifyAction(submit("Book now"));
    expect(verdict.categories).toEqual([]);
    expect(verdict.rules).toEqual(["commit.submit"]);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain("commits whatever the page holds on https://shop.example");
  });

  test("a listed label is still said as its category, with the commit kept as a rule", () => {
    const verdict = classifyAction(submit("Pay now"));
    expect(verdict.categories).toEqual(["payment"]);
    expect(verdict.rules).toEqual(["payment.words", "commit.submit"]);
    expect(verdict.reasons).toHaveLength(1);
  });

  test("only a submit control counts: submitsForm must be exactly true", () => {
    for (const submitsForm of [false, undefined]) {
      const action: ActionDescriptor = { kind: "click", origin: ORIGIN, text: "Expand", role: "button", ...(submitsForm === undefined ? {} : { submitsForm }) };
      expect(classifyAction(action).sensitive).toBe(false);
    }
    for (const odd of ["true", 1, "yes", {}]) {
      const action = { kind: "click", origin: ORIGIN, text: "Expand", role: "button", submitsForm: odd } as unknown as ActionDescriptor;
      expect(classifyAction(action).sensitive, `submitsForm ${JSON.stringify(odd)} is not the boolean the container writes`).toBe(false);
    }
  });
});

describe("a click inside a form that is not a GET is held, submit control or not (TASK-01)", () => {
  const inside = (text: string, formMethod: string, role: string | null = "button"): ActionDescriptor => ({
    kind: "click",
    origin: ORIGIN,
    text,
    ...(role === null ? {} : { role }),
    submitsForm: false,
    formRole: "form",
    formMethod,
  });

  test("a control that is not a submit, in a POST form, in any case or spacing", () => {
    for (const formMethod of ["post", "POST", " Post ", "dialog", "put", "delete"]) {
      for (const text of ["Expand", "Book now", "Place bid", "ยืนยันการจอง", "Zahlen"]) {
        const verdict = classifyAction(inside(text, formMethod));
        expect(verdict.sensitive, `${JSON.stringify(text)} in a ${JSON.stringify(formMethod)} form passed unheld`).toBe(true);
        expect(verdict.rules).toContain("commit.form-post");
      }
    }
  });

  test("a link, a menu item, a checkbox and a control with no text, in a POST form", () => {
    for (const [role, text] of [["link", "Next page"], ["menuitem", "More"], ["checkbox", "Remember me"], ["button", ""], [null, "Open"]] as const) {
      const verdict = classifyAction(inside(text, "post", role));
      expect(verdict.sensitive, `${String(role)} ${JSON.stringify(text)}`).toBe(true);
      expect(verdict.rules).toContain("commit.form-post");
    }
  });

  test("a method that cannot be read as GET is not taken as one", () => {
    expect(classifyAction(inside("Expand", 7 as unknown as string)).sensitive).toBe(true);
    expect(classifyAction(inside("Expand", "g e t")).sensitive).toBe(true);
    expect(classifyAction(inside("Expand", "get;post")).sensitive).toBe(true);
  });

  test("it says it commits, with no invented category; a listed word is still its category", () => {
    const verdict = classifyAction(inside("Expand", "post"));
    expect(verdict.categories).toEqual([]);
    expect(verdict.rules).toEqual(["commit.form-post"]);
    expect(verdict.reasons[0]).toContain("commits whatever the page holds on https://shop.example");
    const named = classifyAction(inside("Delete", "post"));
    expect(named.categories).toEqual(["delete"]);
    expect(named.rules).toEqual(["delete.words", "commit.form-post"]);
  });

  test("a submit control in a POST form is said once, as a submit", () => {
    const verdict = classifyAction(submit("Book now", { formMethod: "post" }));
    expect(verdict.rules).toEqual(["commit.submit"]);
  });

  test("typing into the form's fields and moving around in it are not clicks, and do not pause", () => {
    expect(classifyAction({ kind: "type", origin: ORIGIN, text: "City", role: "textbox", valueClass: "text", formRole: "form", formMethod: "post" }).sensitive).toBe(false);
    expect(classifyAction({ kind: "fill", origin: ORIGIN, text: "City", role: "textbox", valueClass: "text", formRole: "form", formMethod: "post" }).sensitive).toBe(false);
    for (const key of ["Tab", "ArrowDown", "Escape"]) {
      expect(classifyAction({ kind: "press", origin: ORIGIN, key, role: "textbox", formMethod: "post" }).sensitive).toBe(false);
    }
    expect(classifyAction({ kind: "hover", origin: ORIGIN, text: "Book now", role: "button", formMethod: "post", submitsForm: true }).sensitive).toBe(false);
    expect(classifyAction({ kind: "scroll", origin: ORIGIN, formMethod: "post", submitsForm: true }).sensitive).toBe(false);
  });
});

describe("what still passes", () => {
  test("a plain link, and a control that is not a submit and not in a form", () => {
    for (const [role, text] of [["link", "Read more"], ["link", "Next page"], ["button", "Expand"], ["button", "Show details"], ["menuitem", "Settings"], ["tab", "Reviews"]] as const) {
      expect(classifyAction({ kind: "click", origin: ORIGIN, text, role }).sensitive, `${role} ${text}`).toBe(false);
      expect(classifyAction({ kind: "click", origin: ORIGIN, text, role, submitsForm: false }).sensitive, `${role} ${text}`).toBe(false);
    }
    expect(classifyAction({ kind: "click", origin: ORIGIN, role: "button" }).sensitive).toBe(false);
  });

  test("a control that is not a submit, in a GET form, or in a form whose method is not said", () => {
    for (const formMethod of ["get", "GET", " get ", undefined]) {
      const action: ActionDescriptor = {
        kind: "click",
        origin: ORIGIN,
        text: "Show more",
        role: "button",
        submitsForm: false,
        formRole: "form",
        ...(formMethod === undefined ? {} : { formMethod }),
      };
      expect(classifyAction(action).sensitive, `a plain button in a ${String(formMethod)} form`).toBe(false);
    }
    // An empty method is "not said" (the container never sends one), not a POST.
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "Show more", role: "button", formMethod: "" }).sensitive).toBe(false);
  });

  test("the GET search form: its submit control, the Enter in its box, and typing into it", () => {
    const search = { formRole: "search", formMethod: "get" } as const;
    expect(classifyAction(submit("Go", search)).sensitive).toBe(false);
    expect(classifyAction(submit("Book now", search)).sensitive).toBe(false);
    expect(classifyAction(submit("Search", { ...search, kind: "press", key: "Enter" })).sensitive).toBe(false);
    expect(classifyAction({ kind: "press", origin: ORIGIN, key: "Enter", role: "searchbox", ...search }).sensitive).toBe(false);
    expect(classifyAction({ kind: "type", origin: ORIGIN, text: "Search", role: "searchbox", valueClass: "search", submits: true, ...search }).sensitive).toBe(false);
    // The container's own spelling of a GET method: lower case, as the DOM gives it.
    expect(classifyAction(submit("Go", { formRole: "search", formMethod: "GET" })).sensitive).toBe(false);
    // …and the case the existing floor already knows, with the method not said.
    expect(classifyAction(submit("Go", { formRole: "search" })).sensitive).toBe(false);
  });

  test("…but only while it asks: a search form that posts, or a word from the five, or a password, is held", () => {
    // The page names its own role. A form that posts is not a search that "asks and changes nothing".
    expect(classifyAction(submit("Go", { formRole: "search", formMethod: "post" })).rules).toContain("commit.submit");
    expect(classifyAction(submit("Go", { formRole: "search", formMethod: "dialog" })).sensitive).toBe(true);
    expect(classifyAction({ kind: "click", origin: ORIGIN, text: "Expand", role: "button", formRole: "search", formMethod: "post" }).sensitive).toBe(true);
    expect(classifyAction({ kind: "press", origin: ORIGIN, key: "Enter", role: "searchbox", formRole: "search", formMethod: "post" }).sensitive).toBe(true);
    expect(
      classifyAction({ kind: "type", origin: ORIGIN, text: "Search", role: "searchbox", valueClass: "search", submits: true, formRole: "search", formMethod: "post" }).sensitive,
    ).toBe(true);
    expect(classifyAction(submit("Pay now", { formRole: "search", formMethod: "get" })).categories).toEqual(["payment"]);
    expect(classifyAction(submit("Go", { formRole: "search", formMethod: "get", formHasPassword: true })).categories).toEqual(["credentials"]);
  });

  test("a submit control in a form that is not a search is held even when the form GETs", () => {
    // A plain GET form (no role=search) with a "Search" button cannot be told from a GET form that books: one yes.
    expect(classifyAction(submit("Search", { formRole: "form", formMethod: "get" })).sensitive).toBe(true);
  });
});

describe("the classifier is still the same kind of thing", () => {
  test("it takes the action and nothing else, and does not change what it was given", () => {
    expect(classifyAction.length).toBe(1);
    const action = Object.freeze(submit("Book now", { formMethod: "post" }));
    expect(() => classifyAction(action)).not.toThrow();
    expect(Object.isFrozen(classifyAction(action))).toBe(true);
  });
});
