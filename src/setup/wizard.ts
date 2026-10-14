/**
 * `mind setup` — the first run, one question at a time (D-056).
 *
 * A wizard over commands that already exist, never a second way to do what
 * they do: it runs `new`, writes the soul through the same serializer `new`
 * and `soul import` use, runs `soul check`, and runs one `turn`. Everything
 * here is pure — the questions, their defaults, and what the answers become —
 * so the command that asks them stays small and a test can pose any answer.
 *
 * What setup deliberately does not do, and says so at the end:
 *
 * - **Raise the autonomy dial.** Level 1 (propose) is the default, and level 3
 *   needs a phrase typed at a terminal (D-042). A wizard that offered "let it
 *   act" as one keypress among many would be the easy path around that.
 * - **Turn on capture.** Consent is typed by the person it is about
 *   (`observe enable`), not accepted on their behalf by an installer.
 * - **Write into the CLIs' own instruction files.** `soul apply` shows a diff
 *   first; setup prints that command instead of running it with `--apply`.
 */

import { join } from "node:path";
import type { Soul } from "../soul/schema.ts";
import { isSubjectId } from "../types.ts";

/** One question: what it asks, what Enter means, and what it refuses. */
export interface Question {
  readonly key: keyof SetupAnswers;
  readonly ask: string;
  readonly hint?: string;
  readonly fallback: (so: Partial<SetupAnswers>, env: SetupEnv) => string;
  /** A sentence saying what is wrong, or `undefined` when the answer is usable. */
  readonly check?: (answer: string) => string | undefined;
}

export interface SetupAnswers {
  readonly name: string;
  readonly subject: string;
  readonly parent: string;
  readonly role: string;
  readonly does: string;
  readonly doesNot: string;
  readonly addressesUserAs: string;
}

/**
 * What the defaults are computed from. Passed in — `bin/commands/setup.ts`
 * reads the machine — so nothing under src/ does, and a test poses any home.
 */
export interface SetupEnv {
  readonly home: string;
  readonly user: string;
}

/**
 * A subject id from a login name: lower-cased, anything outside the id
 * alphabet dropped. Empty when nothing usable is left, and then the question
 * has no default and has to be answered.
 */
export function subjectFromUser(user: string): string {
  const cleaned = user.toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[_-]+/, "").slice(0, 64);
  return isSubjectId(cleaned) ? cleaned : "";
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const QUESTIONS: readonly Question[] = [
  {
    key: "name",
    ask: "What is the agent called?",
    hint: "also the name of its directory",
    fallback: () => "my-agent",
    check: (answer) => (NAME.test(answer) ? undefined : "letters, digits, '.', '_' and '-', starting with a letter or digit"),
  },
  {
    key: "subject",
    ask: "Whose agent is it? (a subject id — your data is filed under it)",
    hint: "lower-case letters, digits, '_' and '-'",
    fallback: (_, env) => subjectFromUser(env.user),
    check: (answer) => (isSubjectId(answer) ? undefined : "lower-case letters, digits, '_' and '-', up to 64, starting with a letter or digit"),
  },
  {
    key: "parent",
    ask: "Where should its repository go?",
    hint: "a directory outside any git repository",
    fallback: (_, env) => join(env.home, "agents"),
  },
  {
    key: "role",
    ask: "In one line, what is it for?",
    fallback: () => "",
    check: (answer) => (answer.trim().length >= 3 ? undefined : "one line, at least a few words"),
  },
  {
    key: "does",
    ask: "What does it take on?",
    fallback: (so) => so.role ?? "",
  },
  {
    key: "doesNot",
    ask: "What should it decline?",
    fallback: () => "anything that changes a live system without asking first",
  },
  {
    key: "addressesUserAs",
    ask: "How should it address you?",
    fallback: () => "you",
  },
];

/** `~` at the start of a path means home, as a person typing it expects. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** The answer to one question: the typed text, or the default when it was empty. */
export function resolveAnswer(question: Question, typed: string, so: Partial<SetupAnswers>, env: SetupEnv): string {
  const trimmed = typed.trim();
  const value = trimmed === "" ? question.fallback(so, env) : trimmed;
  return question.key === "parent" ? expandHome(value, env.home) : value;
}

/**
 * The template soul with the answers in it. Prohibitions and principles are
 * kept as the template wrote them: they are the floor every soul starts from,
 * and a wizard is the wrong place to take one away.
 */
export function withAnswers(soul: Soul, answers: SetupAnswers): Soul {
  return {
    ...soul,
    role: {
      ...soul.role,
      role: answers.role,
      scope: { does: answers.does, does_not: answers.doesNot },
    },
    person: { ...soul.person, addresses_user_as: answers.addressesUserAs },
  };
}

/** What setup leaves for the person to do, in the order they would do it. */
export function nextSteps(dir: string, subject: string): readonly string[] {
  const at = `${dir} --subject ${subject}`;
  return [
    `mind soul apply ${at}              # show what it would write into each AI CLI; add --apply to write`,
    `mind memory index ${at}            # recall over memory/ (full-text; vectors when Qdrant answers)`,
    `mind autonomy show ${at}           # it proposes (level 1) until you raise it`,
    `mind triggers show ${at}           # work on a schedule, always as proposals`,
    `mind egress needles --subject ${subject}  # where to list what must never leave (a name, an address); the judge reads a text only against that list`,
    `mind observe enable --subject ${subject}  # capture what you do — type it yourself; it asks your consent`,
    `mind --as ${dir} turn --prompt "…"  # talk to it`,
  ];
}

/** The model a first turn offers, and the reason in one line (B3 of the first stranger run). */
export interface ModelChoice {
  /** `""` when there is none to offer. */
  readonly model: string;
  readonly why: string;
}

/**
 * Pick the model `setup` offers on Enter.
 *
 * `MIND_OLLAMA_MODEL` first, when it is set and that model is pulled (a name with no tag matches its `:latest`);
 * otherwise the first model the daemon lists. It used to be the first one always, so a person who had set the
 * variable to the small model they meant to use was offered a 27B that was listed before it. The reason is returned
 * with the answer so the person is shown which one was chosen and why, and can type another.
 */
export function chooseModel(pulled: readonly string[], fromEnv: string | undefined): ModelChoice {
  const wanted = fromEnv?.trim() ?? "";
  if (pulled.length === 0) {
    return { model: "", why: "no model is pulled, so none is offered; pull one (`ollama pull <name>`) or type a name" };
  }
  if (wanted !== "") {
    const match = pulled.find((name) => name === wanted) ?? pulled.find((name) => name === `${wanted}:latest`);
    if (match !== undefined) return { model: match, why: "MIND_OLLAMA_MODEL is set and that model is pulled" };
    return {
      model: pulled[0]!,
      why: `the first of ${pulled.length} pulled models; MIND_OLLAMA_MODEL=${wanted} is not pulled, so it was not used`,
    };
  }
  return { model: pulled[0]!, why: `the first of ${pulled.length} pulled models; MIND_OLLAMA_MODEL is not set` };
}
