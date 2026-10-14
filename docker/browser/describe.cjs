// What D-153's list needs to know about an element — never its value. Split from record.cjs so the reading can
// be tested against element fixtures in Bun (test/browser/describe.test.ts). `describeElement` closes over
// nothing: cdp-read.cjs hands it as source text to `Runtime.callFunctionOn` in an isolated world of its own, so
// it reads the DOM through the browser's own getters, never the page's (review of PR #24, last round). Where
// keys go, what is at a point, shadow hosts and fields once seen as passwords are cdp-read.cjs's to find.
"use strict";

/**
 * Describe `element` for the list. Self-contained: it runs in an isolated world of the element's frame, with
 * only the DOM.
 *
 * - **Role and text** (review of PR #24, finding 1): the explicit role first, the implicit one after; the
 *   visible text is read for every clickable — button, link, menuitem, tab, option, switch, checkbox, radio,
 *   treeitem, and anything with an onclick handler or a tabindex — so `<div role=button>Send</div>` is "Send",
 *   not "".
 * - **Credentials** (finding 3): a field that is `type=password` (one that ever was is kept as one by
 *   cdp-read.cjs, across a show-password toggle), one drawn masked (`-webkit-text-security`), one whose name or id says
 *   pass/pwd/pin/otp, and a one-character numeric box (a split one-time code) are all secrets. A form's fields
 *   are its `elements`, so a field joined with `form=` counts.
 * - **Target** (finding 2, 4): the form's action and method, a link's href, the row or item the element is in
 *   (across shadow roots), and the document it is in — path, query and fragment, and the frame's own origin
 *   when it is not the top page.
 */
