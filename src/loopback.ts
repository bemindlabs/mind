/**
 * Whether an address can leave this machine — the one rule every door that
 * carries the owner's data out of the Mind process is held to.
 *
 * It lives here rather than in `src/exec/local.ts`, where it was written for
 * `asLocal`, because `erase` needs it too (D-038) and the erase layer is
 * forbidden anything under `src/exec/` (`test/erase/no-network.test.ts`). A
 * pure function over a string, with no import at all: moving it cost nothing
 * that layer is guarding against.
 */

/**
 * Every IPv4 address that cannot leave the host, and the one IPv6 one.
 *
 * `127.0.0.0/8` in full rather than `127.0.0.1`: the whole block is loopback,
 * and daemons are bound to `127.0.0.2` by people who had a reason. A name is
 * never accepted, however local it looks.
 */
const LOOPBACK_V4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LOOPBACK_V6: readonly string[] = ["[::1]", "[0:0:0:0:0:0:0:1]"];

/** Why this host is not a loopback literal, or `undefined` when it is one. */
export function notLoopbackLiteral(host: string): string | undefined {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return `${JSON.stringify(host)} is not a URL Mind can read`;
  }

  const name = url.hostname;
  if (LOOPBACK_V6.includes(name)) return undefined;

  const v4 = LOOPBACK_V4.exec(name);
  if (v4 === null) {
    return (
      `${JSON.stringify(name)} is not a loopback literal. A name — "localhost" included — is ` +
      `resolved by whatever the resolver says at the moment of the call, so it cannot be ` +
      `evidence that a turn stays on this machine. Use 127.0.0.1 or [::1].`
    );
  }
  for (const octet of v4.slice(1)) {
    if (Number(octet) > 255) return `${JSON.stringify(name)} is not a valid IPv4 address`;
  }
  return undefined;
}
