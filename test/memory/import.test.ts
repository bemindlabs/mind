/** D-084 — documents and web pages into memory as markdown. */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  addressProblem,
  convertFile,
  convertUrl as convertUrlWith,
  hostProblem,
  decodeEntities,
  docxXmlToMarkdown,
  htmlToMarkdown,
  pinned,
  pinnedGet,
  pinnedLookup,
  planImport,
  resolverRules,
  slugFor,
  splitMarkdown,
  tool,
  urlProblem,
  type Fetcher,
  type Resolver,
  type Runner,
} from "../../src/memory/import.ts";
import { MAX_MEMORY_BYTES } from "../../src/memory/write.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir() {
  const d = await mkdtemp(join(tmpdir(), "mind-import-"));
  scratch.push(d);
  return d;
}
const NOW = new Date("2026-09-26T10:00:00Z");

/** Every name these tests use is a public one: the lookup is handed in, so no test reaches a real resolver (WEB-01). */
const PUBLIC = "93.184.216.34";
const publicDns: Resolver = async () => [PUBLIC];
const convertUrl = (raw: string, fetcher: Fetcher, scratch: string, run?: Runner) => convertUrlWith(raw, fetcher, scratch, run, publicDns);
const bytes = (s: string) => new TextEncoder().encode(s);

/** A pretend pdftotext / unzip / soffice, so the paths are tested where the tools are not installed. */
const fake: Runner = async (argv) => {
  if (argv[0] === "pdftotext") return { code: 0, stdout: bytes("Page one text.\n\n\nPage two."), stderr: "" };
  if (argv[0] === "unzip") return { code: 0, stdout: bytes('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p><w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:body></w:document>'), stderr: "" };
  if (argv[0] === "soffice") {
    const to = argv[argv.indexOf("--convert-to") + 1]!;
    const outdir = argv[argv.indexOf("--outdir") + 1]!;
    const file = argv[argv.length - 1]!;
    const stem = file.split("/").pop()!.replace(/\.[^.]+$/, "");
    await writeFile(join(outdir, `${stem}.${to}`), to === "csv" ? "a,b\n1,2\n" : "%PDF");
    return { code: 0, stdout: new Uint8Array(), stderr: "" };
  }
  return { code: 127, stdout: new Uint8Array(), stderr: "no such tool" };
};
const broken: Runner = async () => ({ code: 1, stdout: new Uint8Array(), stderr: "exploded" });

describe("html → markdown", () => {
  test("keeps the article's words and structure, drops scripts, styles, navigation", () => {
    const page = `<html><head><title>Ports &amp; Services</title><style>p{}</style></head><body>
      <nav><a href="/">Home</a></nav>
      <article><h1>Ports</h1><p>Use <b>30700</b> and <em>never</em> <code>3000</code>. <a href="/docs?a=1&amp;b=2">docs</a> <a href="javascript:x()">run</a> <a href="#top">up</a></p>
      <ul><li>one</li><li>two</li></ul><table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>
      <pre><code>if (a &lt; b) {
  go();
}</code></pre><script>alert(1)</script><!-- note --></article><footer>© x</footer></body></html>`;
    const md = htmlToMarkdown(page, "https://example.org/x/");
    expect(md.title).toBe("Ports & Services");
    expect(md.markdown).toContain("# Ports");
    expect(md.markdown).toContain("Use **30700** and *never* `3000`. [docs](https://example.org/docs?a=1&b=2) run up");
    expect(md.markdown).toContain("- one\n- two");
    expect(md.markdown).toContain("| k | v |");
    expect(md.markdown).toContain("```\nif (a < b) {\n  go();\n}\n```");
    for (const gone of ["alert", "Home", "note", "©", "p{}"]) expect(md.markdown).not.toContain(gone);
    expect(htmlToMarkdown("<p>no base <a href='x.html'>x</a></p>").markdown).toBe("no base [x](x.html)");
  });

  test("entities, named and numbered; unknown ones stay", () => {
    expect(decodeEntities("&lt;a&gt; &#3585; &#x0E01; &hellip; &bogus; &#0;")).toBe("<a> ก ก … &bogus; &#0;");
  });
});

describe("docx → markdown", () => {
  test("title, headings, lists, tables, tabs and breaks", () => {
    const xml =
      '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Goals</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>ship</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:r><w:tab/><w:t>B&amp;C</w:t><w:br/><w:t>D</w:t></w:r></w:p><w:p/>' +
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>k</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>v</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>";
    expect(docxXmlToMarkdown(xml)).toBe("# Plan\n\n## Goals\n\n- ship\nA B&C\nD\n\n| k | v |");
  });
});

