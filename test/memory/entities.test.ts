/** D-092 — the things memories talk about, found by their shape. */

import { describe, expect, test } from "bun:test";
import { entityQuery, extractEntities } from "../../src/memory/entities.ts";

const NOTE = `# vLLM
vLLM runs in docker, bind 127.0.0.1:10410 and 172.17.0.1:10410 — never point a service at it directly,
go through LiteLLM (port 10400). Script: ~/ai-stack/vllm/run.sh
The shim answers on :11434; set OLLAMA_HOST or MIND_OLLAMA_MODEL=qwen3.8:27b.
Units: mind-web-om.service, mind-triggers-om-bmt.timer. Public: https://docs.example.com/ and status.example.org.
Restarted at 14:22:59 on 2026-09-26; version 0.6.1; ip 10.0.0.1.
`;

describe("entities", () => {
  test("ports, services, hosts, env names and paths — each once, with its first line", () => {
    const got = extractEntities(NOTE);
    const by = (type: string) => got.filter((e) => e.type === type).map((e) => e.value);
    expect(by("port")).toEqual(["10410", "10400", "11434"]);
    expect(by("service")).toEqual(["mind-web-om.service", "mind-triggers-om-bmt.timer"]);
    expect(by("host")).toEqual(["docs.example.com", "status.example.org"]);
    expect(by("env")).toEqual(["OLLAMA_HOST", "MIND_OLLAMA_MODEL"]);
    expect(by("path")).toEqual(["~/ai-stack/vllm/run.sh"]);
    expect(got.find((e) => e.value === "10410")!.line).toBe(2);
    // Times, dates, versions and IPs are not ports or hosts.
    for (const not of ["22", "59", "26", "6", "10.0.0.1", "0.6.1"]) expect(got.map((e) => e.value)).not.toContain(not);
  });

  test("a question about a thing: port numbers in any spelling, anything else as written", () => {
    expect(entityQuery("port 10410")).toEqual({ type: "port", value: "10410" });
    expect(entityQuery(":10410")).toEqual({ type: "port", value: "10410" });
    expect(entityQuery("`10410`")).toEqual({ type: "port", value: "10410" });
    expect(entityQuery("Ollama-Web-OM.service")).toEqual({ value: "ollama-web-om.service" });
  });
});
