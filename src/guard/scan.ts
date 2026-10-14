/**
 * The pre-commit scan (S0.4 AC3): what is about to enter git, and what in it
 * looks like a secret.
 *
 * Three decisions shape this file, and each of them is about not lying.
 *
 * **It reads the index, not the working tree.** A commit keeps the staged
 * blob. `git add secrets.env && $EDITOR secrets.env` leaves a clean file on
 * disk and a dirty one in the index, and a scanner that read the disk would
 * pass it. {@link scanStaged} therefore takes bytes somebody else fetched with
 * `git cat-file blob :<path>` — see `staged.ts` — and stays a pure function of
 * them, so every rule can be argued with in a unit test.
 *
 * **It never prints what it found.** A blocked commit that echoes the token
 * has put it in terminal scrollback, in a CI log, and in whatever the output
 * was piped to — none of which `ledger forget` or anything else can reach
 * (D-022). So a finding carries a path, a line number, a rule id and, for the
 * rules where it identifies nothing on its own, the first four characters.
 * Rules that match a number about a person — a national id, a payment card —
 * echo nothing at all: four digits of those is four digits of somebody.
 *
 * **It says what it cannot see, on the runs that pass.** {@link SCAN_BLIND_SPOTS}
 * is printed when the scan blocks *and* when it passes, because the person who
 * reads the word "passed" is the person about to believe the commit is safe.
 * The first entry is the largest category this project will ever handle and the
 * one no regular expression can see: personal data written as prose. A name, an
 * address, a diagnosis and a salary have no prefix, no checksum and no shape.
 */

/** One file as the index holds it: repo-relative path, and the staged bytes. */
export interface StagedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** One reason a commit is being blocked. Never carries the matched text. */
export interface Finding {
  /** Repo-relative path, as git spelled it. */
  readonly path: string;
  /** 1-based line, or 0 when the rule is about the file rather than a line. */
  readonly line: number;
  /** Stable id, so a person can argue with one rule without disabling the scan. */
  readonly rule: string;
  /** What the rule believes it found, in one line. */
  readonly says: string;
  /** At most four leading characters, and only where they identify a vendor. */
  readonly fragment?: string;
}

/**
 * What this scan cannot see. Printed on every run, pass or block.
 *
 * Ordered by how much of this project each one covers, not by how interesting
 * it is. The first line is first because Mind is a tool for keeping personal
 * history, and personal history is prose.
 */
export const SCAN_BLIND_SPOTS: readonly string[] = [
  "Personal information written as prose — a name, an address, a diagnosis, a relationship, " +
    "what somebody earns, what somebody said in confidence. This is the largest category Mind " +
    "will ever hold and no rule below can see any of it. Passing this scan is not evidence that " +
    "a commit carries nothing personal; it is evidence that no rule matched.",
  "Secrets with no recognisable prefix, secrets that have been base64-encoded or otherwise " +
    "transformed, and secrets split across two lines. Every content rule here reads one line at " +
    "a time.",
  "Phone numbers and email addresses are deliberately not matched: on a corpus of real notes the " +
    "false positives would arrive in the hundreds, and a guard people switch off guards nothing.",
  "`git commit --no-verify`, any tool that writes a commit without running hooks, and a fresh " +
    "`git clone`, which does not carry `.git/hooks` with it.",
  "Everything committed before the guard was installed. This scan looks at what is staged now, " +
    "and git keeps what it was given earlier whatever happens later.",
];

/** What a rule does with the text it matched when it reports itself. */
type Echo = "prefix" | "none";

interface ContentRule {
  readonly id: string;
  readonly says: string;
  readonly pattern: RegExp;
  readonly echo: Echo;
  /** A second opinion for patterns that are only a shape — a checksum, mostly. */
  readonly confirm?: (match: string) => boolean;
}

interface PathRule {
  readonly id: string;
  readonly says: string;
  readonly matches: (path: string) => boolean;
}

/** Path segments, lower-cased, so a rule can ask about a directory by name. */
function segments(path: string): string[] {
  return path.split("/").map((part) => part.toLowerCase());
}

