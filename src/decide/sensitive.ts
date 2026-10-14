/**
 * The sensitive-actions list (D-153): what the browser always stops for, at every level.
 *
 * ## What it is
 *
 * The owner, 2026-10-04: *หยุดรอ "ใช่" ทุกระดับ: จ่ายเงิน · ส่งข้อความ/อีเมล · ลบ · ใส่รหัสผ่าน/credential ·
 * ยอมรับข้อตกลง — รายการคงที่ เพิ่มได้อย่างเดียว.* Five categories, and an action in any of them waits for a
 * person's yes whatever the `operate` level says — 3 included. The dial decides *where* the browser may act;
 * this list decides *what it never does unasked*.
 *
 * ## Fixed, and add-only by construction
 *
 * - **No switch.** {@link classifyAction} takes the action and nothing else: no level, no options, no allow
 *   list. There is no argument a caller could pass to make a payment not a payment, and a test pins the
 *   arity.
 * - **No mutation.** Every table here is frozen. Patterns are held as **source strings**, never as `RegExp`
 *   objects: a frozen `RegExp` is not enough, because `RegExp.prototype.compile` recompiles the pattern in
 *   place before the frozen `lastIndex` write throws — measured in Bun, `Object.freeze(/pay/).compile("(?!)")`
 *   throws and leaves the regex as `(?!)`, so "Pay now" passes (review of PR #18). The classifier compiles a
 *   fresh `RegExp` from each string on every call, and no `RegExp` it uses is ever handed out.
 * - **No removal.** `test/decide/sensitive.test.ts` holds the floor: every category and every rule id that
 *   has ever shipped, each with an example it must still catch. Removing a category, removing a rule, or
 *   weakening a rule until its example passes unflagged fails that test. Adding is free.
 *
 * ## Errs towards stopping, as far as the step shows what it does
 *
 * A false positive costs one yes. A false negative is a payment, a sent message or a deletion nobody agreed
 * to. So the matching is wide on purpose (`remove` pauses even when it is a filter chip), an action of a kind
 * this module does not know pauses too, and a step the browser layer says **submits a form** — a click, a key or
 * a check on a form's submit control — or **clicks inside a form that does not GET** pauses whatever its label
 * says (TASK-01 of the 2026-10-13 review: a word list cannot know "Book now", "Place bid" or the same word in a
 * language it was not given). A key that cannot activate a control (Tab, Escape) is the one exception, because
 * the key is the caller's, not the page's; the rest of the cost — every click in a POST form, a Search button
 * in a GET form that does not call itself a search — stays, because what would excuse it (a role, a text field,
 * a link) is what the page says about itself.
 *
 * What it does not stop for, and says so: a click on a control that is not a form's submit and is not in a
 * POST form — a `<button type="button">` or a link that a script wires to a purchase — passes unless its words
 * match one of the lists below. The classifier sees the element, not the script behind it. A form that names
 * itself a search (`formRole: "search"`) and GETs is harmless by the page's own word; a page can claim that, so
 * a search form that posts is not.
 *
 * ## Not wired yet
 *
 * No browser is attached to a turn yet (E17 S17.7–S17.8). This is the classifier the browser layer will call
 * before each step, with what Playwright MCP says about the element it is about to touch.
 */

/** The five categories D-153 names. Closed: a sixth is a `tsc` error until it is added here. */
export type SensitiveCategory = "payment" | "send" | "delete" | "credentials" | "terms";

/** Every category, in the order D-153 lists them. */
export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = Object.freeze([
  "payment",
  "send",
  "delete",
  "credentials",
  "terms",
] as const);

