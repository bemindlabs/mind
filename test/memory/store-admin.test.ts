/**
 * The only socket the erase layer has (D-038) — and what it can put on it.
 *
 * `test/erase/no-network.test.ts` exempts this one file from "nothing in the
 * erase closure opens a socket". The exemption is only honest if the file can
 * do very little, so that is what is asserted here, on the syntax tree: two
 * methods, no request body, and a URL made of an address and a collection
 * name. Then the same functions against a stand-in server, so the behaviour is
 * checked as well as the shape.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import ts from "typescript";
import { collectionFor } from "../../src/memory/collection.ts";
import {
  collectionState,
  dropCollection,
  RAG_UNDELETABLE,
  type Fetch,
} from "../../src/memory/store-admin.ts";
import { subjectId } from "../../src/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const FILE = join(ROOT, "src", "memory", "store-admin.ts");
const SUBJECT = subjectId("example");
/** The name of the subject's collection on a store. */
const CURRENT = collectionFor(SUBJECT);

async function tree(): Promise<ts.SourceFile> {
  return ts.createSourceFile(FILE, await Bun.file(FILE).text(), ts.ScriptTarget.Latest, true);
}

describe("the shape of the chokepoint", () => {
  test("no object literal anywhere in it has a `body` property", async () => {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText() === "body" &&
        ts.isObjectLiteralExpression(node.parent) &&
        // The *response* is destructured into `{ status, body }` and returned
        // as one; a request init is the object passed to `doFetch`.
        node.parent.parent !== undefined &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression.getText() === "doFetch"
      ) {
        found.push(node.getText());
      }
      ts.forEachChild(node, visit);
    };
    visit(await tree());
    expect(found).toEqual([]);
  });

  test("every method string it names is GET or DELETE", async () => {
    const methods = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && /^(GET|POST|PUT|PATCH|DELETE)$/.test(node.text)) {
        methods.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(await tree());
    expect([...methods].sort()).toEqual(["DELETE", "GET"]);
  });

  test("the call to the network passes only a method and a deadline", async () => {
    const inits: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText() === "doFetch") {
        const init = node.arguments[1];
        if (init !== undefined && ts.isObjectLiteralExpression(init)) {
          inits.push(init.properties.map((p) => p.name?.getText() ?? "?").sort().join(","));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(await tree());
    expect(inits).toEqual(["method,signal"]);
  });

  test("no file under src/memory/ has a way to delete single points (D-035)", async () => {
    const glob = new Bun.Glob("src/memory/**/*.ts");
    const hits: string[] = [];
    for await (const rel of glob.scan(ROOT)) {
      const text = await Bun.file(join(ROOT, rel)).text();
      if (/points\/delete|points_selector|delete_points/.test(text)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
});

/** A stand-in Qdrant that records what it was asked. */
function fakeStore(collections: Map<string, number>) {
  const asked: { method: string; url: string; body: string }[] = [];
  const doFetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    asked.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
    const name = url.split("/collections/")[1] ?? "";
    if (method === "GET") {
      const points = collections.get(name);
      return points === undefined
        ? new Response(JSON.stringify({ status: { error: "not found" } }), { status: 404 })
        : new Response(JSON.stringify({ result: { points_count: points } }), { status: 200 });
    }
    if (method === "DELETE") {
      const had = collections.delete(name);
      return new Response(JSON.stringify({ result: had }), { status: 200 });
    }
    return new Response("", { status: 405 });
  };
  return { asked, doFetch };
}

describe("against a stand-in store", () => {
  const URL = "http://127.0.0.1:1";

  test("present, then dropped, then absent — and nothing but a name was sent", async () => {
    const store = fakeStore(new Map([[CURRENT, 7], ["docs", 99]]));

    expect(await collectionState(URL, SUBJECT, store.doFetch)).toEqual({ kind: "present", points: 7 });
    expect(await dropCollection(URL, SUBJECT, store.doFetch)).toEqual({ dropped: true });
    expect(await collectionState(URL, SUBJECT, store.doFetch)).toEqual({ kind: "absent" });

    expect(store.asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      `GET ${URL}/collections/${CURRENT}`,
      `DELETE ${URL}/collections/${CURRENT}`,
      `GET ${URL}/collections/${CURRENT}`,
    ]);
    expect(store.asked.every((a) => a.body === "")).toBe(true);
  });

  test("somebody else's collection is never touched (D-007)", async () => {
    const collections = new Map([[CURRENT, 1], ["docs", 99], [`${CURRENT}-two`, 5]]);
    const store = fakeStore(collections);
    await dropCollection(URL, SUBJECT, store.doFetch);
    expect(collections.get("docs")).toBe(99);
    // Another subject's collection is not this subject's.
    expect(collections.get(`${CURRENT}-two`)).toBe(5);
    expect([...collections.keys()].sort()).toEqual(["docs", `${CURRENT}-two`].sort());
  });

  test("a refusal is said", async () => {
    const collections = new Map([[CURRENT, 3]]);
    const store = fakeStore(collections);
    const refuses: Fetch = (url, init) =>
      init?.method === "DELETE" ? Promise.resolve(new Response("", { status: 403 })) : store.doFetch(url, init);
    expect(await dropCollection(URL, SUBJECT, refuses)).toEqual({ dropped: false, reason: "Qdrant answered 403" });
    expect([...collections.keys()]).toEqual([CURRENT]);
  });

  test("a store that cannot answer is `unreachable`", async () => {
    const broken: Fetch = () => Promise.resolve(new Response("", { status: 500 }));
    expect(await collectionState(URL, SUBJECT, broken)).toEqual({ kind: "unreachable", reason: "Qdrant answered 500" });
  });

  test("a collection that was never there is gone, not a failure", async () => {
    const store = fakeStore(new Map());
    expect(await dropCollection(URL, SUBJECT, store.doFetch)).toEqual({ dropped: true });
  });

  test("a store that cannot be reached is `unreachable`, never `absent`", async () => {
    const down: Fetch = async () => {
      throw new Error("connection refused");
    };
    const state = await collectionState(URL, SUBJECT, down);
    expect(state.kind).toBe("unreachable");
    expect((await dropCollection(URL, SUBJECT, down)).dropped).toBe(false);
  });

  test("a store that answers something else is `unreachable` too", async () => {
    const odd: Fetch = async () => new Response("nope", { status: 500 });
    expect((await collectionState(URL, SUBJECT, odd)).kind).toBe("unreachable");
    expect(await dropCollection(URL, SUBJECT, odd)).toEqual({ dropped: false, reason: "Qdrant answered 500" });
  });

  test("the list of what a drop does not reach names D-035", () => {
    expect(RAG_UNDELETABLE.join(" ")).toContain("D-035");
  });
});
