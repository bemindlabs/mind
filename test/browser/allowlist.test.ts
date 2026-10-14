/** D-151 — what a task's allowlist accepts, and the one form the proxy compares. */

import { describe, expect, test } from "bun:test";
import { allowEnv, MAX_ORIGINS, parseAllowlist, parseOrigin } from "../../src/browser/allowlist.ts";

function origin(input: string): string {
  const parsed = parseOrigin(input);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.origin.text;
}

function reason(input: string): string {
  const parsed = parseOrigin(input);
  if (parsed.ok) throw new Error(`accepted ${input}`);
  return parsed.reason;
}

describe("parseOrigin", () => {
  test("writes the default port out, lower-cases the host, and keeps an explicit port", () => {
    expect(origin("https://Example.COM")).toBe("https://example.com:443");
    expect(origin("http://example.com/")).toBe("http://example.com:80");
    expect(origin("http://example.com:80")).toBe("http://example.com:80");
    expect(origin("  https://shop.example.com:8443  ")).toBe("https://shop.example.com:8443");
    expect(origin("http://host.docker.internal:30790")).toBe("http://host.docker.internal:30790");
    expect(origin("http://192.0.2.10:8080")).toBe("http://192.0.2.10:8080");
    expect(origin("http://[2001:db8::1]:8080")).toBe("http://[2001:db8::1]:8080");
    // A non-ASCII name becomes the punycode the proxy sees on the wire.
    expect(origin("https://bücher.example")).toBe("https://xn--bcher-kva.example:443");
  });

  test("every field it carries", () => {
    const parsed = parseOrigin("https://example.com:8443");
    expect(parsed).toEqual({
      ok: true,
      origin: { scheme: "https", host: "example.com", port: 8443, text: "https://example.com:8443" },
    });
  });

  test("refuses what the fence could not keep — paths, queries, credentials, wildcards, other schemes", () => {
    expect(reason("")).toContain("empty");
    expect(reason("https://*.example.com")).toContain("wildcards");
    expect(reason("example.com")).toContain("starts with http");
    expect(reason("ftp://example.com")).toContain("starts with http");
    expect(reason("wss://example.com")).toContain("starts with http");
    expect(reason("https://example.com/safe/")).toContain("no path");
    expect(reason("https://example.com/?q=1")).toContain("no path");
    expect(reason("https://example.com/#top")).toContain("no path");
    expect(reason("https://example.com?")).toContain("no path");
    expect(reason("https://user:pw@example.com")).toContain("credentials");
    expect(reason("https://example.com.")).toContain("ends without a dot");
    expect(reason("http://exa_mple.com")).toContain("is not a host name");
    expect(reason("http://")).toContain("not a URL");
    expect(reason("http://example.com:0")).toContain("out of range");
  });
});

describe("parseAllowlist", () => {
  test("takes repeated flags and comma lists alike, and folds duplicates", () => {
    const parsed = parseAllowlist(["https://example.com,https://example.com:443", "http://host.docker.internal:30790"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.origins.map((entry) => entry.text)).toEqual([
      "https://example.com:443",
      "http://host.docker.internal:30790",
    ]);
    expect(allowEnv(parsed.origins)).toBe("https://example.com:443,http://host.docker.internal:30790");
  });

  test("reports every bad entry, not just the first", () => {
    const parsed = parseAllowlist(["https://*.example.com", "https://ok.example.com", "ftp://x"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toHaveLength(2);
  });

  test("an empty list allows nothing and says so", () => {
    for (const empty of [[], [","], [" , "]]) {
      const parsed = parseAllowlist(empty);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors.join(" ")).toContain("at least one");
    }
  });

  test(`more than ${MAX_ORIGINS} origins is more than one task`, () => {
    const many = Array.from({ length: MAX_ORIGINS + 1 }, (_, index) => `https://h${index}.example.com`);
    const parsed = parseAllowlist(many);
    expect(parsed.ok).toBe(false);
    expect(parseAllowlist(many.slice(0, MAX_ORIGINS)).ok).toBe(true);
  });
});
