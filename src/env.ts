/**
 * Reading an environment variable: `readEnv("TOKEN")` is `MIND_TOKEN`, and only that name. An empty string is a value.
 *
 * The environment is an argument, as D-021 requires of `src/`: `bin/` passes `process.env`.
 */

const NEW_PREFIX = "MIND_";

export type Env = Readonly<Record<string, string | undefined>>;

/** {@link readEnv} for a variable named by its full name (`MIND_NO_SYSTEMD`). */
export function readMind(name: string, env: Env): string | undefined {
  if (!name.startsWith(NEW_PREFIX)) throw new Error(`readMind takes a ${NEW_PREFIX}* name, got ${name}`);
  return readEnv(name.slice(NEW_PREFIX.length), env);
}

/** The value of `MIND_<suffix>`. An empty string is a value. */
export function readEnv(suffix: string, env: Env): string | undefined {
  return env[`${NEW_PREFIX}${suffix}`];
}
