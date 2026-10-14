/**
 * The console's colours, type, focus, keys, touch and motion against the shared design system (spec v0.1, S0
 * approved 2026-10-12; S3). Nothing here reads a ratio from a table: every one is computed from the HSL triplets the
 * page ships (`src/web/tokens/tokens.css`, inlined into `PAGE_HTML`), converted to the 8-bit colour that is drawn,
 * which is the method of mind-app's `test/design/contrast.test.ts` and mind-platform's `test/ui/tokens.test.ts`.
 *
 * - **The spec's pair table**, light and dark: every text pair 4.5:1 or more, every edge and focus pair 3:1 or more.
 * - **The pairs this page draws** beyond it: each rule of its stylesheet that puts colour on colour is listed below,
 *   with the selector it came from, and held to the same minimums.
 * - **The names**: the page uses the shared token names, every `hsl(var(--x))` names a token that exists, and no raw
 *   colour is written in the page's stylesheet.
 * - **Behaviour as text**: the skip link first, the tab keys, the three-state theme button and the script that sets
 *   `data-theme` before first paint, the one focus ring, 44px under a coarse pointer, nothing under 12px, reduced
 *   motion, and a glow no stronger than the spec's limit behind text. (The behaviour itself was driven in a real
 *   browser when this was built; this holds what can be held from the text.)
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FONT_CSS, FONT_STACK } from "../../src/web/fonts.ts";
import { PAGE_HTML } from "../../src/web/page.ts";
import { TOKEN_HEADER } from "../../src/web/token-header.ts";
import { TOKENS_CSS } from "../../src/web/tokens.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const TOKENS_JSON = JSON.parse(readFileSync(join(ROOT, "src", "web", "tokens", "tokens.json"), "utf8")) as {
  readonly colors: Readonly<Record<"light" | "dark", Readonly<Record<string, { readonly hsl: string; readonly hex: string }>>>>;
  readonly contrast: readonly { readonly fg: string; readonly bg: string; readonly rule: "text" | "ui" | "decorative"; readonly ratio: { readonly light: number; readonly dark: number } }[];
  readonly glowMaxAlpha: number;
};

type Theme = "light" | "dark";
type Hsl = readonly [number, number, number];
type Rgb = readonly [number, number, number];

// --- the page's own stylesheet ---------------------------------------------------------------------------------------

const STYLE = /<style>([\s\S]*?)<\/style>/.exec(PAGE_HTML)![1]!;
/** The page's rules, without the shared tokens and the fonts that come first: what this file wrote itself. */
const OWN_START = STYLE.indexOf("*{box-sizing:border-box}");
if (OWN_START < 0) throw new Error("the page's own rules no longer start where this test looks for them");
const OWN_CSS = STYLE.slice(OWN_START);
const NO_COMMENTS = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// --- the tokens the page ships ---------------------------------------------------------------------------------------

const declarations = (block: string): Readonly<Record<string, string>> =>
  Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));

const LIGHT_BLOCK = declarations(/^:root \{([\s\S]*?)\n\}/m.exec(TOKENS_CSS)![1]!);
const DARK_BLOCK = declarations(/^:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/m.exec(TOKENS_CSS)![1]!);
const SYSTEM_DARK_BLOCK = declarations(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/.exec(TOKENS_CSS)![1]!);