/**
 * Rules about where a file is, which fire whatever is inside it.
 *
 * A file called `.env` is refused even when it is empty: the name is a claim
 * about what will be in it tomorrow, and tomorrow's edit does not go past a
 * pre-commit hook if the file is already tracked and nobody restages it.
 */
const PATH_RULES: readonly PathRule[] = [
  {
    id: "personal-path",
    says:
      "a path under a `personal/` directory — data flagged personal lives outside the repository " +
      "entirely, under $XDG_DATA_HOME/mind/<subject>/personal/ (D-014, AC4)",
    matches: (path) => segments(path).slice(0, -1).includes("personal"),
  },
  {
    id: "env-file",
    says: "an environment file — these hold credentials by convention",
    matches: (path) => {
      const name = segments(path).at(-1) ?? "";
      return name === ".env" || name.startsWith(".env.");
    },
  },
  {
    id: "key-file",
    says: "a private key or certificate store, by file extension",
    matches: (path) => /\.(pem|key|p12|pfx|jks|keystore|asc|ppk)$/i.test(path),
  },
  {
    id: "ssh-key-file",
    says: "an SSH private key, by the name ssh-keygen gives one",
    matches: (path) => /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(path),
  },
  {
    id: "netrc-file",
    says: "a .netrc — the file git and curl read passwords out of",
    matches: (path) => /(^|\/)\.?netrc$/i.test(path),
  },
];

/** True when this 13-digit string passes the Thai national id checksum. */
function thaiIdChecksum(digits: string): boolean {
  if (digits.length !== 13) return false;
  let sum = 0;
  for (let index = 0; index < 12; index++) sum += Number(digits[index]) * (13 - index);
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

/**
 * True when a secret-shaped value is a stand-in for one, not the thing.
 *
 * Notes about infrastructure say where a password goes more often than they
 * hold one: `postgres://app:<pw>@…`, `mqtt://bwoc:***@…`, `{{token:NAME}}`,
 * `token: ~/.secrets/.env.telegram`. A scan that blocks those teaches people
 * to stop writing down where secrets live. Only forms no generated secret
 * takes are accepted: angle brackets, all asterisks, a template or shell
 * variable, a path from home or root.
 */
export function isPlaceholder(value: string): boolean {
  const bare = value.replace(/^[`"']+|[`"',;.)]+$/g, "");
  return (
    /^<[^<>]*>$/.test(bare) ||
    /^\*{3,}$/.test(bare) ||
    /^\$\{[^}]*\}$/.test(bare) ||
    /^\$[A-Z_][A-Z0-9_]*$/.test(bare) ||
    /^\{\{.*\}\}$/.test(bare) ||
    /^[A-Za-z0-9_.-]*\}\}/.test(bare) ||
    /^(~\/[\w.~-]+|\/[\w.~-]+\/[\w.~-]+)(\/[\w.~-]+)*\/?$/.test(bare)
  );
}

/** True when a digit string passes the Luhn check payment cards use. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Rules about content, one line at a time.
 *
 * The vendor prefixes are the cheap half and they are cheap on purpose: a rule
 * that matches `AKIA…` has almost no false positives and catches the mistake
 * people actually make, which is pasting a key into a note. The two numeric
 * rules at the end are the expensive half — a shape plus a checksum — and they
 * echo nothing, because the leading digits of somebody's national id are still
 * somebody's national id.
 */
