// GENERATED from src/decide/sensitive.ts (D-153's fixed sensitive-actions list) — do not edit.
// Regenerate: bun build src/decide/sensitive.ts --format=cjs --target=node --outfile docker/browser/sensitive.cjs
// then put these three lines back on top. test/browser/sensitive-bundle.test.ts fails while this file and the
// source disagree, so the container's list is always the engine's list.
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/decide/sensitive.ts
var exports_sensitive = {};
__export(exports_sensitive, {
  COMMIT_RULES: () => COMMIT_RULES,
  KNOWN_KINDS: () => KNOWN_KINDS,
  SENSITIVE_CATEGORIES: () => SENSITIVE_CATEGORIES,
  SENSITIVE_MEANING: () => SENSITIVE_MEANING,
  SENSITIVE_RULES: () => SENSITIVE_RULES,
  classifyAction: () => classifyAction,
  normaliseText: () => normaliseText
});
module.exports = __toCommonJS(exports_sensitive);
var SENSITIVE_CATEGORIES = Object.freeze([
  "payment",
  "send",
  "delete",
  "credentials",
  "terms"
]);
var SENSITIVE_MEANING = Object.freeze({
  payment: Object.freeze({ en: "paying or buying something", th: "จ่ายเงิน" }),
  send: Object.freeze({ en: "sending a message or an e-mail, or posting", th: "ส่งข้อความ/อีเมล" }),
  delete: Object.freeze({ en: "deleting something", th: "ลบ" }),
  credentials: Object.freeze({ en: "entering a password or another credential", th: "ใส่รหัสผ่าน/credential" }),
  terms: Object.freeze({ en: "accepting terms or giving consent", th: "ยอมรับข้อตกลง" })
});
var KNOWN_KINDS = Object.freeze([
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
  "upload"
]);
var LOOKING = new Set(["navigate", "back", "scroll", "hover", "read", "screenshot", "wait"]);
var words = (...list) => `(?:^|[^a-z0-9])(?:${list.join("|")})(?:$|[^a-z0-9])`;
var thai = (...list) => `(?:${list.join("|")})`;
var cjk = (...list) => `(?:${list.join("|")})`;
var matches = (source, text) => new RegExp(source, "u").test(text);
var freezeRule = (rule) => Object.freeze({
  ...rule,
  ...rule.text === undefined ? {} : { text: Object.freeze([...rule.text]) },
  ...rule.values === undefined ? {} : { values: Object.freeze([...rule.values]) },
  ...rule.roles === undefined ? {} : { roles: Object.freeze([...rule.roles]) }
});
var SENSITIVE_RULES = Object.freeze([
  {
    id: "payment.words",
    category: "payment",
    what: "a control that pays, buys, orders, subscribes, donates or transfers money",
    text: [
      words("pay", "pay now", "payment", "buy", "buy now", "purchase", "checkout", "check out", "place order", "order now", "complete order", "confirm order", "subscribe", "upgrade", "donate", "tip", "transfer", "send money", "top up", "add card", "add payment method", "pay with"),
      thai("ชำระ", "จ่าย", "ซื้อ", "สั่งซื้อ", "สั่งของ", "โอนเงิน", "เติมเงิน", "บริจาค", "สมัครสมาชิก", "เช็คเอาท์", "ยืนยันคำสั่งซื้อ")
    ]
  },
  {
    id: "payment.card-value",
    category: "payment",
    what: "typing a card number",
    values: ["card"]
  },
  {
    id: "send.words",
    category: "send",
    what: "a control that sends, posts, publishes, replies, shares or invites",
    text: [
      words("send", "send message", "send email", "send e-mail", "post", "publish", "reply", "reply all", "forward", "share", "tweet", "comment", "invite", "submit message"),
      thai("ส่ง", "โพสต์", "เผยแพร่", "ตอบกลับ", "แชร์", "ส่งต่อ", "ส่งข้อความ", "ส่งอีเมล", "เชิญ")
    ]
  },
  {
    id: "delete.words",
    category: "delete",
    what: "a control that deletes, removes, erases, empties, discards or closes an account",
    text: [
      words("delete", "delete account", "remove", "erase", "destroy", "discard", "trash", "move to trash", "empty trash", "purge", "wipe", "uninstall", "close account", "deactivate", "unsubscribe", "cancel subscription", "revoke"),
      thai("ลบ", "ล้าง", "ทิ้ง", "ถังขยะ", "ปิดบัญชี", "ยกเลิกการสมัคร", "ยกเลิกบัญชี", "เพิกถอน")
    ]
  },
  {
    id: "credentials.value",
    category: "credentials",
    what: "typing a password, a one-time code, or another secret",
    values: ["password", "otp", "secret"]
  },
  {
    id: "credentials.field",
    category: "credentials",
    what: "typing into a field labelled as a password, PIN, code, key or token",
    text: [
      words("password", "passphrase", "passcode", "pin", "otp", "one-time code", "verification code", "security code", "2fa", "mfa", "api key", "secret", "token", "private key", "cvv", "cvc"),
      thai("รหัสผ่าน", "รหัส", "พิน", "รหัสยืนยัน", "โทเคน"),
      words("passwort", "kennwort", "geheimzahl", "mot de passe", "code secret", "contraseña", "contrasena", "clave", "código de verificación"),
      words("wachtwoord", "hasło", "haslo", "senha", "palavra-passe"),
      cjk("パスワード", "暗証番号", "認証コード", "密码", "密碼", "验证码", "驗證碼", "비밀번호", "암호", "인증번호", "인증 코드")
    ],
    roles: ["textbox", "searchbox", "spinbutton", "combobox", "field", "input"]
  },
  {
    id: "credentials.grant",
    category: "credentials",
    what: "signing in, or granting an app access to an account",
    text: [
      words("sign in", "log in", "login", "authorize", "authorise", "allow access", "grant access", "connect account", "continue with google", "continue with apple", "sign in with"),
      thai("เข้าสู่ระบบ", "ล็อกอิน", "อนุญาตการเข้าถึง", "ให้สิทธิ์"),
      words("anmelden", "einloggen", "se connecter", "connexion", "iniciar sesión", "iniciar sesion", "acceder"),
      cjk("ログイン", "サインイン", "登录", "登錄", "로그인")
    ]
  },
  {
    id: "credentials.allow",
    category: "credentials",
    what: "an OAuth or permission prompt's allow, authorize or grant",
    text: [
      words("allow", "allow all", "always allow", "authorize", "authorise", "authorize app", "grant", "grant permission", "give access"),
      thai("อนุญาต", "ให้สิทธิ์", "อนุมัติการเข้าถึง")
    ]
  },
  {
    id: "credentials.login-submit",
    category: "credentials",
    what: "submitting a form that holds a password field, whatever its button says"
  },
  {
    id: "terms.words",
    category: "terms",
    what: "a control that accepts, agrees or consents — terms, a licence, cookies",
    text: [words("accept", "accept all", "i accept", "agree", "i agree", "consent", "i consent"), thai("ยอมรับ", "ยินยอม", "ข้อตกลง")]
  },
  {
    id: "terms.checkbox",
    category: "terms",
    what: "ticking or pressing something that names terms, conditions, a policy or a licence",
    text: [
      words("terms", "terms of service", "terms of use", "terms and conditions", "conditions", "privacy policy", "eula", "license agreement", "licence agreement"),
      thai("ข้อกำหนด", "เงื่อนไข", "นโยบายความเป็นส่วนตัว")
    ],
    roles: ["checkbox", "switch", "radio", "button", "menuitemcheckbox"]
  }
].map(freezeRule));
var COMMIT_RULES = Object.freeze([
  { id: "commit.submit", what: "submitting a form: a submit step, or a click, a key press (other than Tab or Escape) or a check on a form's submit control" },
  { id: "commit.enter", what: "pressing Enter (or a chord with Enter), or typing that ends by submitting" },
  { id: "commit.confirm", what: "a control that submits, confirms, proceeds, or answers OK" },
  { id: "commit.form-post", what: "a click on anything inside a form whose method is not GET (it posts, or closes a dialog)" }
].map((rule) => Object.freeze(rule)));
var CONFIRM_TEXT = Object.freeze([
  words("submit", "confirm", "proceed", "ok", "okay", "yes", "done", "finish", "save and send"),
  thai("ยืนยัน", "ตกลง", "ดำเนินการต่อ", "เสร็จสิ้น", "บันทึกและส่ง")
]);
function postsForm(action) {
  const raw = action.formMethod;
  if (raw === undefined)
    return false;
  const method = typeof raw === "string" ? normaliseText(raw) : "?";
  return method !== "" && method !== "get";
}
function harmlessCommit(action, role) {
  if (postsForm(action))
    return false;
  const formRole = typeof action.formRole === "string" ? action.formRole.toLowerCase() : "";
  return role === "searchbox" || formRole === "search" || action.valueClass === "search";
}
function movesOrCancels(action) {
  if (typeof action.key !== "string")
    return false;
  return /^(?:(?:control|controlormeta|shift|alt|meta)\+)*(?:tab|escape|esc)$/u.test(normaliseText(action.key));
}
function commits(kind, action, text) {
  const found = [];
  if (kind === "submit")
    found.push("commit.submit");
  if ((kind === "click" || kind === "check" || kind === "press" && !movesOrCancels(action)) && action.submitsForm === true) {
    found.push("commit.submit");
  } else if (kind === "click" && postsForm(action)) {
    found.push("commit.form-post");
  }
  const key = normaliseText(typeof action.key === "string" ? action.key : kind === "press" ? text : "");
  const enter = kind === "press" && /(?:^|[^a-z])(?:enter|return|numpadenter)$/u.test(key);
  if (enter || (kind === "type" || kind === "fill") && action.submits === true)
    found.push("commit.enter");
  if (kind !== "type" && kind !== "fill" && text !== "" && CONFIRM_TEXT.some((source) => matches(source, text))) {
    found.push("commit.confirm");
  }
  return found;
}
function loginSubmit(kind, action) {
  if (action.formHasPassword !== true)
    return false;
  if (kind === "submit")
    return true;
  if ((kind === "click" || kind === "press") && action.submitsForm === true)
    return true;
  const key = normaliseText(typeof action.key === "string" ? action.key : "");
  if (kind === "press" && /(?:^|[^a-z])(?:enter|return|numpadenter)$/u.test(key))
    return true;
  return (kind === "type" || kind === "fill") && action.submits === true;
}
function normaliseText(text) {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}
function classifyAction(action) {
  const kind = typeof action.kind === "string" ? action.kind.toLowerCase() : "";
  if (!KNOWN_KINDS.includes(kind)) {
    return Object.freeze({
      sensitive: true,
      categories: Object.freeze([]),
      rules: Object.freeze(["unknown-kind"]),
      reasons: Object.freeze([
        `the step kind ${JSON.stringify(action.kind)} is not one this list knows, so it waits for a yes rather than being guessed harmless`
      ])
    });
  }
  if (LOOKING.has(kind)) {
    return Object.freeze({ sensitive: false, categories: Object.freeze([]), rules: Object.freeze([]), reasons: Object.freeze([]) });
  }
  const text = normaliseText(typeof action.text === "string" ? action.text : "");
  const role = typeof action.role === "string" ? action.role.toLowerCase() : "";
  const value = action.valueClass;
  const matched = [];
  for (const rule of SENSITIVE_RULES) {
    const byValue = value !== undefined && rule.values !== undefined && rule.values.includes(value);
    const onRole = rule.roles === undefined || role === "" || rule.roles.includes(role);
    const byText = text !== "" && rule.text !== undefined && onRole && rule.text.some((source) => matches(source, text));
    if (byValue || byText)
      matched.push(rule);
  }
  if (loginSubmit(kind, action))
    matched.push(SENSITIVE_RULES.find((rule) => rule.id === "credentials.login-submit"));
  const committed = harmlessCommit(action, role) ? [] : commits(kind, action, text);
  const categories = SENSITIVE_CATEGORIES.filter((category) => matched.some((rule) => rule.category === category));
  const where = action.origin === "" ? "" : ` on ${action.origin}`;
  const reasons = categories.map((category) => `${SENSITIVE_MEANING[category].en} · ${SENSITIVE_MEANING[category].th}${where} — it waits for a yes at every level (D-153)`);
  if (committed.length > 0 && categories.length === 0) {
    reasons.push(`it commits whatever the page holds${where} — a form, a message or a dialog — and which of payment, sending, ` + `deleting, credentials or terms it is cannot be told from here, so it waits for a yes (D-153)`);
  }
  return Object.freeze({
    sensitive: matched.length > 0 || committed.length > 0,
    categories: Object.freeze(categories),
    rules: Object.freeze([...matched.map((rule) => rule.id), ...committed]),
    reasons: Object.freeze(reasons)
  });
}