describe("converting a file", () => {
  test("md, txt, html and data as written; the title from a heading or the name", async () => {
    const d = await dir();
    await writeFile(join(d, "a.md"), "# Real title\r\n\r\ntext\r\n");
    expect(await convertFile(join(d, "a.md"), "a.md", d)).toEqual({ title: "Real title", markdown: "# Real title\n\ntext", via: "as written" });
    await writeFile(join(d, "b.txt"), "just words");
    expect((await convertFile(join(d, "b.txt"), "meeting_notes-2.txt", d)).title).toBe("meeting notes 2");
    await writeFile(join(d, "c.html"), "<p>hello</p>");
    expect(await convertFile(join(d, "c.html"), "c.html", d)).toMatchObject({ title: "c", markdown: "hello" });
    await writeFile(join(d, "d.json"), '{"a":1}\n');
    expect((await convertFile(join(d, "d.json"), "d.json", d)).markdown).toBe('```json\n{"a":1}\n```');
    await expect(convertFile(join(d, "b.txt"), "b.exe", d)).rejects.toThrow(".exe is not a kind");
  });

  test("pdf, docx, office documents and sheets through their tools", async () => {
    const d = await dir();
    for (const n of ["x.pdf", "x.docx", "x.pptx", "x.xlsx"]) await writeFile(join(d, n), "bytes");
    expect(await convertFile(join(d, "x.pdf"), "x.pdf", d, fake)).toEqual({ title: "x", markdown: "Page one text.\n\nPage two.", via: "pdftotext" });
    expect(await convertFile(join(d, "x.docx"), "x.docx", d, fake)).toEqual({ title: "x", markdown: "# Plan\n\nBody.", via: "docx → markdown" });
    expect(await convertFile(join(d, "x.pptx"), "x.pptx", d, fake)).toMatchObject({ via: "LibreOffice → pdftotext", markdown: "Page one text.\n\nPage two." });
    expect(await convertFile(join(d, "x.xlsx"), "x.xlsx", d, fake)).toMatchObject({ markdown: "```csv\na,b\n1,2\n```" });
    // A .docx that is not a zip goes to LibreOffice instead.
    const noZip: Runner = (argv) => (argv[0] === "unzip" ? broken(argv) : fake(argv));
    expect((await convertFile(join(d, "x.docx"), "x.docx", d, noZip)).via).toBe("LibreOffice → pdftotext");
    await expect(convertFile(join(d, "x.pdf"), "x.pdf", d, broken)).rejects.toThrow("pdftotext (poppler-utils) did not run (exploded)");
    await expect(convertFile(join(d, "x.pptx"), "x.pptx", d, broken)).rejects.toThrow("LibreOffice (soffice) did not run");
  });

  test("the real tools, where they are installed", async () => {
    const out = await tool(["pdftotext", "-v"]);
    expect(typeof out.code).toBe("number");
    expect((await tool(["definitely-not-a-tool-mind"])).code).not.toBe(0);
  });
});