/** What a category means, in English and in Thai, for whoever is asked the yes. */
export const SENSITIVE_MEANING: Readonly<Record<SensitiveCategory, { readonly en: string; readonly th: string }>> =
  Object.freeze({
    payment: Object.freeze({ en: "paying or buying something", th: "จ่ายเงิน" }),
    send: Object.freeze({ en: "sending a message or an e-mail, or posting", th: "ส่งข้อความ/อีเมล" }),
    delete: Object.freeze({ en: "deleting something", th: "ลบ" }),
    credentials: Object.freeze({ en: "entering a password or another credential", th: "ใส่รหัสผ่าน/credential" }),
    terms: Object.freeze({ en: "accepting terms or giving consent", th: "ยอมรับข้อตกลง" }),
  });

/**
 * What a browser step is about to do. Built by the browser layer from what it knows about the element.
 *
 * - `kind` — the step: `click`, `type`, `submit`, …; see {@link KNOWN_KINDS}. Any other kind pauses.
 * - `origin` — the page's origin, `https://shop.example`. Carried so the question can name it; no origin
 *   makes an action sensitive or not.
 * - `text` — the element's visible text or accessible name, or a field's label.
 * - `role` — its ARIA role (`button`, `link`, `textbox`, `checkbox`, …), when known.
 * - `valueClass` — for `type`/`fill`, what kind of value is being entered, never the value itself.
 * - `key` — for `press`, the key or chord (`Enter`, `Control+Enter`, `Tab`).
 * - `submits` — for `type`/`fill`, true when the typing ends by submitting (Playwright's `submit`, an Enter).
 * - `formRole` — the ARIA role of the form or landmark the element is in (`search`, `form`), when known.
 * - `submitsForm` — the element is a form's submit control (a `<button>` whose type is not `button`, `reset` or
 *   `menu` — a missing or unknown type submits, as in HTML — or an `<input type=submit|image>`), when known.
 * - `formHasPassword` — the form the element is in holds a password field, when known.
 * - `formMethod` — the method of the form the element is in (`get`, `post`, `dialog`), lower case as the DOM gives
 *   it; the control's own `formmethod` wins when it is a submit. Absent: not in a form, or not said.
 */
export interface ActionDescriptor {
  readonly kind: string;
  readonly origin: string;
  readonly text?: string;
  readonly role?: string;
  readonly valueClass?: ValueClass;
  readonly key?: string;
  readonly submits?: boolean;
  readonly formRole?: string;
  readonly submitsForm?: boolean;
  readonly formHasPassword?: boolean;
  readonly formMethod?: string;
}

/** What kind of value is being typed. The value never comes here. */
export type ValueClass = "none" | "text" | "number" | "email" | "phone" | "url" | "date" | "search" | "password" | "otp" | "secret" | "card" | "file";

/** The step kinds this module knows. A kind outside this list pauses, with that as the reason. */
export const KNOWN_KINDS: readonly string[] = Object.freeze([
  "navigate",
  "back",
  "scroll",
  "hover",
  "read",
  "screenshot",
  "wait",
  "click",
  "press",
  "submit",
  "select",
  "check",
  "type",
  "fill",
  "upload",
]);

/** Kinds that only look or move around: no rule applies to them. Every other known kind is classified. */
const LOOKING: ReadonlySet<string> = new Set(["navigate", "back", "scroll", "hover", "read", "screenshot", "wait"]);

/** One rule of the list. Ids are stable: the floor test refers to them by id, forever. */
export interface SensitiveRule {
  readonly id: string;
  readonly category: SensitiveCategory;
  /** What it catches, for a person reading the list. */
  readonly what: string;
  /** Element text patterns, as `RegExp` source strings (flag `u`), matched on the normalised text. Optional. */
  readonly text?: readonly string[];
  /** Value classes that are sensitive whatever the text says. Optional. */
  readonly values?: readonly ValueClass[];
  /** Roles a text match must be on, when given. Absent means any role. */
  readonly roles?: readonly string[];
}

