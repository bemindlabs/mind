/**
 * The mascot's two artworks, light and dark (design system spec §7, owner ruling 2026-10-13: the same character,
 * recoloured from gold to the cyan-to-indigo of the design system).
 *
 * `docs/assets/mascot.svg` is the one file; `src/web/mascot.ts` holds it as a string. Every colour in it is a design
 * token, written as the fallback of a variable (light) and set again for dark. Held here:
 * - **The tokens**: each variable is the token its comment says, in the light fallback and in the dark values, and no
 *   other colour is written anywhere (so no gold is left).
 * - **The readable face**: the dark neutral of the eyes and mouth keeps 4.5:1 or more against the body wherever it is
 *   drawn, in both artworks, computed from the body's own gradient.
 * - **The edge and the sparks** keep 3:1 or more against the surfaces the mascot sits on.
 * - **The halo** is never stronger than the spec's glow limit, so it can sit where text is.
 * - **No script**: the artwork switches by CSS alone, and the page hides the artwork it is not showing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MASCOT_DARK_DATA_URI, MASCOT_DARK_SVG, MASCOT_DATA_URI, MASCOT_LIGHT_DATA_URI, MASCOT_LIGHT_SVG, MASCOT_SVG } from "../../src/web/mascot.ts";
import { PAGE_HTML } from "../../src/web/page.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const FILE = readFileSync(join(ROOT, "docs", "assets", "mascot.svg"), "utf8");
const TOKENS_JSON = JSON.parse(readFileSync(join(ROOT, "src", "web", "tokens", "tokens.json"), "utf8")) as {
  readonly colors: Readonly<Record<"light" | "dark", Readonly<Record<string, { readonly hex: string }>>>>;
  readonly glowMaxAlpha: number;
};
const TOKEN_HEX = (scheme: "light" | "dark", name: string): string => {
  const token = TOKENS_JSON.colors[scheme][name];
  if (token === undefined) throw new Error(`no token ${name} in ${scheme}`);
  return token.hex;
};

/** Each variable of the SVG, and the token it is in each artwork. The comment inside the SVG says the same. */
const ROLES: Readonly<Record<string, { readonly light: string; readonly dark: string }>> = {
  "m-hi": { light: "background", dark: "foreground" },
  "m-glow": { light: "info-surface", dark: "primary" },
  "m-mid": { light: "primary", dark: "brand-2" },
  "m-indigo": { light: "brand-2", dark: "brand-2" },
  "m-cyan": { light: "primary", dark: "primary" },
  "m-ink": { light: "foreground", dark: "primary-foreground" },
  "m-blush": { light: "brand-2", dark: "primary-foreground" },
  "m-ground": { light: "foreground", dark: "primary" },
};

// --- arithmetic ------------------------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number];
const rgbOfHex = (hex: string): Rgb => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
const luminance = ([r, g, b]: Rgb): number => {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;

// --- what the SVG says -----------------------------------------------------------------------------------------------

/** The variables of the artwork forced dark, as `{ "m-hi": "#f8fafc", ... }`. */
const declarations = (block: string): Readonly<Record<string, string>> =>
  Object.fromEntries([...block.matchAll(/--(m-[a-z]+):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1]!, match[2]!]));