describe("converting a link", () => {
  const reply = (body: string | Uint8Array, type: string, status = 200, url = "https://example.org/docs/page"): Fetcher =>
    async () => Object.defineProperty(new Response(body, { status, headers: { "content-type": type } }), "url", { value: url });

  test("only http and https, no passwords", () => {
    expect(urlProblem("https://example.org")).toBeUndefined();
    expect(urlProblem("file:///etc/passwd")).toContain("only http and https");
    expect(urlProblem("https://u:p@example.org")).toContain("password");
    expect(urlProblem("not a url")).toContain("not a web address");
  });

  test("a JavaScript app's empty shell is run in a headless browser, then read; with none, it says so", async () => {
    const shell = "<!doctype html><html><head><title>Tonkla</title></head><body><div id=root></div><script src=/a.js></script></body></html>";
    const full = `<html><body><main><h1>Portfolio</h1><p>${"Lead engineer, event badges, visitor stamps. ".repeat(5)}</p></main></body></html>`;
    const tried: string[] = [];
    const chromium: Runner = async (argv) => {
      tried.push(argv[0]!);
      if (argv[0] !== "chromium") return { code: 127, stdout: new Uint8Array(), stderr: "not found" };
      expect(argv).toContain("--dump-dom");
      expect(argv.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
      return { code: 0, stdout: bytes(full), stderr: "" };
    };
    const got = await convertUrl("https://p.example/", reply(shell, "text/html", 200, "https://p.example/"), tmpdir(), chromium);
    expect(got.via).toBe("fetched · rendered in chromium · html → markdown");
    expect(got.markdown).toContain("# Portfolio");
    expect(got.title).toBe("Tonkla");
    expect(tried).toEqual(["google-chrome", "google-chrome-stable", "chromium"]);
    const none: Runner = async () => ({ code: 127, stdout: new Uint8Array(), stderr: "not found" });
    await expect(convertUrl("https://p.example/", reply(shell, "text/html"), tmpdir(), none)).rejects.toThrow("no headless Chrome or Chromium was found");
    const empty: Runner = async (argv) => (argv[0] === "google-chrome" ? { code: 1, stdout: new Uint8Array(), stderr: "crashed\nmore" } : none(argv));
    await expect(convertUrl("https://p.example/", reply(shell, "text/html"), tmpdir(), empty)).rejects.toThrow("showed none even after google-chrome ran it (crashed)");
    // A short page with no scripts is what it is: no browser is started for it.
    const short = await convertUrl("https://p.example/", reply("<p>Just this.</p>", "text/html"), tmpdir(), none);
    expect(short.markdown).toBe("Just this.");
  });

  test("a page, a text file, a PDF; a failure says why", async () => {
    const page = await convertUrl("https://example.org/docs/page", reply("<title>Docs</title><main><p>See <a href='../a'>a</a></p></main>", "text/html; charset=utf-8"), tmpdir());
    expect(page).toEqual({ title: "Docs", markdown: "See [a](https://example.org/a)", via: "fetched · html → markdown", url: "https://example.org/docs/page" });
    expect((await convertUrl("https://example.org/r.md", reply("# Readme\n\nhi", "text/markdown", 200, "https://example.org/r.md"), tmpdir())).title).toBe("Readme");
    expect((await convertUrl("https://example.org/r.txt", reply("plain", "text/plain", 200, "https://example.org/notes.txt"), tmpdir())).title).toBe("notes");
    expect((await convertUrl("https://example.org/f.pdf", reply(bytes("%PDF"), "application/pdf", 200, "https://example.org/f.pdf"), tmpdir(), fake)).markdown).toBe("Page one text.\n\nPage two.");
    expect((await convertUrl("https://example.org/", reply("<p>x</p>", "text/html", 200, "https://example.org/"), tmpdir())).title).toBe("example.org");
    await expect(convertUrl("https://example.org/x", reply("gone", "text/plain", 404), tmpdir())).rejects.toThrow("answered 404");
    await expect(convertUrl("https://example.org/x", reply(bytes("\x00"), "image/png"), tmpdir())).rejects.toThrow("not a page, a PDF or text");
    await expect(convertUrl("ftp://example.org/x", reply("", "text/plain"), tmpdir())).rejects.toThrow("only http and https");
  });
});

describe("WEB-01 — a link is fetched from a public address only", () => {
  const html = (words: string) => `<!doctype html><title>t</title><main><p>${words.repeat(10)}</p></main>`;
  const page = (body = html("Public words here. ")): Fetcher => async () => new Response(body, { headers: { "content-type": "text/html" } });
  /** A fetcher that says what it was asked for, and answers from a script of statuses. */
  function scripted(answers: Record<string, () => Response>) {
    const asked: { readonly url: string; readonly redirect: RequestInit["redirect"] }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      asked.push({ url, redirect: init.redirect });
      const answer = answers[url];
      if (answer === undefined) throw new Error(`unexpected fetch of ${url}`);
      return answer();
    };
    return { fetcher, asked };
  }
  const redirectTo = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
  const ok = (body = html("Public words here. ")) => () => new Response(body, { headers: { "content-type": "text/html" } });

  test("a link to this machine, a LAN, a tailnet or a metadata service is refused by number, in every spelling", () => {
    for (const private_ of [
      "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://localhost/", "http://localhost./", "http://app.localhost/",
      "http://[::1]/", "http://[::]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:a00:1]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/", "http://[2002:a9fe:a9fe::1]/",
      "http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[ff02::1]/", "http://[2001:db8::1]/", "http://[2001::1]/",
      "http://10.0.0.1/", "http://10.255.255.255/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://100.64.0.1/", "http://100.100.100.200/", "http://100.127.255.255/", "http://0.0.0.0/", "http://224.0.0.1/", "http://255.255.255.255/", "http://198.18.0.1/",
      "http://printer.local/", "http://metadata.google.internal/", "http://nas.lan/", "http://box.home.arpa/", "http://x.localdomain/",
    ]) {
      const why = urlProblem(private_);
      expect(why, private_).toBeDefined();
      expect(why, private_).toContain("only public web pages are fetched");
    }
  });

  test("a public address, or one that only looks near a private range, is not refused", () => {
    for (const fine of [
      "https://example.org/", "https://93.184.216.34/", "http://8.8.8.8/", "http://172.32.0.1/", "http://172.15.255.255/", "http://100.63.255.255/", "http://100.128.0.1/", "http://192.169.0.1/", "http://11.0.0.1/",
      "http://[2606:2800:220:1:248:1893:25c8:1946]/", "http://[2001:4860:4860::8888]/", "http://[::ffff:8.8.8.8]/", "http://[2002:808:808::1]/", "https://localhost.example.org/", "https://local.example.org/", "https://notlocalhost.com/", "https://internal.example.com/",
    ]) {
      expect(urlProblem(fine), fine).toBeUndefined();
    }
    expect(hostProblem("example.org")).toBeUndefined();
    expect(addressProblem("8.8.8.8")).toBeUndefined();
    expect(addressProblem("not-an-address")).toContain("not an address that can be checked");
    expect(addressProblem("fe80::1%eth0")).toContain("not an address that can be checked");
  });

  test("a name that resolves to anything private is refused, and a name with one private address among public ones too; nothing is fetched", async () => {
    for (const answers of [["127.0.0.1"], ["10.1.2.3"], ["169.254.169.254"], ["::1"], ["fd00::1"], ["::ffff:192.168.0.1"], [PUBLIC, "192.168.1.5"], ["2606:2800::1", "100.64.0.9"], []]) {
      const asked: string[] = [];
      const fetcher: Fetcher = async (url) => {
        asked.push(url);
        return new Response("secret");
      };
      await expect(convertUrlWith("https://rebind.example.org/", fetcher, tmpdir(), fake, async () => answers)).rejects.toThrow("only public web pages are fetched");
      expect(asked, JSON.stringify(answers)).toEqual([]);
    }
    await expect(
      convertUrlWith("https://nowhere.example.org/", page(), tmpdir(), fake, async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow("could not be looked up (ENOTFOUND)");
  });

  test("a real server on this machine is never asked: not by number, not by name, not by a name that resolves to it", async () => {
    let hits = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (hits += 1, new Response("<p>secret internal page</p>", { headers: { "content-type": "text/html" } })) });
    try {
      const port = server.port;
      for (const link of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://2130706433:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`]) {
        await expect(convertUrlWith(link, fetch, tmpdir(), fake, publicDns), link).rejects.toThrow("only public web pages are fetched");
      }
      // A public-looking name that points at this machine: the fetcher is told to reach it by its real address,
      // as DNS would, so only the check stands between the link and the server.
      const viaLoopback: Fetcher = (url, init) => fetch(url.replace("public-looking.test", "127.0.0.1"), init);
      await expect(convertUrlWith(`http://public-looking.test:${port}/`, viaLoopback, tmpdir(), fake, async () => ["127.0.0.1"])).rejects.toThrow("resolves to 127.0.0.1 is this machine");
      expect(hits).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("redirects are followed by hand, each hop checked before it is asked; the first private hop stops the chain", async () => {
    const targets = ["http://127.0.0.1:9/secret", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost/admin", "http://192.168.1.1/", "http://internal.example.org/", "file:///etc/passwd"];
    for (const target of targets) {
      const { fetcher, asked } = scripted({ "https://example.org/start": redirectTo(target) });
      const resolve: Resolver = async (host) => (host === "internal.example.org" ? ["10.0.0.7"] : [PUBLIC]);
      await expect(convertUrlWith("https://example.org/start", fetcher, tmpdir(), fake, resolve), target).rejects.toThrow(/redirected to .*(only public web pages are fetched|only http and https)/);
      expect(asked.map((a) => a.url), target).toEqual(["https://example.org/start"]);
    }
  });

  test("a hop that is public by number but resolves to a private address is refused too", async () => {
    const { fetcher, asked } = scripted({ "https://example.org/a": redirectTo("https://sneaky.example.net/b", 301) });
    const resolve: Resolver = async (host) => (host === "sneaky.example.net" ? ["10.9.9.9"] : [PUBLIC]);
    await expect(convertUrlWith("https://example.org/a", fetcher, tmpdir(), fake, resolve)).rejects.toThrow("redirected to https://sneaky.example.net/b, and sneaky.example.net resolves to 10.9.9.9 is a private network");
    expect(asked).toHaveLength(1);
  });

  test("a legitimate chain of redirects, relative or absolute, still lands on the page, and every request asked not to follow", async () => {
    const { fetcher, asked } = scripted({
      "http://example.org/old": redirectTo("https://example.org/new", 301),
      "https://example.org/new": redirectTo("/docs/page", 308),
      "https://example.org/docs/page": ok(),
    });
    const got = await convertUrlWith("http://example.org/old", fetcher, tmpdir(), fake, publicDns);
    expect(got.markdown).toContain("Public words here.");
    expect(got.url).toBe("https://example.org/docs/page");
    expect(asked).toEqual([
      { url: "http://example.org/old", redirect: "manual" },
      { url: "https://example.org/new", redirect: "manual" },
      { url: "https://example.org/docs/page", redirect: "manual" },
    ]);
  });

  test("a loop, a chain that is too long, a redirect to nowhere and a redirect to a non-address each end with a reason", async () => {
    const loop = scripted({ "https://example.org/x": redirectTo("https://example.org/x") });
    await expect(convertUrlWith("https://example.org/x", loop.fetcher, tmpdir(), fake, publicDns)).rejects.toThrow("redirected more than 5 times");
    expect(loop.asked).toHaveLength(6);
    const none = scripted({ "https://example.org/x": () => new Response(null, { status: 302 }) });
    await expect(convertUrlWith("https://example.org/x", none.fetcher, tmpdir(), fake, publicDns)).rejects.toThrow("did not say where to go");
    const odd = scripted({ "https://example.org/x": redirectTo("http://[") });
    await expect(convertUrlWith("https://example.org/x", odd.fetcher, tmpdir(), fake, publicDns)).rejects.toThrow("which is not a web address");
  });

  test("the browser is started with a resolver that knows only the checked host, pinned to the address that was checked", async () => {
    const shell = "<!doctype html><html><head><title>App</title></head><body><div id=root></div><script src=/a.js></script></body></html>";
    const full = `<html><body><main><h1>App</h1><p>${"Rendered words for the memory. ".repeat(6)}</p></main></body></html>`;
    const argvs: (readonly string[])[] = [];
    const chrome: Runner = async (argv) => {
      argvs.push(argv);
      return argv[0] === "google-chrome" ? { code: 0, stdout: bytes(full), stderr: "" } : { code: 127, stdout: new Uint8Array(), stderr: "" };
    };
    const rulesOf = (argv: readonly string[]) => argv.find((a) => a.startsWith("--host-resolver-rules="));
    await convertUrlWith("https://app.example.org/", page(shell), tmpdir(), chrome, async () => ["2606:2800::1", "93.184.216.35"]);
    await convertUrlWith("https://app.example.org/", page(shell), tmpdir(), chrome, async () => ["2606:2800::1"]);
    await convertUrlWith("https://93.184.216.34:8443/", page(shell), tmpdir(), chrome, publicDns);
    await convertUrlWith("https://[2606:2800:220:1::1]/", page(shell), tmpdir(), chrome, publicDns);
    expect(argvs.map(rulesOf)).toEqual([
      "--host-resolver-rules=MAP app.example.org 93.184.216.35, MAP * ~NOTFOUND",
      "--host-resolver-rules=MAP app.example.org [2606:2800::1], MAP * ~NOTFOUND",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 93.184.216.34",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 2606:2800:220:1::1",
    ]);
    // The URL it is told to open is the one that was checked, last in the list.
    expect(argvs.map((a) => a.at(-1))).toEqual(["https://app.example.org/", "https://app.example.org/", "https://93.184.216.34:8443/", "https://[2606:2800:220:1::1]/"]);
  });

  test("a host name that a rule list could not carry safely gets no browser at all", async () => {
    const shell = "<!doctype html><html><head><title>App</title></head><body><div id=root></div><script src=/a.js></script></body></html>";
    const ran: string[] = [];
    const chrome: Runner = async (argv) => {
      ran.push(argv[0]!);
      return { code: 0, stdout: bytes("<p>x</p>"), stderr: "" };
    };
    // A comma is legal in a host name and is the separator of Chrome's rules; so is `*` its wildcard.
    for (const link of ["https://a,EXCLUDE*.example.org/", "https://a*b.example.org/", "https://a_b.example.org/"]) {
      await expect(convertUrlWith(link, page(shell), tmpdir(), chrome, publicDns), link).rejects.toThrow("cannot be fenced for a browser");
    }
    expect(ran).toEqual([]);
    expect(resolverRules({ host: "a,b.test", address: PUBLIC, literal: false })).toBeUndefined();
    expect(resolverRules({ host: "ok.test", address: PUBLIC, literal: false })).toBe(`MAP ok.test ${PUBLIC}, MAP * ~NOTFOUND`);
  });
});

describe("WEB-01 — the connection goes to the address that was checked, never to a second lookup (DNS rebinding)", () => {
  // `.invalid` is reserved to never resolve (RFC 6761): a request to a name under it can only reach a server through
  // the pinned address, and the system resolver, asked the same, says it does not exist.
  const NAME = "rebind-target.invalid";
  const seen: { readonly path: string; readonly host: string | null; readonly agent: string | null; readonly encoding: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname + url.search, host: request.headers.get("host"), agent: request.headers.get("user-agent"), encoding: request.headers.get("accept-encoding") });
      const text = { "content-type": "text/plain" };
      switch (url.pathname) {
        case "/plain": return new Response("plain words", { headers: { ...text, "set-cookie": "a=1" } });
        case "/gzip": return new Response(gzipSync("gzip words"), { headers: { ...text, "content-encoding": "gzip" } });
        case "/deflate": return new Response(deflateSync("deflate words"), { headers: { ...text, "content-encoding": "deflate" } });
        case "/br": return new Response(brotliCompressSync("br words"), { headers: { ...text, "content-encoding": "br" } });
        case "/zstd": return new Response("zzz", { headers: { "content-encoding": "zstd" } });
        case "/redirect": return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/elsewhere" } });
        case "/empty": return new Response(null, { status: 204 });
        case "/gone": return new Response("gone", { status: 404, statusText: "Not Found" });
        case "/hang": await Bun.sleep(10_000); return new Response("late");
        case "/trickle": return new Response(new ReadableStream({ async start(controller) { controller.enqueue(new TextEncoder().encode("part")); await Bun.sleep(10_000); controller.close(); } }));
        default: return new Response("?", { status: 400 });
      }
    },
  });
  const at = (path: string) => `http://${NAME}:${server.port}${path}`;
  afterEach(() => void seen.splice(0));
  test("the page is served only by the server the pin names: the same name asked of the system resolver does not exist", async () => {
    await expect(fetch(at("/plain"))).rejects.toThrow();
    const res = await pinnedGet(at("/plain?q=1"), { headers: { "user-agent": "mind test" } }, ["127.0.0.1"]);
    expect([res.status, res.statusText, await res.text()]).toEqual([200, "OK", "plain words"]);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("set-cookie")).toBe("a=1");
    // The server was asked for the name in the link, not the address, with the request the caller made.
    expect(seen).toEqual([{ path: "/plain?q=1", host: `${NAME}:${server.port}`, agent: "mind test", encoding: "gzip, deflate, br" }]);
  });

  test("a name written with its final dot is asked for as the check read it", async () => {
    const res = await pinnedGet(`http://${NAME}.:${server.port}/plain`, {}, ["127.0.0.1"]);
    expect(await res.text()).toBe("plain words");
    expect(seen.map((s) => s.host)).toEqual([`${NAME}:${server.port}`]);
  });

  test("a compressed answer is unpacked as fetch would, and a coding that was not asked for is refused", async () => {
    for (const [path, words] of [["/gzip", "gzip words"], ["/deflate", "deflate words"], ["/br", "br words"]] as const) {
      const res = await pinnedGet(at(path), {}, ["127.0.0.1"]);
      expect(await res.text(), path).toBe(words);
      expect(res.headers.get("content-encoding"), path).toBeNull();
    }
    await expect(pinnedGet(at("/zstd"), {}, ["127.0.0.1"])).rejects.toThrow(`answered in "zstd", which was not asked for`);
  });

  test("a redirect is handed back, not followed; an empty answer and an error status come through as they are", async () => {
    const moved = await pinnedGet(at("/redirect"), { redirect: "manual" }, ["127.0.0.1"]);
    expect([moved.status, moved.headers.get("location")]).toEqual([302, "http://127.0.0.1:9/elsewhere"]);
    expect(seen.map((s) => s.path)).toEqual(["/redirect"]);
    const empty = await pinnedGet(at("/empty"), {}, ["127.0.0.1"]);
    expect([empty.status, await empty.text()]).toEqual([204, ""]);
    const gone = await pinnedGet(at("/gone"), {}, ["127.0.0.1"]);
    expect([gone.status, gone.statusText, gone.ok, await gone.text()]).toEqual([404, "Not Found", false, "gone"]);
  });

  test("the deadline ends a request that never answers, and a body that stops half way", async () => {
    await expect(pinnedGet(at("/hang"), { signal: AbortSignal.timeout(200) }, ["127.0.0.1"])).rejects.toThrow();
    const res = await pinnedGet(at("/trickle"), { signal: AbortSignal.timeout(300) }, ["127.0.0.1"]);
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  test("with nothing checked to connect to there is no connection at all, and a secure link is secured: a plain server cannot pass for one", async () => {
    await expect(pinnedGet(at("/plain"), {}, [])).rejects.toThrow("has no checked address to connect to");
    expect(seen).toEqual([]);
    const secure = pinnedGet(`https://${NAME}:${server.port}/plain`, {}, ["127.0.0.1"]);
    await expect(secure).rejects.toThrow();
    await secure.catch((error: Error) => expect(error.message).not.toContain("ENOTFOUND"));
    expect(seen.map((s) => s.path)).not.toContain("/plain");
  });

  test("the lookup answers with the checked addresses, in order, and only of the family asked for", () => {
    const lookup = pinnedLookup(["93.184.216.35", "2606:2800::1"]);
    const ask = (options: object) => {
      let out: unknown;
      lookup(NAME, options, (error, address, family) => (out = { error: error?.message, address, family }));
      return out;
    };
    expect(ask({ all: true })).toEqual({ error: undefined, address: [{ address: "93.184.216.35", family: 4 }, { address: "2606:2800::1", family: 6 }], family: undefined });
    expect(ask({})).toEqual({ error: undefined, address: "93.184.216.35", family: 4 });
    expect(ask({ family: 6 })).toEqual({ error: undefined, address: "2606:2800::1", family: 6 });
    expect(ask({ family: 0 })).toEqual({ error: undefined, address: "93.184.216.35", family: 4 });
    expect(ask({ all: true, family: 6 })).toEqual({ error: undefined, address: [{ address: "2606:2800::1", family: 6 }], family: undefined });
    expect(ask({ family: 4 })).toEqual({ error: undefined, address: "93.184.216.35", family: 4 });
    let none: string | undefined;
    pinnedLookup(["93.184.216.35"])(NAME, { family: 6 }, (error) => (none = error?.message));
    expect(none).toBe(`${NAME} has no checked address to connect to`);
  });

  test("convertUrl gives the fetcher every address it checked, IPv4 first, and each redirect hop its own", async () => {
    const asked: { readonly url: string; readonly addresses: readonly string[] }[] = [];
    const fetcher: Fetcher = async (url, _init, addresses) => {
      asked.push({ url, addresses });
      return url.endsWith("/start") ? new Response(null, { status: 302, headers: { location: "https://other.example.net/page" } }) : new Response("<!doctype html><title>t</title><main><p>" + "Public words here. ".repeat(10) + "</p></main>", { headers: { "content-type": "text/html" } });
    };
    const resolve: Resolver = async (host) => (host === "other.example.net" ? ["2606:2800::9"] : ["2606:2800::1", "93.184.216.35", "93.184.216.36"]);
    await convertUrlWith("https://example.org/start", fetcher, tmpdir(), fake, resolve);
    expect(asked).toEqual([
      { url: "https://example.org/start", addresses: ["93.184.216.35", "93.184.216.36", "2606:2800::1"] },
      { url: "https://other.example.net/page", addresses: ["2606:2800::9"] },
    ]);
    // A link that is an address is connected to as that address and no other.
    asked.length = 0;
    await convertUrlWith("https://93.184.216.34:8443/", fetcher, tmpdir(), fake, resolve);
    await convertUrlWith("https://[2606:2800:220:1::1]/", fetcher, tmpdir(), fake, resolve);
    expect(asked.map((a) => a.addresses)).toEqual([["93.184.216.34"], ["2606:2800:220:1::1"]]);
  });

  test("the ambient fetch is never the one that is asked: it is swapped for the pinned one, and any other fetcher is used as given", () => {
    expect(pinned(fetch)).toBe(pinnedGet);
    const own: Fetcher = async () => new Response("");
    expect(pinned(own)).toBe(own);
    // `fetch` and `globalThis.fetch`, which is what the command passes, are the one function: the swap is not missed by spelling.
    expect(pinned(globalThis.fetch)).toBe(pinnedGet);
  });

  test("given the ambient fetch, convertUrl asks the pinned fetcher instead, with what it checked, on every hop, and never asks the ambient one", async () => {
    const real = globalThis.fetch;
    let ambient = 0;
    // What the command passes is the global `fetch`; here it is a spy, so a swap that did not happen is seen and no packet leaves.
    globalThis.fetch = (async () => (ambient += 1, new Response("nope"))) as unknown as typeof fetch;
    try {
      const dialed: { readonly url: string; readonly addresses: readonly string[]; readonly redirect: RequestInit["redirect"] }[] = [];
      const instead: Fetcher = async (url, init, addresses) => {
        dialed.push({ url, addresses, redirect: init.redirect });
        return url.endsWith("/old")
          ? new Response(null, { status: 301, headers: { location: "https://example.org/new" } })
          : new Response("<!doctype html><title>t</title><main><p>" + "Public words here. ".repeat(10) + "</p></main>", { headers: { "content-type": "text/html" } });
      };
      const got = await convertUrlWith("https://example.org/old", globalThis.fetch, tmpdir(), fake, async () => [PUBLIC], instead);
      expect(got.markdown).toContain("Public words here.");
      expect(dialed).toEqual([
        { url: "https://example.org/old", addresses: [PUBLIC], redirect: "manual" },
        { url: "https://example.org/new", addresses: [PUBLIC], redirect: "manual" },
      ]);
      expect(ambient).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("the pin is checked for every address a name has: one private address among public ones still refuses the whole link", async () => {
    let asked = 0;
    const fetcher: Fetcher = async () => (asked += 1, new Response("secret"));
    await expect(convertUrlWith("https://rebind.example.org/", fetcher, tmpdir(), fake, async () => [PUBLIC, "127.0.0.1"])).rejects.toThrow("resolves to 127.0.0.1 is this machine");
    expect(asked).toBe(0);
  });

  afterAll(() => server.stop(true));
});

describe("where it goes", () => {
  test("a slug from the title, or a dated one for a Thai title", () => {
    expect(slugFor("Ports & Services — 2026!", NOW, "s")).toBe("ports-services-2026");
    expect(slugFor("Café résumé", NOW, "s")).toBe("cafe-resume");
    expect(slugFor("บันทึกการประชุม", NOW, "a.pdf")).toMatch(/^import-2026-09-26-[0-9a-f]{6}$/);
  });

  test("long text is cut at headings, else paragraphs, under the limit", () => {
    expect(splitMarkdown("short", 100)).toEqual(["short"]);
    const doc = Array.from({ length: 6 }, (_, i) => `## Part ${i}\n\n${"word ".repeat(10).trim()}`).join("\n\n");
    const parts = splitMarkdown(doc, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(120);
    expect(parts.join("\n\n")).toBe(doc);
    expect(parts.every((p) => p.startsWith("## Part"))).toBe(true);
    const flat = splitMarkdown("x".repeat(250), 100);
    expect(flat.map((p) => p.length)).toEqual([100, 100, 50]);
  });

  test("one file with front matter; a taken name gets -2; a long one becomes linked parts", async () => {
    const taken = new Set(["memory/knowledge/ports.md"]);
    const one = await planImport({ title: "Ports", markdown: "Use 30700.", via: "as written" }, "ports.md", NOW, async (p) => taken.has(p));
    expect(one).toHaveLength(1);
    expect(one[0]!.path).toBe("memory/knowledge/ports-2.md");
    expect(one[0]!.text).toBe('---\nname: "Ports"\ndescription: "Use 30700."\nsource: "ports.md"\nimported: 2026-09-26\nvia: "as written"\nmetadata:\n  type: reference\n---\n# Ports\n\nUse 30700.\n');
    const long = await planImport({ title: "Manual", markdown: `# Manual\n\n${"para\n\n".repeat(60_000)}`, via: "pdftotext" }, "m.pdf", NOW, async () => false);
    expect(long.length).toBeGreaterThan(1);
    expect(long[0]!.path).toBe("memory/knowledge/manual/part-01.md");
    expect(long[0]!.text).toContain("[part 2 →](part-02.md)");
    expect(long[1]!.text).toContain("[← part 1](part-01.md)");
    for (const p of long) expect(new TextEncoder().encode(p.text).length).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    const named = await planImport({ title: "x", markdown: "y", via: "v" }, "s", NOW, async () => false, "memory/notes/mine.md");
    expect(named[0]!.path).toBe("memory/notes/mine.md");
    await expect(planImport({ title: "x", markdown: "y", via: "v" }, "s", NOW, async () => true, "memory/notes/mine.md")).rejects.toThrow("already a memory");
    await expect(planImport({ title: "x", markdown: "  ", via: "pdftotext" }, "scan.pdf", NOW, async () => false)).rejects.toThrow("nothing readable");
  });
});