/** English words on word boundaries, so `display` is not `pay` and `remover` is still caught by `remove`. */
const words = (...list: readonly string[]): string => `(?:^|[^a-z0-9])(?:${list.join("|")})(?:$|[^a-z0-9])`;
/** Thai has no spaces between words, so a Thai pattern is a plain substring. */
const thai = (...list: readonly string[]): string => `(?:${list.join("|")})`;
/** Japanese, Chinese and Korean, likewise matched as substrings (review of PR #24: credentials in other languages). */
const cjk = (...list: readonly string[]): string => `(?:${list.join("|")})`;
/** A fresh `RegExp` per use, so nothing a caller can reach is ever the pattern being matched. */
const matches = (source: string, text: string): boolean => new RegExp(source, "u").test(text);

const freezeRule = (rule: SensitiveRule): SensitiveRule =>
  Object.freeze({
    ...rule,
    ...(rule.text === undefined ? {} : { text: Object.freeze([...rule.text]) }),
    ...(rule.values === undefined ? {} : { values: Object.freeze([...rule.values]) }),
    ...(rule.roles === undefined ? {} : { roles: Object.freeze([...rule.roles]) }),
  });

/**
 * The list. **Add only.** Each rule's id is pinned by `test/decide/sensitive.test.ts`; a removed or renamed
 * rule fails it. To make a rule wider, add patterns; to cover something new, add a rule with a new id.
 */