const FORCED_DARK = declarations(/:root\.dark\s*\{([^}]*)\}/.exec(FILE)![1]!);
const MEDIA_DARK = declarations(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\.light\)\s*\{([^}]*)\}/.exec(FILE)![1]!);
/** Every use of a variable: its name and the light colour written as its fallback. */
const USES = [...FILE.matchAll(/var\(--(m-[a-z]+),(#[0-9a-f]{6})\)/g)].map((match) => ({ name: match[1]!, light: match[2]! }));

/** The body gradient, as the stops it draws: offset and the variable each is. */
const BODY = /<radialGradient id="body"([^>]*)>([\s\S]*?)<\/radialGradient>/.exec(FILE)!;
const BODY_STOPS = [...BODY[2]!.matchAll(/<stop offset="([\d.]+)" style="stop-color:var\(--(m-[a-z]+),/g)].map((match) => ({ offset: Number(match[1]), name: match[2]! }));

/** The body path's box, from its drawing: x 66 to 174, y 36 to 200 (the circle's arc ends at 146 + 54). */
const BOX = { x: 66, y: 36, width: 108, height: 164 } as const;

function bodyColourAt(scheme: "light" | "dark", x: number, y: number): Rgb {
  const circle = { cx: 0.45, cy: 0.62, r: 0.62 };
  expect(BODY[1]).toContain('cx="45%" cy="62%" r="62%"');
  const dx = (x - BOX.x) / BOX.width - circle.cx;
  const dy = (y - BOX.y) / BOX.height - circle.cy;
  const offset = Math.min(1, Math.hypot(dx, dy) / circle.r);
  const colourOf = (name: string) => rgbOfHex(TOKEN_HEX(scheme, ROLES[name]![scheme]));
  for (let i = 1; i < BODY_STOPS.length; i += 1) {
    const [from, to] = [BODY_STOPS[i - 1]!, BODY_STOPS[i]!];
    if (offset <= to.offset) return mix(colourOf(from.name), colourOf(to.name), (offset - from.offset) / (to.offset - from.offset));
  }
  return colourOf(BODY_STOPS[BODY_STOPS.length - 1]!.name);
}

/** Points on the eyes and the mouth: each eye's rim and centre, and the smile's curve with its stroke's two edges. */
function facePoints(): readonly { readonly what: string; readonly x: number; readonly y: number }[] {
  const points: { what: string; x: number; y: number }[] = [];
  for (const cx of [104, 136]) {
    points.push({ what: "eye", x: cx, y: 146 });
    for (let step = 0; step < 16; step += 1) {
      const angle = (step / 16) * 2 * Math.PI;
      points.push({ what: "eye", x: cx + 6 * Math.cos(angle), y: 146 + 8.5 * Math.sin(angle) });
    }
  }
  for (let step = 0; step <= 10; step += 1) {
    const t = step / 10;
    const x = (1 - t) ** 2 * 112 + 2 * (1 - t) * t * 120 + t ** 2 * 128;
    const y = (1 - t) ** 2 * 164 + 2 * (1 - t) * t * 172 + t ** 2 * 164;
    for (const lift of [-1.5, 0, 1.5]) points.push({ what: "mouth", x, y: y + lift });
  }
  return points;
}

// --- the tests -------------------------------------------------------------------------------------------------------

describe("the file and the string", () => {
  test("src/web/mascot.ts holds docs/assets/mascot.svg exactly, and the two forced artworks differ from it by one class", () => {
    expect(MASCOT_SVG).toBe(FILE);
    expect(MASCOT_LIGHT_SVG).toBe(FILE.replace("<svg ", '<svg class="light" '));
    expect(MASCOT_DARK_SVG).toBe(FILE.replace("<svg ", '<svg class="dark" '));
    expect(FILE.split("<svg ").length).toBe(2);
  });

  test("the data URIs are those three SVGs", () => {
    for (const [uri, svg] of [[MASCOT_DATA_URI, MASCOT_SVG], [MASCOT_LIGHT_DATA_URI, MASCOT_LIGHT_SVG], [MASCOT_DARK_DATA_URI, MASCOT_DARK_SVG]] as const) {
      expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(Buffer.from(uri.slice("data:image/svg+xml;base64,".length), "base64").toString()).toBe(svg);
    }
  });

  test("it is a well-formed document with no script, no link and no event handler", () => {
    expect(FILE).not.toMatch(/<script|<foreignObject|\shref=|\sxlink:href=|\son[a-z]+=|@import|url\((?!#)/i);
    // A comment may not hold two hyphens in a row, or a browser refuses the whole image.
    for (const comment of FILE.matchAll(/<!--([\s\S]*?)-->/g)) expect(comment[1]).not.toContain("--");
    // Every element is closed, in order: a browser refuses a half-written SVG as an image.
    const open: string[] = [];
    for (const tag of FILE.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([a-zA-Z]+)\b[^>]*?(\/?)>/g)) {
      if (tag[3] === "/") continue;
      if (tag[1] === "/") expect(open.pop()).toBe(tag[2]!);
      else open.push(tag[2]!);
    }
    expect(open).toEqual([]);
  });
});

describe("the colours are the design tokens", () => {
  test("every variable is one of the roles, and the dark artwork sets exactly those, once for the device and once when forced", () => {
    const used = new Set(USES.map((use) => use.name));
    expect([...used].sort()).toEqual(Object.keys(ROLES).sort());
    expect(Object.keys(FORCED_DARK).sort()).toEqual(Object.keys(ROLES).sort());
    expect(MEDIA_DARK).toEqual(FORCED_DARK);
  });

  test("the light colour written beside each use is the role's light token, and the dark value is its dark token", () => {
    for (const use of USES) expect(use.light).toBe(TOKEN_HEX("light", ROLES[use.name]!.light));
    for (const [name, role] of Object.entries(ROLES)) expect(FORCED_DARK[name]).toBe(TOKEN_HEX("dark", role.dark));
  });

  test("no other colour is written: nothing is left of the gold, the mint or the navy", () => {
    const bare = FILE.replace(/<!--[\s\S]*?-->/g, "").replace(/var\(--m-[a-z]+,#[0-9a-f]{6}\)/g, "").replace(/--m-[a-z]+:\s*#[0-9a-f]{6}/g, "");
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/);
    for (const gone of ["#fffbe8", "#ffe08a", "#ffb52e", "#e07a12", "#ffc94d", "#ff9f1c", "#5eead4", "#ffd166", "#fff3c4", "#ff7a45", "#3b2306", "#0b1a33"]) {
      expect(FILE.toLowerCase()).not.toContain(gone);
      expect(MASCOT_SVG.toLowerCase()).not.toContain(gone);
    }
    expect(FILE).not.toMatch(/gold/i);
  });

  test("the body runs from the accent gradient: the cyan stop is the primary token and the edge is brand-2, in both artworks", () => {
    expect(BODY_STOPS.map((stop) => stop.offset)).toEqual([0, 0.28, 0.62, 1]);
    expect(BODY_STOPS.map((stop) => stop.name)).toEqual(["m-hi", "m-glow", "m-mid", "m-indigo"]);
    for (const scheme of ["light", "dark"] as const) {
      expect(ROLES["m-indigo"]![scheme]).toBe("brand-2");
      expect(["primary", "brand-2"]).toContain(ROLES["m-mid"]![scheme]);
      expect(["primary", "info-surface"]).toContain(ROLES["m-glow"]![scheme]);
    }
  });
});

describe("readable and visible, in both artworks", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: the eyes and the mouth keep 4.5:1 against the body wherever they are drawn`, () => {
      const ink = rgbOfHex(TOKEN_HEX(scheme, ROLES["m-ink"]![scheme]));
      const worst = Math.min(...facePoints().map((point) => contrast(ink, bodyColourAt(scheme, point.x, point.y))));
      expect(worst).toBeGreaterThanOrEqual(4.5);
    });

    test(`${scheme}: the eye lights show against the eyes, and the edge and the sparks keep 3:1 against background, card and surface`, () => {
      const ink = rgbOfHex(TOKEN_HEX(scheme, ROLES["m-ink"]![scheme]));
      expect(contrast(rgbOfHex(TOKEN_HEX(scheme, ROLES["m-hi"]![scheme])), ink)).toBeGreaterThanOrEqual(4.5);
      for (const surface of ["background", "card", "surface"]) {
        const ground = rgbOfHex(TOKEN_HEX(scheme, surface));
        for (const role of ["m-indigo", "m-cyan"]) {
          expect(contrast(rgbOfHex(TOKEN_HEX(scheme, ROLES[role]![scheme])), ground)).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }

  test("the halo is the cyan end of the gradient and never stronger than the glow limit", () => {
    const halo = /<radialGradient id="halo"[^>]*>([\s\S]*?)<\/radialGradient>/.exec(FILE)![1]!;
    const opacities = [...halo.matchAll(/stop-opacity="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(opacities.length).toBe(3);
    expect(Math.max(...opacities)).toBeLessThanOrEqual(TOKENS_JSON.glowMaxAlpha);
    expect(halo).toContain("var(--m-cyan,");
    expect(halo).not.toMatch(/--m-(?!cyan)/);
  });

  test("the ribbon runs from cyan to indigo and fades at both ends", () => {
    const ribbon = /<linearGradient id="ribbon"[^>]*>([\s\S]*?)<\/linearGradient>/.exec(FILE)![1]!;
    const stops = [...ribbon.matchAll(/<stop offset="([\d.]+)" style="stop-color:var\(--(m-[a-z]+),#[0-9a-f]{6}\)" stop-opacity="([\d.]+)"/g)].map((match) => [Number(match[1]), match[2], Number(match[3])]);
    expect(stops).toEqual([[0, "m-cyan", 0], [0.3, "m-cyan", 0.9], [0.7, "m-indigo", 0.9], [1, "m-indigo", 0]]);
  });

  test("the mascot's animation obeys reduced motion: every animated class is in the reduce rule", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(FILE)![1]!;
    const animated = new Set([...style.matchAll(/\.([a-z0-9]+)(?:\.[a-z])?\s*\{[^}]*animation:/g)].map((match) => match[1]));
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*([^{]*)\{\s*animation: none;/.exec(style)![1]!;
    const listed = new Set([...reduced.matchAll(/\.([a-z0-9]+)/g)].map((match) => match[1]));
    expect(animated.size).toBeGreaterThan(5);
    expect(listed).toEqual(animated);
  });
});

describe("in the page", () => {
  test("the brand shows the light and the dark artwork, decoratively, and hides the one that is not the theme's", () => {
    expect(PAGE_HTML).toContain(`<img class="logo logo-light" src="${MASCOT_LIGHT_DATA_URI}" alt="" aria-hidden="true">`);
    expect(PAGE_HTML).toContain(`<img class="logo logo-dark" src="${MASCOT_DARK_DATA_URI}" alt="" aria-hidden="true">`);
    // The tab icon cannot see the page's data-theme, so it is the bare artwork, which follows the device.
    expect(PAGE_HTML).toContain(`<link rel="icon" type="image/svg+xml" href="${MASCOT_DATA_URI}">`);
    // Same switch as the page's colours: data-theme when chosen, the device when not.
    expect(PAGE_HTML).toContain(".logo-dark{display:none}");
    expect(PAGE_HTML).toContain("@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .logo-light{display:none}:root:not([data-theme=light]) .logo-dark{display:inline}}");
    expect(PAGE_HTML).toContain(":root[data-theme=dark] .logo-light{display:none}:root[data-theme=dark] .logo-dark{display:inline}");
  });

  test("the thinking indicator takes both artworks too, so the one it shows follows the theme", () => {
    expect(PAGE_HTML).toContain('["logo-light", "logo-dark"].map((kind) => { const mini = el("img", kind); mini.src = document.querySelector("." + kind).src;');
  });
});