function hslOf(value: string): Hsl {
  const match = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(value);
  if (match === null) throw new Error(`not an HSL triplet: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const NAMES = Object.keys(TOKENS_JSON.colors.light);
const THEMES: Readonly<Record<Theme, Readonly<Record<string, Hsl>>>> = {
  light: Object.fromEntries(NAMES.map((name) => [name, hslOf(LIGHT_BLOCK[name]!)])),
  dark: Object.fromEntries(NAMES.map((name) => [name, hslOf(DARK_BLOCK[name]!)])),
};

// --- the arithmetic --------------------------------------------------------------------------------------------------

function rgbOf([h, s, l]: Hsl): Rgb {
  const saturation = s / 100;
  const lightness = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(channel(0) * 255), Math.round(channel(8) * 255), Math.round(channel(4) * 255)];
}

function luminance([r, g, b]: readonly number[]): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
}

function ratio(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const over = (top: readonly number[], bottom: readonly number[], alpha: number): number[] => top.map((value, index) => value * alpha + bottom[index]! * (1 - alpha));
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;
const colourRatio = (name: Theme, fg: string, bg: string) => ratio(rgbOf(THEMES[name][fg]!), rgbOf(THEMES[name][bg]!));

// --- the spec's pair table -------------------------------------------------------------------------------------------

describe("the spec's pair table, recomputed from the HSL the page ships", () => {
  test("it is the whole table: 34 pairs, every rule present", () => {
    expect(TOKENS_JSON.contrast).toHaveLength(34);
    const rules = TOKENS_JSON.contrast.map((pair) => pair.rule);
    expect(rules.filter((rule) => rule === "text")).toHaveLength(25);
    expect(rules.filter((rule) => rule === "ui")).toHaveLength(8);
    expect(rules.filter((rule) => rule === "decorative")).toHaveLength(1);
  });

  for (const name of ["light", "dark"] as const) {
    test(`${name}: every text pair 4.5:1 or more, every edge and focus pair 3:1 or more; the hairline is never counted on`, () => {
      const failing: string[] = [];
      for (const pair of TOKENS_JSON.contrast) {
        const actual = colourRatio(name, pair.fg, pair.bg);
        const minimum = pair.rule === "text" ? AA_TEXT : pair.rule === "ui" ? AA_NON_TEXT : 0;
        if (!(actual >= minimum)) failing.push(`${pair.fg} on ${pair.bg}: ${actual.toFixed(2)} (needs ${minimum})`);
        if (Math.abs(actual - pair.ratio[name]) > 0.006) failing.push(`${pair.fg} on ${pair.bg}: computed ${actual.toFixed(3)}, table says ${pair.ratio[name]}`);
        if (pair.rule === "decorative") expect(actual).toBeLessThan(AA_NON_TEXT);
      }
      expect(failing).toEqual([]);
    });
  }

  test("the arithmetic, on known values (so a wrong formula cannot pass everything)", () => {
    expect(ratio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(ratio([255, 255, 255], [255, 255, 255])).toBe(1);
    expect(ratio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
    expect(rgbOf([190, 80, 32])).toEqual([0x10, 0x7d, 0x93]);
  });

  test("dark is the same whether the device chose it or the person did", () => {
    for (const token of [...NAMES, "scrim", "elevation-card", "elevation-raised", "elevation-overlay"]) expect([token, SYSTEM_DARK_BLOCK[token]]).toEqual([token, DARK_BLOCK[token]]);
  });
});

// --- what this page draws, rule by rule -------------------------------------------------------------------------------

/** [selector in the page's stylesheet, foreground token, background token]: text on a fill, as the rule draws it. */
const PAGE_TEXT: readonly (readonly [string, string, string])[] = [
  ["body", "foreground", "background"],
  [".foot (the bar across the bottom)", "muted-foreground", "surface"],
  [".foot b", "foreground", "surface"],
  [".foot .newer", "warning", "surface"],
  [".badge, .chain span.b.local, .tagchip[aria-pressed=true], .tag", "info", "info-surface"],
  ["nav.tabs button", "muted-foreground", "surface"],
  ["nav.tabs button:hover, nav.tabs button[aria-selected=true]", "foreground", "card"],
  ["nav.tabs button[aria-selected=true] on a phone (the label)", "primary-text", "surface"],
  ["button, .agentcard, .engine, section, .card text", "foreground", "card"],
  ["h2.small, .hint, .small, .meta, .engine dt, .railfoot", "muted-foreground", "card"],
  [".hint and .small on a .card (muted)", "muted-foreground", "muted"],
  ["button.primary, .me, .seg button[aria-pressed=true], .steps button[aria-current=step]: label on the gradient's cyan end", "primary-foreground", "primary"],
  ["... and on its indigo end", "primary-foreground", "brand-2"],
  ["button.danger", "destructive", "card"],
  ["button.danger:hover", "destructive", "destructive-surface"],
  ["input, textarea, select", "foreground", "surface"],
  ["::placeholder and the composer's hint", "muted-foreground", "surface"],
  [".chip.calm", "muted-foreground", "muted"],
  [".chip.care, .pill.ask, .bulk .small", "warning", "warning-surface"],
  [".chip.warn, .pill.stop", "destructive", "destructive-surface"],
  [".pill.act", "success", "success-surface"],
  [".toast", "background", "foreground"],
  [".it (an answer), .sys", "foreground", "muted"],
  [".fact .q button (a link)", "primary-text", "card"],
  ["a link on the page", "primary-text", "background"],
  ["code", "foreground", "muted"],
  [".mapwrap labels", "foreground", "card"],
  [".cmdmenu", "foreground", "card"],
  [".cmdmenu button:hover, [aria-selected=true]", "foreground", "muted"],
  [".pickchip, .legchip", "muted-foreground", "surface"],
  [".pickchip b", "foreground", "surface"],
  ["the skip link", "primary-foreground", "primary"],
];

/** [what it is, colour token, the surfaces it must stand out from]: a line, an edge or a mark, 3:1. */
const PAGE_SHAPES: readonly (readonly [string, string, readonly string[]])[] = [
  ["the focus ring, wherever focus can land", "ring", ["background", "card", "surface", "muted", "info-surface", "warning-surface", "destructive-surface", "success-surface"]],
  ["a control's outline: button, field, select, composer, chips, segmented control, drop zone", "input", ["background", "card", "surface"]],
  ["the selected tab's bar, the drop target's border, the checkbox accent", "primary", ["background", "card", "surface", "muted", "info-surface"]],
  ["the status dots (mode, level, brake)", "warning", ["card", "surface", "muted"]],
  ["... success", "success", ["card", "surface", "muted"]],
  ["... destructive, and the red outline of a card in trouble", "destructive", ["background", "card", "surface"]],
  ["... idle", "muted-foreground", ["card", "surface", "muted"]],
  ["memory map: the three memory types and the five kinds of thing (a node needs 3:1 on the map's backdrop)", "primary", ["card", "muted"]],
  ["... feedback / host", "warning", ["card", "muted"]],
  ["... project / env", "brand-2", ["card", "muted"]],
  ["... service", "success", ["card", "muted"]],
  ["... port", "destructive", ["card", "muted"]],
  ["... reference / path", "muted-foreground", ["card", "muted"]],
];

describe("every pair this page draws, in both themes", () => {
  test("the list is not empty and names tokens that exist", () => {
    expect(PAGE_TEXT.length).toBeGreaterThan(25);
    for (const [, fg, bg] of PAGE_TEXT) for (const token of [fg, bg]) expect(NAMES).toContain(token);
    for (const [, colour, surfaces] of PAGE_SHAPES) for (const token of [colour, ...surfaces]) expect(NAMES).toContain(token);
  });

  for (const name of ["light", "dark"] as const) {
    test(`${name}: text 4.5:1 or more`, () => {
      const failing = PAGE_TEXT.map(([where, fg, bg]) => ({ where, fg, bg, ratio: colourRatio(name, fg, bg) })).filter((pair) => !(pair.ratio >= AA_TEXT));
      expect(failing).toEqual([]);
    });

    test(`${name}: outlines, rings, dots and the map's marks 3:1 or more`, () => {
      const failing = PAGE_SHAPES.flatMap(([what, colour, surfaces]) => surfaces.map((bg) => ({ what, colour, bg, ratio: colourRatio(name, colour, bg) }))).filter((pair) => !(pair.ratio >= AA_NON_TEXT));
      expect(failing).toEqual([]);
    });

    test(`${name}: the gradient button's label holds 4.5:1 at the cyan end, the indigo end and the middle`, () => {
      const label = rgbOf(THEMES[name]["primary-foreground"]!);
      const cyan = rgbOf(THEMES[name]["primary"]!);
      const indigo = rgbOf(THEMES[name]["brand-2"]!);
      const middle = cyan.map((value, index) => (value + indigo[index]!) / 2);
      for (const end of [cyan, indigo, middle]) expect(ratio(label, end)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  test("the page really uses these pairs: each selector named for a colour pair writes the tokens listed", () => {
    const css = NO_COMMENTS(OWN_CSS);
    expect(css).toMatch(/body\{[^}]*background:hsl\(var\(--background\)\);color:hsl\(var\(--foreground\)\)/);
    expect(css).toMatch(/\.foot\{[^}]*background:hsl\(var\(--surface\)\)[^}]*color:hsl\(var\(--muted-foreground\)\)/);
    expect(css).toMatch(/\.badge\{[^}]*background:hsl\(var\(--info-surface\)\);color:hsl\(var\(--info\)\)/);
    expect(css).toMatch(/button\.primary\{background:var\(--gradient-accent\)[^}]*color:hsl\(var\(--primary-foreground\)\)/);
    expect(css).toMatch(/button\.danger\{[^}]*border-color:hsl\(var\(--destructive\)\);color:hsl\(var\(--destructive\)\)/);
    expect(css).toMatch(/\.toast\{[^}]*background:hsl\(var\(--foreground\)\);color:hsl\(var\(--background\)\)/);
    expect(css).toMatch(/\.pill\.ask\{background:hsl\(var\(--warning-surface\)\);color:hsl\(var\(--warning\)\)\}/);
    expect(css).toMatch(/button\{[^}]*border:1px solid hsl\(var\(--input\)\)/);
    expect(css).toMatch(/input\[type=text\],textarea,select\{[^}]*border:1px solid hsl\(var\(--input\)\)/);
    expect(css).toMatch(/\.composer\{border:1px solid hsl\(var\(--input\)\)/);
    // The skip link's pair is written where it is drawn.
    expect(css).toMatch(/\.skip\{[^}]*background:hsl\(var\(--primary\)\);color:hsl\(var\(--primary-foreground\)\)/);
  });

  test("the glow behind text: the page's washes are 8% and 6%, under the spec's 12%; and 25% would fail", () => {
    const limit = TOKENS_JSON.glowMaxAlpha;
    expect(limit).toBe(0.12);
    const alphas = [...NO_COMMENTS(OWN_CSS).matchAll(/radial-gradient\([^)]*?hsl\(var\(--(primary|brand-2)\) \/ \.(\d+)\)/g)].map((match) => Number(`0.${match[2]}`));
    expect(alphas.length).toBeGreaterThanOrEqual(2);
    for (const alpha of alphas) expect(alpha).toBeLessThanOrEqual(limit);
    const textOver = (glow: string, surface: string, alpha: number) => ratio(rgbOf(THEMES.dark["muted-foreground"]!), over(rgbOf(THEMES.dark[glow]!), rgbOf(THEMES.dark[surface]!), alpha));
    for (const glow of ["primary", "brand-2"]) for (const surface of ["background", "card"]) expect(textOver(glow, surface, limit)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(textOver("primary", "background", 0.25)).toBeLessThan(AA_TEXT);
  });
});

// --- names ----------------------------------------------------------------------------------------------------------

describe("the page speaks the shared names, and writes no colour of its own", () => {
  test("every hsl(var(--x)) names a token that exists, and the old palette's names are gone", () => {
    const used = new Set([...PAGE_HTML.matchAll(/hsl\(var\(--([a-z0-9-]+)\)/g)].map((match) => match[1]!));
    expect(used.size).toBeGreaterThan(15);
    for (const name of used) expect(NAMES).toContain(name);
    const old = ["bg", "bg2", "ink", "line", "brand", "brand2", "onbrand", "mint", "minbg", "ok", "okbg", "warn", "warnbg", "care", "carebg", "calmbg", "focus", "card2", "shadow"];
    for (const name of old) expect(PAGE_HTML).not.toContain(`var(--${name})`);
    for (const name of old) expect(OWN_CSS).not.toMatch(new RegExp(`--${name}:`));
  });

  test("the page's stylesheet has no hex or rgb colour: the palette is the tokens'", () => {
    const literals = [...NO_COMMENTS(OWN_CSS).matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)].map((match) => match[0]);
    expect(literals).toEqual([]);
    // The one white and the one black on the page are the pairing QR code's: a code must be dark on light to scan, in either theme.
    expect([...PAGE_HTML.matchAll(/#fff\b|#000\b/g)].length).toBeLessThanOrEqual(3);
  });

  test("the header says Mind, in the title, the rail and the footer bar (audit finding 7 stays fixed)", () => {
    expect(PAGE_HTML).toContain("<title>Mind</title>");
    expect(PAGE_HTML).toContain("<b>Mind</b>");
    expect(TOKEN_HEADER).toBe("x-mind-token");
  });

  test("the tokens are inlined whole, once, before the page's own rules", () => {
    expect(STYLE.split(TOKENS_CSS).length).toBe(2);
    expect(STYLE.indexOf(TOKENS_CSS)).toBeLessThan(STYLE.indexOf("*{box-sizing:border-box}"));
  });
});

// --- type, shape, focus, touch, motion -------------------------------------------------------------------------------

describe("type, focus, touch and motion", () => {
  test("Inter and Plex Sans Thai, the spec's stack, 16px, and Thai at a Latin size with the taller line", () => {
    expect(FONT_STACK).toBe(LIGHT_BLOCK["font-sans"]!);
    expect(PAGE_HTML).toContain(`font:var(--text-body-weight) var(--text-body)/var(--leading-body) ${FONT_STACK}`);
    expect(OWN_CSS).not.toContain("font-size:15px");
    expect(FONT_CSS.match(/font-family:"Inter"/g)).toHaveLength(3);
    expect(FONT_CSS).not.toContain("Electrolize");
    expect(FONT_CSS.match(/size-adjust:102\.6%/g)).toHaveLength(2);
    expect(LIGHT_BLOCK["thai-size-adjust"]).toBe("102.6%");
    // :lang(th) sets every leading to 1.65 or more (code excepted), and no tracking.
    const thai = /:lang\(th\) \{([\s\S]*?)\n\}/.exec(TOKENS_CSS)![1]!;
    for (const [, name, value] of thai.matchAll(/--leading-([a-z0-9]+): ([0-9.]+);/g)) if (name !== "code") expect(Number(value)).toBeGreaterThanOrEqual(1.65);
    expect(thai).toContain("letter-spacing: 0");
  });

  test("no text is smaller than 0.75rem (12px)", () => {
    const sizes = [...NO_COMMENTS(OWN_CSS).matchAll(/font-size:([0-9.]+)(rem|px|em)/g)].map((match) => (match[2] === "px" ? Number(match[1]) / 16 : Number(match[1])));
    expect(sizes.length).toBeGreaterThan(20);
    // `code` is .86em of its parent and holds a floor of its own on a phone; everything else is checked here.
    for (const size of sizes.filter((each) => each !== 0.86)) expect(size).toBeGreaterThanOrEqual(0.75);
  });

  test("one focus ring on everything, the token's width and offset, and nothing takes it away but the composer's textarea, whose frame shows it", () => {
    const css = NO_COMMENTS(OWN_CSS);
    expect(css).toContain(":focus-visible{outline:var(--focus-ring-width) solid hsl(var(--ring));outline-offset:var(--focus-ring-offset)}");
    expect(LIGHT_BLOCK["focus-ring-width"]).toBe("2px");
    expect(LIGHT_BLOCK["focus-ring-offset"]).toBe("2px");
    const removals = [...css.matchAll(/([^{}]+)\{[^}]*outline:\s*(?:none|0)\b/g)].map((match) => match[1]!.trim());
    expect(removals).toEqual([".composer textarea:focus-visible", "main:focus"]);
    // The composer's frame carries the ring instead of swapping its border colour alone (audit finding 4).
    expect(css).toMatch(/\.composer:focus-within\{outline:2px solid hsl\(var\(--ring\)\);outline-offset:2px/);
  });

  test("under a coarse pointer every button, field and chip is 44px (the token), with the footer's own button the one exception", () => {
    expect(LIGHT_BLOCK["touch-min"]).toBe("44px");
    expect(LIGHT_BLOCK["touch-floor"]).toBe("24px");
    const css = NO_COMMENTS(OWN_CSS);
    expect(css).toContain("@media (pointer:coarse){button:not(.footver),select,input[type=text],input[type=search]{min-height:var(--touch-min)!important}.tagchip,.legchip,.pickchip{min-height:var(--touch-min)!important}}");
    // With a mouse the smallest control is still above the 24px floor.
    const mins = [...css.matchAll(/min-height:(\d+)px/g)].map((match) => Number(match[1]));
    for (const each of mins) expect(each).toBeGreaterThanOrEqual(24);
  });

  test("reduced motion: the tokens' rule turns every transition and animation off, and the page has no animation it does not cover", () => {
    expect(TOKENS_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation-duration: 0\.01ms !important|@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none/);
    expect(STYLE).toContain("@media (prefers-reduced-motion:reduce)");
    expect(PAGE_HTML).toContain('window.matchMedia("(prefers-reduced-motion: reduce)").matches');
  });
});

describe("keys, the skip link and the theme button", () => {
  test("'Skip to content' is the first thing in the body, and its target is the main region", () => {
    const body = PAGE_HTML.slice(PAGE_HTML.indexOf("<body>"));
    expect(body.indexOf('<a class="skip" href="#main">Skip to content</a>')).toBe("<body>\n".length);
    expect(PAGE_HTML).toContain('<main class="homeon" id="main" tabindex="-1">');
    expect(PAGE_HTML).toContain('<html lang="en">');
  });

  test("the tablist: one tab stop in the markup, arrow, Home and End keys in the script, aria wiring kept", () => {
    const tabs = [...PAGE_HTML.matchAll(/<button role="tab" id="(tab[A-Za-z]+)"( tabindex="-1")? aria-selected="(true|false)" aria-controls="([a-z]+)"/g)];
    expect(tabs).toHaveLength(7);
    expect(tabs.filter((match) => match[2] === undefined).map((match) => match[1])).toEqual(["tabHome"]);
    expect(tabs.filter((match) => match[3] === "true").map((match) => match[1])).toEqual(["tabHome"]);
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) expect(PAGE_HTML).toContain(`"${key}"`);
    expect(PAGE_HTML).toContain('tabEl.tabIndex = t === which ? 0 : -1;');
    expect(PAGE_HTML).toContain('<nav class="tabs" role="tablist" aria-label="Sections">');
    for (const panel of ["home", "agent", "profile", "memories", "tasks", "privacy", "settings"]) expect(PAGE_HTML).toMatch(new RegExp(`id="${panel}"[^>]*role="tabpanel"|role="tabpanel"[^>]*id="${panel}"`));
  });

  test("the theme button: three states in the spec's order, a real button with a spoken state, a status line, kept per device", () => {
    expect(PAGE_HTML).toContain('<button type="button" class="themebtn" id="themeBtn" aria-label="Theme: System"');
    expect(PAGE_HTML).toContain('const THEMES = ["system", "light", "dark"]');
    expect(PAGE_HTML).toContain('b.setAttribute("aria-label", "Theme: " + THEME_WORDS[theme])');
    expect(PAGE_HTML).toContain('role="status" id="themeStatus"');
    expect(PAGE_HTML).toContain('webKeep.set(localStorage, "mind-theme", theme)');
    expect(PAGE_HTML).toContain('webKeep.remove(localStorage, "mind-theme")');
    // System removes the attribute, so the device's own choice decides, live.
    expect(PAGE_HTML).toContain('root.removeAttribute("data-theme")');
    expect(TOKENS_CSS).toContain(':root:not([data-theme="light"])');
    expect(TOKENS_CSS).toContain(':root[data-theme="dark"]');
  });

  test("the saved theme is put on <html> by a script in the head, before the stylesheet, so there is no flash", () => {
    const head = PAGE_HTML.slice(0, PAGE_HTML.indexOf("<style>"));
    expect(head).toContain('webKeep.get(localStorage,"mind-theme")');
    expect(head).toContain('document.documentElement.setAttribute("data-theme",savedTheme)');
    // The storage shim is defined once, in that script, ahead of everything that uses it.
    expect(PAGE_HTML.match(/const webKeep = \{/g)).toHaveLength(1);
    expect(PAGE_HTML.indexOf("const webKeep = {")).toBeLessThan(PAGE_HTML.indexOf("<style>"));
    // The server's policy already allows an inline script, so the page needs no hash for it.
    const server = readFileSync(join(ROOT, "src", "web", "server.ts"), "utf8");
    expect(server).toContain("script-src 'unsafe-inline'");
  });
});