export const SENSITIVE_RULES: readonly SensitiveRule[] = Object.freeze(
  ([
    {
      id: "payment.words",
      category: "payment",
      what: "a control that pays, buys, orders, subscribes, donates or transfers money",
      text: [
        words(
          "pay",
          "pay now",
          "payment",
          "buy",
          "buy now",
          "purchase",
          "checkout",
          "check out",
          "place order",
          "order now",
          "complete order",
          "confirm order",
          "subscribe",
          "upgrade",
          "donate",
          "tip",
          "transfer",
          "send money",
          "top up",
          "add card",
          "add payment method",
          "pay with",
        ),
        thai("ชำระ", "จ่าย", "ซื้อ", "สั่งซื้อ", "สั่งของ", "โอนเงิน", "เติมเงิน", "บริจาค", "สมัครสมาชิก", "เช็คเอาท์", "ยืนยันคำสั่งซื้อ"),
      ],
    },
    {
      id: "payment.card-value",
      category: "payment",
      what: "typing a card number",
      values: ["card"],
    },
    {
      id: "send.words",
      category: "send",
      what: "a control that sends, posts, publishes, replies, shares or invites",
      text: [
        words(
          "send",
          "send message",
          "send email",
          "send e-mail",
          "post",
          "publish",
          "reply",
          "reply all",
          "forward",
          "share",
          "tweet",
          "comment",
          "invite",
          "submit message",
        ),
        thai("ส่ง", "โพสต์", "เผยแพร่", "ตอบกลับ", "แชร์", "ส่งต่อ", "ส่งข้อความ", "ส่งอีเมล", "เชิญ"),
      ],
    },
    {
      id: "delete.words",
      category: "delete",
      what: "a control that deletes, removes, erases, empties, discards or closes an account",
      text: [
        words(
          "delete",
          "delete account",
          "remove",
          "erase",
          "destroy",
          "discard",
          "trash",
          "move to trash",
          "empty trash",
          "purge",
          "wipe",
          "uninstall",
          "close account",
          "deactivate",
          "unsubscribe",
          "cancel subscription",
          "revoke",
        ),
        thai("ลบ", "ล้าง", "ทิ้ง", "ถังขยะ", "ปิดบัญชี", "ยกเลิกการสมัคร", "ยกเลิกบัญชี", "เพิกถอน"),
      ],
    },
    {
      id: "credentials.value",
      category: "credentials",
      what: "typing a password, a one-time code, or another secret",
      values: ["password", "otp", "secret"],
    },
    {
      id: "credentials.field",
      category: "credentials",
      what: "typing into a field labelled as a password, PIN, code, key or token",
      text: [
        words(
          "password",
          "passphrase",
          "passcode",
          "pin",
          "otp",
          "one-time code",
          "verification code",
          "security code",
          "2fa",
          "mfa",
          "api key",
          "secret",
          "token",
          "private key",
          "cvv",
          "cvc",
        ),
        thai("รหัสผ่าน", "รหัส", "พิน", "รหัสยืนยัน", "โทเคน"),
        // Review of PR #24 (D-160 misses): German, French, Spanish, Japanese, Chinese, Korean.
        words("passwort", "kennwort", "geheimzahl", "mot de passe", "code secret", "contraseña", "contrasena", "clave", "código de verificación"),
        // Dutch, Polish, Portuguese (second review of PR #24).
        words("wachtwoord", "hasło", "haslo", "senha", "palavra-passe"),
        cjk("パスワード", "暗証番号", "認証コード", "密码", "密碼", "验证码", "驗證碼", "비밀번호", "암호", "인증번호", "인증 코드"),
      ],
      roles: ["textbox", "searchbox", "spinbutton", "combobox", "field", "input"],
    },
    {
      id: "credentials.grant",
      category: "credentials",
      what: "signing in, or granting an app access to an account",
      text: [
        words("sign in", "log in", "login", "authorize", "authorise", "allow access", "grant access", "connect account", "continue with google", "continue with apple", "sign in with"),
        thai("เข้าสู่ระบบ", "ล็อกอิน", "อนุญาตการเข้าถึง", "ให้สิทธิ์"),
        words("anmelden", "einloggen", "se connecter", "connexion", "iniciar sesión", "iniciar sesion", "acceder"),
        cjk("ログイン", "サインイン", "登录", "登錄", "로그인"),
      ],
    },
    {
      id: "credentials.allow",
      category: "credentials",
      what: "an OAuth or permission prompt's allow, authorize or grant",
      text: [
        words("allow", "allow all", "always allow", "authorize", "authorise", "authorize app", "grant", "grant permission", "give access"),
        thai("อนุญาต", "ให้สิทธิ์", "อนุมัติการเข้าถึง"),
      ],
    },
    {
      // No text and no values: matched by context in classifyAction — a neutral "Go" in a login form is a login
      // (re-review of PR #19).
      id: "credentials.login-submit",
      category: "credentials",
      what: "submitting a form that holds a password field, whatever its button says",
    },
    {
      id: "terms.words",
      category: "terms",
      what: "a control that accepts, agrees or consents — terms, a licence, cookies",
      text: [words("accept", "accept all", "i accept", "agree", "i agree", "consent", "i consent"), thai("ยอมรับ", "ยินยอม", "ข้อตกลง")],
    },
    {
      id: "terms.checkbox",
      category: "terms",
      what: "ticking or pressing something that names terms, conditions, a policy or a licence",
      text: [
        words("terms", "terms of service", "terms of use", "terms and conditions", "conditions", "privacy policy", "eula", "license agreement", "licence agreement"),
        thai("ข้อกำหนด", "เงื่อนไข", "นโยบายความเป็นส่วนตัว"),
      ],
      roles: ["checkbox", "switch", "radio", "button", "menuitemcheckbox"],
    },
  ] satisfies SensitiveRule[]).map(freezeRule),
);

/**
 * Steps that **commit** whatever the page holds — a form, a message, a dialog — without saying which of the
 * five categories it is (review of PR #18). A generic submit, an Enter that sends, a "Confirm" or "OK": the
 * text on the button cannot tell a payment from a search, so they wait for a yes too, unless the context
 * marks them harmless — a search box, or a form whose role is `search` — and that form GETs (a form that posts
 * is not a search, whatever role the page gives it).
 *
 * TASK-01: a click, a key press (not Tab or Escape) or a check on a form's **submit control** is `commit.submit`
 * whatever its label says, and any other **click inside a form whose method is not GET** is `commit.form-post`.
 *
 * Same rules as {@link SENSITIVE_RULES}: add only, ids pinned by the floor test.
 */
export interface CommitRule {
  readonly id: string;
  readonly what: string;
}

