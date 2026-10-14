/**
 * Markdown on the page (D-070): answers, memories and the soul's notes read as
 * formatted text instead of raw `**` and `#`.
 *
 * Two halves, both plain browser JavaScript kept as a string so the page stays
 * one file with no CDN: `mdTree` turns text into a small tree of nodes, pure,
 * and `mdDom` turns that tree into elements with `createElement` and
 * `textContent` only. Nothing ever becomes HTML, so a note or an answer that
 * contains `<script>` shows those characters and runs nothing. A link is made
 * only for http(s); anything else stays text.
 *
 * Deliberately small: headings, paragraphs, lists (nested by indent), code
 * blocks, block quotes, rules, tables, front matter, and inline code, bold,
 * italic and links. What it does not know it shows as it was written.
 */

// String.raw keeps every backslash for the browser; a backtick is written
// as \x60 inside the regexes, since it cannot appear in this template.
export const MARKDOWN_JS = String.raw`
function mdSafeUrl(u) { return /^https?:\/\/[^\s]+$/i.test(u); }
function mdInline(s) {
  const out = [];
  const re = /(\x60+)([\s\S]*?)\1|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])|(?<![*A-Za-z0-9])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*A-Za-z0-9])|(?<![A-Za-z0-9_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'"])/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: "strong", c: mdInline(m[3] !== undefined ? m[3] : m[4]) });
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ t: "em", c: mdInline(m[5] !== undefined ? m[5] : m[6]) });
    else if (m[7] !== undefined) out.push(mdSafeUrl(m[8]) ? { t: "a", href: m[8], c: mdInline(m[7]) } : { t: "text", v: m[0] });
    else if (m[9] !== undefined) out.push({ t: "a", href: m[9], c: [{ t: "text", v: m[9] }] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}
function mdTree(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const FENCE = /^\s*(\x60{3,}|~{3,})\s*([^\s\x60]*)/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => mdInline(c.trim()));
  const starts = (l, next) => FENCE.test(l) || HEAD.test(l) || HR.test(l) || /^\s*>/.test(l) || LIST.test(l) || (l.includes("|") && next !== undefined && SEP.test(next) && next.includes("-"));
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) { out.push({ t: "meta", v: lines.slice(1, end).join("\n") }); i = end + 1; }
  }
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === "") { i++; continue; }
    let m = FENCE.exec(l);
    if (m) {
      const mark = m[1], body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)))) body.push(lines[i++]);
      i++;
      out.push({ t: "pre", lang: m[2] || "", v: body.join("\n") });
      continue;
    }
    if ((m = HEAD.exec(l))) { out.push({ t: "h", level: m[1].length, c: mdInline(m[2]) }); i++; continue; }
    if (HR.test(l)) { out.push({ t: "hr" }); i++; continue; }
    if (/^\s*>/.test(l)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", c: mdTree(body.join("\n")) });
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(l), rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(cells(lines[i++]));
      out.push({ t: "table", head, rows });
      continue;
    }
    if (LIST.test(l)) {
      const items = [];
      while (i < lines.length) {
        const lm = LIST.exec(lines[i]);
        if (lm) { items.push({ depth: Math.floor(lm[1].replace(/\t/g, "  ").length / 2), ordered: /\d/.test(lm[2]), c: lm[3] }); i++; continue; }
        if (lines[i].trim() !== "" && /^\s+/.test(lines[i]) && items.length) { items[items.length - 1].c += " " + lines[i].trim(); i++; continue; }
        break;
      }
      out.push({ t: "list", items: items.map((it) => ({ depth: it.depth, ordered: it.ordered, c: mdInline(it.c) })) });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !(para.length && starts(lines[i], lines[i + 1]))) para.push(lines[i++]);
    out.push({ t: "p", c: mdInline(para.join("\n")) });
  }
  return out;
}
function mdDom(nodes) {
  const f = document.createDocumentFragment();
  const mk = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const inl = (list, into) => {
    for (const n of list) {
      if (n.t === "text") into.append(document.createTextNode(n.v));
      else if (n.t === "code") { const c = mk("code"); c.textContent = n.v; into.append(c); }
      else if (n.t === "a") { const a = mk("a"); a.href = n.href; a.target = "_blank"; a.rel = "noopener noreferrer"; inl(n.c, a); into.append(a); }
      else { const e = mk(n.t); inl(n.c, e); into.append(e); }
    }
    return into;
  };
  for (const n of nodes) {
    if (n.t === "p") f.append(inl(n.c, mk("p")));
    else if (n.t === "h") f.append(inl(n.c, mk("h" + Math.min(6, n.level + 2), "mdh")));
    else if (n.t === "hr") f.append(mk("hr"));
    else if (n.t === "pre" || n.t === "meta") { const p = mk("pre", n.t === "meta" ? "mdmeta" : ""); const c = mk("code"); c.textContent = n.v; p.append(c); f.append(p); }
    else if (n.t === "quote") { const q = mk("blockquote"); q.append(mdDom(n.c)); f.append(q); }
    else if (n.t === "table") {
      const w = mk("div", "mdtable"), t = mk("table"), hr = mk("tr");
      for (const h of n.head) hr.append(inl(h, mk("th")));
      const th = mk("thead"); th.append(hr); t.append(th);
      const tb = mk("tbody");
      for (const r of n.rows) { const tr = mk("tr"); for (const c of r) tr.append(inl(c, mk("td"))); tb.append(tr); }
      t.append(tb); w.append(t); f.append(w);
    } else if (n.t === "list") {
      const root = mk(n.items[0] && n.items[0].ordered ? "ol" : "ul");
      const stack = [{ el: root, depth: n.items[0] ? n.items[0].depth : 0 }];
      for (const it of n.items) {
        while (stack.length > 1 && it.depth < stack[stack.length - 1].depth) stack.pop();
        let top = stack[stack.length - 1];
        if (it.depth > top.depth && top.el.lastElementChild) {
          const sub = mk(it.ordered ? "ol" : "ul"); top.el.lastElementChild.append(sub);
          stack.push({ el: sub, depth: it.depth }); top = stack[stack.length - 1];
        }
        top.el.append(inl(it.c, mk("li")));
      }
      f.append(root);
    }
  }
  return f;
}
function md(text) { const d = document.createElement("div"); d.className = "md"; d.append(mdDom(mdTree(text))); return d; }
`;

/** Styles for what `md()` produces. */
export const MARKDOWN_CSS = `
.md{white-space:normal}.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:.45em 0;white-space:pre-wrap}.md .mdh{margin:.9em 0 .35em;line-height:1.3}.md h3{font-size:1.12rem}.md h4{font-size:1.02rem}.md h5,.md h6{font-size:.95rem}
.md ul,.md ol{margin:.4em 0;padding-left:1.4em}.md li{margin:.15em 0}
.md pre{background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:8px;padding:8px 10px;overflow:auto;white-space:pre;font-size:.85rem;margin:.5em 0}
.md pre code{background:none;padding:0}.md pre.mdmeta{color:hsl(var(--muted-foreground));font-size:.78rem}
.md blockquote{margin:.5em 0;padding:.1em .9em;border-left:3px solid hsl(var(--border));color:hsl(var(--muted-foreground))}
.md hr{border:0;border-top:1px solid hsl(var(--border));margin:.8em 0}
.md a{color:hsl(var(--primary-text))}
.mdtable{overflow:auto;margin:.5em 0}.md table{border-collapse:collapse;font-size:.88rem}.md th,.md td{border:1px solid hsl(var(--border));padding:4px 8px;text-align:left;vertical-align:top}.md th{background:hsl(var(--muted))}
`;
