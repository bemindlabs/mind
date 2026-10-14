/**
 * A very small DOM — enough for `docker/browser/describe.cjs` to read an element the way it does in a page:
 * attributes, a parent chain, shadow roots, labels, a form's `elements`, computed style, the document's
 * location and its window (top or a frame). Selectors: tag names, `[attr]` and `[attr=value]`, comma lists.
 * Not a browser; the real page is read in test/e2e/tasks.e2e.ts.
 */

export interface FakeDoc {
  readonly location: { href: string; origin: string; pathname: string; search: string; hash: string };
  readonly defaultView: { top: unknown; getComputedStyle: (el: FakeEl) => { getPropertyValue: (name: string) => string } };
  getElementById(id: string): FakeEl | null;
  readonly all: FakeEl[];
  /** What has focus; `body` when nothing does. */
  activeElement: FakeEl | null;
  body: FakeEl | null;
  /** Every element not inside a shadow root (only `*` is understood). */
  querySelectorAll(selector: string): FakeEl[];
}

export class FakeEl {
  parent: FakeEl | null = null;
  shadowHost: FakeEl | null = null;
  children: FakeEl[] = [];
  labels: FakeEl[] = [];
  form: FakeEl | null = null;
  elements: FakeEl[] = [];
  style: Record<string, string> = {};
  __mindPassword?: boolean;
  /** A label's control (`for=` or the field inside it), as the DOM gives it. */
  control: FakeEl | null = null;
  isContentEditable = false;
  /** An element node (1), as the DOM numbers them. */
  readonly nodeType = 1;
  value = "";
  shadowRoot: { querySelectorAll: (selector: string) => FakeEl[]; activeElement?: FakeEl | null } | null = null;
  constructor(
    public tagName: string,
    public attrs: Record<string, string> = {},
    public innerText = "",
    public ownerDocument: FakeDoc | null = null,
  ) {}
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  get textContent(): string {
    return this.innerText;
  }
  get action(): string {
    return new URL(this.attrs["action"] ?? "", this.ownerDocument!.location.href).href;
  }
  get method(): string {
    return this.attrs["method"] ?? "get";
  }
  get formAction(): string {
    return new URL(this.attrs["formaction"] ?? this.ownerDocument!.location.href, this.ownerDocument!.location.href).href;
  }
  get formMethod(): string {
    return this.attrs["formmethod"] ?? "";
  }
  get href(): string {
    return new URL(this.attrs["href"] ?? "", this.ownerDocument!.location.href).href;
  }
  matches(selector: string): boolean {
    return selector.split(",").map((part) => part.trim()).some((one) => {
      const m = /^([a-z0-9]*)(?:\[([a-z-]+)(?:=([^\]]+))?\])?$/i.exec(one);
      if (m === null) return false;
      const [, tag, attr, value] = m;
      if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      if (attr !== undefined && !this.hasAttribute(attr)) return false;
      if (attr !== undefined && value !== undefined && this.getAttribute(attr) !== value.replace(/^["']|["']$/g, "")) return false;
      return true;
    });
  }
  closest(selector: string): FakeEl | null {
    for (let at: FakeEl | null = this; at !== null; at = at.parent) if (at.matches(selector)) return at;
    return null;
  }
  getRootNode(): { host?: FakeEl } {
    let at: FakeEl = this;
    while (at.parent !== null) at = at.parent;
    return at.shadowHost === null ? {} : { host: at.shadowHost };
  }
  append(...kids: FakeEl[]): this {
    for (const kid of kids) {
      kid.parent = this;
      this.children.push(kid);
    }
    return this;
  }
}

/** A document at `url`; `framed` makes its window not the top one. */
export function fakeDoc(url: string, framed = false): FakeDoc {
  const parsed = new URL(url);
  const all: FakeEl[] = [];
  const view = { top: null as unknown, getComputedStyle: (el: FakeEl) => ({ getPropertyValue: (name: string) => el.style[name] ?? "" }) };
  view.top = framed ? {} : view;
  const inShadow = (element: FakeEl) => {
    let at: FakeEl = element;
    while (at.parent !== null) at = at.parent;
    return at.shadowHost !== null;
  };
  return {
    location: { href: parsed.href, origin: parsed.origin, pathname: parsed.pathname, search: parsed.search, hash: parsed.hash },
    defaultView: view,
    getElementById: (id) => all.find((el) => el.getAttribute("id") === id) ?? null,
    all,
    activeElement: null,
    body: null,
    querySelectorAll: () => all.filter((element) => !inShadow(element)),
  };
}

/** An element of `doc`. */
export function el(doc: FakeDoc, tag: string, attrs: Record<string, string> = {}, text = ""): FakeEl {
  const made = new FakeEl(tag.toUpperCase(), attrs, text, doc);
  doc.all.push(made);
  return made;
}