export const COMMIT_RULES: readonly CommitRule[] = Object.freeze(
  [
    { id: "commit.submit", what: "submitting a form: a submit step, or a click, a key press (other than Tab or Escape) or a check on a form's submit control" },
    { id: "commit.enter", what: "pressing Enter (or a chord with Enter), or typing that ends by submitting" },
    { id: "commit.confirm", what: "a control that submits, confirms, proceeds, or answers OK" },
    { id: "commit.form-post", what: "a click on anything inside a form whose method is not GET (it posts, or closes a dialog)" },
  ].map((rule) => Object.freeze(rule)),
);

/** The text patterns of `commit.confirm`, as sources. */
const CONFIRM_TEXT: readonly string[] = Object.freeze([
  words("submit", "confirm", "proceed", "ok", "okay", "yes", "done", "finish", "save and send"),
  thai("ยืนยัน", "ตกลง", "ดำเนินการต่อ", "เสร็จสิ้น", "บันทึกและส่ง"),
]);

/**
 * Is the form the element is in one that posts (any method but GET)? A method that is not said — no form, or a
 * caller that does not know — is not this, and neither is an empty one (the container never sends it; the DOM's
 * own default is GET). Anything else that is not exactly `get` once normalised is: `post`, `dialog`, and a value
 * that is not even a string, because the list errs towards stopping.
 */
function postsForm(action: ActionDescriptor): boolean {
  const raw: unknown = action.formMethod;
  if (raw === undefined) return false;
  const method = typeof raw === "string" ? normaliseText(raw) : "?";
  return method !== "" && method !== "get";
}

/**
 * Search is the one context known to make a commit harmless: it asks, and changes nothing. That holds for a form
 * that GETs. The role is the page's own claim, so a form that posts is never harmless, whatever role it gives
 * itself.
 */
function harmlessCommit(action: ActionDescriptor, role: string): boolean {
  if (postsForm(action)) return false;
  const formRole = typeof action.formRole === "string" ? action.formRole.toLowerCase() : "";
  return role === "searchbox" || formRole === "search" || action.valueClass === "search";
}

/**
 * Is this key press one that cannot activate the focused control — Tab (focus moves on) or Escape (a cancel),
 * alone or with modifier keys? Only the key the caller **says** counts: with no `key`, a press is read by the
 * element's own text, and a button called "Escape" is still a button. Anything else — Enter, Space, a letter,
 * a chord with a key that is not a modifier ("Enter+Tab" presses Enter), a key that is not a string — may press
 * it, so it is not this.
 */
function movesOrCancels(action: ActionDescriptor): boolean {
  if (typeof action.key !== "string") return false;
  return /^(?:(?:control|controlormeta|shift|alt|meta)\+)*(?:tab|escape|esc)$/u.test(normaliseText(action.key));
}

/** Which commit rules a step matches, before context is asked. */
function commits(kind: string, action: ActionDescriptor, text: string): readonly string[] {
  const found: string[] = [];
  if (kind === "submit") found.push("commit.submit");
  // TASK-01: what the step does, not what the label says. A form's submit control commits whatever it is called;
  // any other click in a form that posts may be wired to the same thing. A key press that cannot activate a
  // control (Tab, Escape) is not a submit; every other key on it, and a key not said, is.
  if ((kind === "click" || kind === "check" || (kind === "press" && !movesOrCancels(action))) && action.submitsForm === true) {
    found.push("commit.submit");
  } else if (kind === "click" && postsForm(action)) {
    found.push("commit.form-post");
  }
  const key = normaliseText(typeof action.key === "string" ? action.key : kind === "press" ? text : "");
  const enter = kind === "press" && /(?:^|[^a-z])(?:enter|return|numpadenter)$/u.test(key);
  if (enter || ((kind === "type" || kind === "fill") && action.submits === true)) found.push("commit.enter");
  if (kind !== "type" && kind !== "fill" && text !== "" && CONFIRM_TEXT.some((source) => matches(source, text))) {
    found.push("commit.confirm");
  }
  return found;
}