function describeElement(node, behavior) {
  // Review of PR #24, round 4: describe the element the action really lands on, as Playwright picks it
  // (injectedScript `retarget`): `fill`, `selectOption` and a check follow a label to its control; a click
  // lands on the closest button or link, and a label passes the click to its control.
  const element = (() => {
    let target = node;
    try {
      const editable = (el) => el.matches("input, textarea, select") || el.isContentEditable === true;
      const followLabel = (el) => {
        if (el.matches("a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]") || el.isContentEditable === true) return el;
        const label = el.closest("label");
        return label !== null && label.control ? label.control : el;
      };
      if (behavior === "fill") {
        if (!editable(target)) target = target.closest("button, [role=button], [role=checkbox], [role=radio]") || target;
        target = followLabel(target);
      } else if (behavior === "click") {
        if (!editable(target)) target = target.closest("button, [role=button], a, [role=link]") || target;
        target = followLabel(target);
      }
    } catch {
      // Described as given.
    }
    return target;
  })();
  const doc = element.ownerDocument || document;
  const view = doc.defaultView || window;
  const tag = String(element.tagName || "").toLowerCase();
  const type = String(element.getAttribute("type") || "").toLowerCase();
  const autocomplete = String(element.getAttribute("autocomplete") || "").toLowerCase();
  const explicitRole = String(element.getAttribute("role") || "").toLowerCase();
  const implicit =
    tag === "button" || (tag === "input" && ["submit", "button", "reset", "image"].includes(type))
      ? "button"
      : tag === "a"
        ? "link"
        : tag === "select"
          ? "combobox"
          : tag === "textarea" || (tag === "input" && !["checkbox", "radio", "file", "hidden"].includes(type))
            ? type === "search" ? "searchbox" : "textbox"
            : tag === "input" ? type : "";
  const role = explicitRole || implicit;
  const CLICKABLE = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "switch", "checkbox", "radio", "treeitem", "gridcell"];
  const clickable = CLICKABLE.includes(role) || element.hasAttribute("onclick") || (element.hasAttribute("tabindex") && !["textbox", "searchbox", "combobox"].includes(role));
  const labelledBy = String(element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const node = doc.getElementById(id);
      return node === null ? "" : String(node.textContent || "");
    })
    .join(" ")
    .trim();
  const own = (value) => (value === null || value === undefined ? "" : String(value).trim());
  const labelText = element.labels && element.labels.length > 0 ? Array.from(element.labels).map((label) => own(label.innerText || label.textContent)).join(" ") : "";
  const visible = own(element.innerText !== undefined ? element.innerText : element.textContent);
  const labelled =
    own(element.getAttribute("aria-label")) ||
    labelledBy ||
    labelText ||
    own(element.getAttribute("placeholder")) ||
    own(element.getAttribute("title")) ||
    (clickable ? visible || own(element.getAttribute("value")) || own(element.getAttribute("alt")) : own(element.getAttribute("name")));

  // The form: the one the element belongs to (`form=` included), or the landmark it sits in.
  const form = element.closest("form, [role=search], [role=form]");
  // A form-associated control knows its form (`form=` included); any other element joined with `form=` — a
  // div acting as a button — is joined here (review of PR #24, round 2).
  const linked = element.form ? null : element.getAttribute("form") ? doc.getElementById(String(element.getAttribute("form"))) : null;
  const owner =
    element.form ||
    (linked !== null && String(linked.tagName).toLowerCase() === "form" ? linked : null) ||
    (form !== null && String(form.tagName).toLowerCase() === "form" ? form : null);
  // HTML semantics (TASK-01): a button is a submit button unless its type says button, reset or menu — a missing
  // type and a value the spec does not know (`type=x`) both fall to submit, so neither one hides a form's post.
  const submitsForm =
    owner !== null && ((tag === "button" && !["button", "reset", "menu"].includes(type)) || (tag === "input" && (type === "submit" || type === "image")));

  const masked = (field) => {
    try {
      const style = view.getComputedStyle(field);
      const security = style.getPropertyValue("-webkit-text-security") || style.webkitTextSecurity || "";
      return security !== "" && security !== "none";
    } catch {
      return false;
    }
  };
  const tokens = (field) =>
    `${field.getAttribute("name") || ""} ${field.getAttribute("id") || ""}`
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  // D-160, as tightened after the second review: a secret for sure ("never released") only on a strong signal —
  // ever type=password, masked, autocomplete current-/new-password or one-time-code, or a name/id that says
  // password. A field that only *may* take a code (pin/otp/code in its name with a numeric shape, a one-box
  // numeric field) asks instead (`maybeCode`), and the obvious lookalikes are left alone.
  const PASSWORD_TOKENS = ["pass", "password", "passwd", "pwd", "passcode", "passphrase", "passwort", "kennwort", "wachtwoord", "haslo", "senha", "contrasena", "motdepasse"];
  const NOT_SECRET = ["zip", "zipcode", "postal", "post", "postcode", "promo", "promocode", "coupon", "voucher", "discount", "quantity", "qty", "amount", "count", "country", "area", "shipping"];
  const secretKind = (field) => {
    const ftype = String(field.getAttribute("type") || "").toLowerCase();
    const auto = String(field.getAttribute("autocomplete") || "").toLowerCase();
    if (ftype === "password" || masked(field) || /(^|\s)(current|new)-password(\s|$)/.test(auto)) return "password";
    if (/(^|\s)one-time-code(\s|$)/.test(auto)) return "otp";
    if (tokens(field).some((t) => PASSWORD_TOKENS.includes(t))) return "password";
    return undefined;
  };
  const maybeCode = (field) => {
    if (secretKind(field) !== undefined) return false;
    const named = tokens(field);
    if (named.some((t) => NOT_SECRET.includes(t))) return false;
    const ftype = String(field.getAttribute("type") || "").toLowerCase();
    const numeric = String(field.getAttribute("inputmode") || "").toLowerCase() === "numeric" || ftype === "number" || ftype === "tel";
    const maxLength = Number(field.getAttribute("maxlength") || "0");
    if (named.some((t) => ["pin", "otp", "totp", "mfa", "2fa", "tan"].includes(t))) return true;
    if (named.includes("code") && numeric && maxLength > 0 && maxLength <= 8) return true;
    return numeric && maxLength === 1;
  };
  const fields = owner === null ? [] : Array.from(owner.elements || owner.querySelectorAll?.("input") || []);

  // Where it goes, as a path within the document's origin, query and fragment included.
  const here = doc.location || view.location;
  const where = (raw) => {
    try {
      const url = new URL(String(raw), here.href);
      return url.origin === here.origin ? url.pathname + url.search + url.hash : url.origin + url.pathname + url.search + url.hash;
    } catch {
      return "";
    }
  };
  // The row or item, across shadow roots: up through each root's host.
  let row = null;
  for (let node = element; node !== null && row === null; ) {
    row = node.closest("tr, li, article, [role=row], [role=listitem]");
    if (row !== null) break;
    const root = node.getRootNode ? node.getRootNode() : null;
    node = root !== null && root !== undefined && root.host ? root.host : null;
  }
  const link = element.closest("a[href]");
  const inFrame = (() => {
    try {
      return view !== view.top;
    } catch {
      return true;
    }
  })();
  return {
    tag,
    type,
    autocomplete,
    role,
    text: String(labelled).replace(/\s+/g, " ").trim().slice(0, 300),
    formRole: form === null ? undefined : form.getAttribute("role") || (String(form.tagName).toLowerCase() === "form" ? "form" : undefined),
    submitsForm,
    formHasPassword: fields.some((field) => secretKind(field) === "password"),
    // Review of PR #24, round 3: a password field in the form already holds something — by a drag, a paste or
    // the page. Only whether it is empty is read, never the value or its length.
    passwordFilled: fields.some((field) => secretKind(field) === "password" && String(field.value || "") !== ""),
    // Text can be dropped or typed into it: a text field, or anything editable.
    editable: role === "textbox" || role === "searchbox" || element.isContentEditable === true,
    // Keys typed here stay here (review of PR #24, last round): an input of a text-like type, a textarea, or an
    // editable element. Printable keys sent anywhere else — a focusable div whose closed root could hold a
    // password field — wait for a yes.
    textEntry: (tag === "input" && ["", "text", "email", "number", "password", "search", "tel", "url"].includes(type)) || tag === "textarea" || element.isContentEditable === true,
    secret: secretKind(element),
    maybeCode: maybeCode(element),
    clickable: clickable || submitsForm,
    formAction: owner === null ? undefined : where(submitsForm && element.hasAttribute("formaction") ? element.formAction : owner.action),
    formMethod: owner === null ? undefined : String((submitsForm && element.hasAttribute("formmethod") ? element.formMethod : owner.method) || "get").toLowerCase(),
    href: link === null ? undefined : where(link.href),
    context: row === null ? undefined : String(row.innerText || row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
    frameOrigin: inFrame ? here.origin : undefined,
    framePath: inFrame ? here.pathname + here.search + here.hash : undefined,
  };
}

module.exports = { describeElement };
