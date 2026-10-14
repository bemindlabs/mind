/** D-056 — the questions `mind setup` asks, and what the answers become. */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { templateSoul } from "../../src/agent/template.ts";
import {
  chooseModel,
  expandHome,
  nextSteps,
  QUESTIONS,
  resolveAnswer,
  subjectFromUser,
  withAnswers,
  type SetupAnswers,
} from "../../src/setup/wizard.ts";
import { subjectId } from "../../src/types.ts";

const ENV = { home: "/home/someone", user: "Some.One" };
const question = (key: keyof SetupAnswers) => QUESTIONS.find((q) => q.key === key)!;

describe("defaults", () => {
  test("a subject id from a login name, or none when nothing usable is left", () => {
    expect(subjectFromUser("Some.One")).toBe("someone");
    expect(subjectFromUser("bmt")).toBe("bmt");
    expect(subjectFromUser("_x")).toBe("x");
    expect(subjectFromUser("ผู้ใช้")).toBe("");
    expect(subjectFromUser("")).toBe("");
  });

  test("Enter takes the default; a typed answer wins; ~ is home", () => {
    expect(resolveAnswer(question("name"), "", {}, ENV)).toBe("my-agent");
    expect(resolveAnswer(question("subject"), "  ", {}, ENV)).toBe("someone");
    expect(resolveAnswer(question("parent"), "", {}, ENV)).toBe(join("/home/someone", "agents"));
    expect(resolveAnswer(question("parent"), "~/x", {}, ENV)).toBe("/home/someone/x");
    expect(resolveAnswer(question("does"), "", { role: "keeps notes" }, ENV)).toBe("keeps notes");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("/abs", "/h")).toBe("/abs");
  });

  test("the checks refuse what the commands behind them would refuse", () => {
    expect(question("name").check!("my agent")).toBeDefined();
    expect(question("name").check!("my-agent")).toBeUndefined();
    expect(question("subject").check!("Upper")).toBeDefined();
    expect(question("subject").check!("bmt")).toBeUndefined();
    expect(question("role").check!("")).toBeDefined();
    expect(question("role").check!("keeps the notes")).toBeUndefined();
  });
});

describe("what the answers become", () => {
  test("role, scope and address change; prohibitions and principles stay as the floor", () => {
    const soul = templateSoul(subjectId("someone"), "helper");
    const next = withAnswers(soul, {
      name: "helper",
      subject: "someone",
      parent: "/p",
      role: "answers questions about this server",
      does: "reads and explains",
      doesNot: "restarts services",
      addressesUserAs: "ที่รัก",
    });
    expect(next.role.role).toBe("answers questions about this server");
    expect(next.role.scope).toEqual({ does: "reads and explains", does_not: "restarts services" });
    expect(next.person.addresses_user_as).toBe("ที่รัก");
    expect(next.role.prohibitions).toEqual(soul.role.prohibitions);
    expect(next.person.principles).toEqual(soul.person.principles);
  });

  test("the next steps never include raising the dial or enabling capture on the person's behalf", () => {
    const steps = nextSteps("/a/helper", "someone").join("\n");
    expect(steps).not.toContain("autonomy set");
    expect(steps).toContain("observe enable --subject someone  # capture what you do — type it yourself");
    expect(steps).toContain("soul apply /a/helper --subject someone");
    const commands = nextSteps("/a/helper", "someone").map((line) => line.split("#")[0]!);
    expect(commands.some((c) => c.includes("--apply"))).toBe(false);
  });
});

describe("chooseModel (B3 of the stranger run)", () => {
  const pulled = ["qwen3.8-ctx128:27b", "gemma3:4b", "llama3.2:latest"];

  test("MIND_OLLAMA_MODEL, when it is set and pulled, is the default, and the line says why", () => {
    const chosen = chooseModel(pulled, "gemma3:4b");
    expect(chosen.model).toBe("gemma3:4b");
    expect(chosen.why).toContain("MIND_OLLAMA_MODEL");
    expect(chosen.why).toContain("pulled");
  });

  test("a name without a tag matches the :latest one", () => {
    expect(chooseModel(pulled, "llama3.2").model).toBe("llama3.2:latest");
  });

  test("set but not pulled: the first model, and the line says the variable was not used and why", () => {
    const chosen = chooseModel(pulled, "phi4:14b");
    expect(chosen.model).toBe("qwen3.8-ctx128:27b");
    expect(chosen.why).toContain("MIND_OLLAMA_MODEL=phi4:14b is not pulled");
    expect(chosen.why).toContain("first of 3");
  });

  test("not set: the first model listed; blank counts as not set", () => {
    expect(chooseModel(pulled, undefined).model).toBe("qwen3.8-ctx128:27b");
    expect(chooseModel(pulled, "  ").why).toBe("the first of 3 pulled models; MIND_OLLAMA_MODEL is not set");
  });

  test("nothing pulled: no default, and the line says what to do", () => {
    const none = chooseModel([], "gemma3:4b");
    expect(none.model).toBe("");
    expect(none.why).toContain("no model is pulled");
  });
});