/** A step that submits a form holding a password field: a login, whatever the button says. */
function loginSubmit(kind: string, action: ActionDescriptor): boolean {
  if (action.formHasPassword !== true) return false;
  if (kind === "submit") return true;
  if ((kind === "click" || kind === "press") && action.submitsForm === true) return true;
  const key = normaliseText(typeof action.key === "string" ? action.key : "");
  if (kind === "press" && /(?:^|[^a-z])(?:enter|return|numpadenter)$/u.test(key)) return true;
  return (kind === "type" || kind === "fill") && action.submits === true;
}

/** What {@link classifyAction} decided, and every reason. */
export interface Classification {
  /** True: stop and ask a person, at every level. */
  readonly sensitive: boolean;
  /** Each category that matched, in list order, once. */
  readonly categories: readonly SensitiveCategory[];
  /** The rule ids that matched — what a recording keeps. */
  readonly rules: readonly string[];
  /** Sentences for the person asked the yes. */
  readonly reasons: readonly string[];
}

/** NFC, lower-case, whitespace collapsed — the shape every pattern is written against. */
export function normaliseText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Is this browser step one that waits for a yes? Pure, total, and with nothing to switch it off.
 *
 * - a kind outside {@link KNOWN_KINDS} — yes, because it cannot be told apart from one that is;
 * - a looking kind (navigate, scroll, read, …) — no;
 * - otherwise, yes when any rule matches the value class, or the text (on the rule's roles, when it names
 *   any).
 */
export function classifyAction(action: ActionDescriptor): Classification {
  const kind = typeof action.kind === "string" ? action.kind.toLowerCase() : "";
  if (!KNOWN_KINDS.includes(kind)) {
    return Object.freeze({
      sensitive: true,
      categories: Object.freeze([]),
      rules: Object.freeze(["unknown-kind"]),
      reasons: Object.freeze([
        `the step kind ${JSON.stringify(action.kind)} is not one this list knows, so it waits for a yes rather than being guessed harmless`,
      ]),
    });
  }
  if (LOOKING.has(kind)) {
    return Object.freeze({ sensitive: false, categories: Object.freeze([]), rules: Object.freeze([]), reasons: Object.freeze([]) });
  }

  const text = normaliseText(typeof action.text === "string" ? action.text : "");
  const role = typeof action.role === "string" ? action.role.toLowerCase() : "";
  const value = action.valueClass;
  const matched: SensitiveRule[] = [];
  for (const rule of SENSITIVE_RULES) {
    const byValue = value !== undefined && rule.values !== undefined && rule.values.includes(value);
    // An unknown role is taken as on the rule's roles: this list errs towards stopping.
    const onRole = rule.roles === undefined || role === "" || rule.roles.includes(role);
    const byText = text !== "" && rule.text !== undefined && onRole && rule.text.some((source) => matches(source, text));
    if (byValue || byText) matched.push(rule);
  }
  if (loginSubmit(kind, action)) matched.push(SENSITIVE_RULES.find((rule) => rule.id === "credentials.login-submit")!);
  const committed = harmlessCommit(action, role) ? [] : commits(kind, action, text);

  const categories = SENSITIVE_CATEGORIES.filter((category) => matched.some((rule) => rule.category === category));
  const where = action.origin === "" ? "" : ` on ${action.origin}`;
  const reasons = categories.map(
    (category) =>
      `${SENSITIVE_MEANING[category].en} · ${SENSITIVE_MEANING[category].th}${where} — it waits for a yes at every level (D-153)`,
  );
  if (committed.length > 0 && categories.length === 0) {
    reasons.push(
      `it commits whatever the page holds${where} — a form, a message or a dialog — and which of payment, sending, ` +
        `deleting, credentials or terms it is cannot be told from here, so it waits for a yes (D-153)`,
    );
  }
  return Object.freeze({
    sensitive: matched.length > 0 || committed.length > 0,
    categories: Object.freeze(categories),
    rules: Object.freeze([...matched.map((rule) => rule.id), ...committed]),
    reasons: Object.freeze(reasons),
  });
}