const CONTENT_RULES: readonly ContentRule[] = [
  {
    id: "pem-private-key",
    says: "a PEM private key block",
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    echo: "none",
  },
  {
    id: "aws-access-key-id",
    says: "an AWS access key id",
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/,
    echo: "prefix",
  },
  {
    id: "github-token",
    says: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    echo: "prefix",
  },
  {
    id: "anthropic-key",
    says: "an Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/,
    echo: "prefix",
  },
  {
    id: "openai-style-key",
    says: "an API key in the `sk-…` shape several vendors use",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
    echo: "prefix",
  },
  {
    id: "google-api-key",
    says: "a Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    echo: "prefix",
  },
  {
    id: "slack-token",
    says: "a Slack token",
    pattern: /\bxox[baprse]-[0-9A-Za-z-]{10,}/,
    echo: "prefix",
  },
  {
    id: "jwt",
    says: "a JSON Web Token — which carries its claims in the clear",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    echo: "prefix",
  },
  {
    id: "url-credentials",
    says: "a username and password inside a URL",
    // The scheme is at most 32 characters (every real one is under 12; reverse-DNS ones have dots, so a boundary lets a
    // match begin inside them). Unbounded, a long run such as `a.a.a.` or `a-a-a-` was rescanned to its end from every
    // letter that follows a boundary: 80k characters took most of a second, 400k about half a minute (EEA-15).
    pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:[^\s/@]{3,}@/i,
    echo: "none",
    confirm: (match) => !isPlaceholder(match.slice(match.indexOf(":", match.indexOf("://") + 3) + 1, -1)),
  },
  {
    id: "assigned-secret",
    says: "a password, secret, token or key assigned a value",
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
    echo: "none",
    confirm: (match) => !isPlaceholder(match.replace(/^[^:=]*[:=]\s*/, "")),
  },
  {
    id: "thai-national-id",
    says: "thirteen digits that pass the Thai national id checksum",
    pattern: /\b\d{13}\b/,
    echo: "none",
    confirm: thaiIdChecksum,
  },
  {
    id: "payment-card",
    says: "a digit sequence that passes the Luhn check payment cards use",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/,
    echo: "none",
    confirm: (match) => {
      const digits = match.replace(/[^0-9]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits);
    },
  },
];

/** How many rules a passing scan is allowed to claim it ran. */
export const SCAN_RULE_COUNT: number = PATH_RULES.length + CONTENT_RULES.length + 1;

/** The first four characters, for rules whose prefix names a vendor and nothing else. */
function prefixOf(match: string): string {
  return match.slice(0, 4);
}

/** A NUL byte near the start is how every tool on this machine guesses "binary". */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let index = 0; index < limit; index++) if (bytes[index] === 0) return true;
  return false;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Every reason not to commit these files, in path then line order.
 *
 * A file can produce more than one finding, and does not stop at the first:
 * somebody fixing a blocked commit wants the whole list, and a scanner that
 * reports one thing per run teaches people to run it in a loop.
 */
export function scanStaged(files: readonly StagedFile[]): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    for (const rule of PATH_RULES) {
      if (rule.matches(file.path)) {
        findings.push({ path: file.path, line: 0, rule: rule.id, says: rule.says });
      }
    }

    // S0.3 AC3: everything git holds has to be readable without Mind. A
    // binary blob is also the one shape this scanner cannot look inside, so
    // the two reasons point the same way.
    if (looksBinary(file.bytes)) {
      findings.push({
        path: file.path,
        line: 0,
        rule: "binary-file",
        says:
          "a binary file — everything in an agent repository has to be readable by a human " +
          "without Mind installed (S0.3 AC3), and no content rule below can see inside this one",
      });
      continue;
    }

    const lines = decoder.decode(file.bytes).split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      for (const rule of CONTENT_RULES) {
        // Every match on the line, not the first: a placeholder early in a
        // line must not hide a real secret later in it.
        const every = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
        const match = [...text.matchAll(every)].find(
          (candidate) => rule.confirm === undefined || rule.confirm(candidate[0]),
        );
        if (match === undefined) continue;
        findings.push({
          path: file.path,
          line: index + 1,
          rule: rule.id,
          says: rule.says,
          ...(rule.echo === "prefix" ? { fragment: prefixOf(match[0]) } : {}),
        });
      }
    }
  }

  return findings;
}

/**
 * One line a person can act on, carrying no secret.
 *
 * The fragment is rendered as `starts "ghp_"` rather than bare, so that a
 * reader can tell the four characters are a prefix Mind chose to show and not
 * the whole of what matched.
 */
export function formatFinding(finding: Finding): string {
  const where = finding.line === 0 ? finding.path : `${finding.path}:${finding.line}`;
  const fragment = finding.fragment === undefined ? "" : ` (starts ${JSON.stringify(finding.fragment)})`;
  return `${where}  ${finding.rule}${fragment} — ${finding.says}`;
}
