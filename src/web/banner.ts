/**
 * What `mind web` prints about its link (D-162).
 *
 * The link carries the page's key after `#t=`, and the key is the whole of the
 * page's lock. At a terminal the person who started the page reads it and it
 * is gone; anywhere else — a systemd service, a pipe, a file — the same line is
 * kept: journald holds stdout and stderr both, and whoever can read the journal
 * (or whatever ships it somewhere) could open the page. So off a terminal the
 * link is printed without its key: with `--key-file`, the file's path is named
 * instead and no key material appears at all; without one, the key is masked to
 * its first and last four characters — enough to tell two keys apart, never
 * enough to use one.
 */

/** A key shortened for a line someone else may read: the first four and the last four, never more. */
export function maskKey(key: string): string {
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** The address without its key: everything before `#t=`. */
export function bareLink(url: string): string {
  const at = url.indexOf("#t=");
  return at < 0 ? url : url.slice(0, at);
}

/**
 * The lines that say where the page is. `terminal` is whether stdout is one (`isatty(1)`); `keyFile`, the
 * `--key-file` path when the key came from one.
 */
export function linkLines(url: string, options: { readonly terminal: boolean; readonly keyFile?: string }): { readonly link: string; readonly note?: string } {
  const at = url.indexOf("#t=");
  if (options.terminal || at < 0) return { link: url };
  const bare = url.slice(0, at);
  if (options.keyFile !== undefined && options.keyFile !== "") {
    return { link: bare, note: `the key is in ${options.keyFile} — open ${bare}#t=<that key>. Not printed here: this output is not a terminal, so it may be kept in a log.` };
  }
  return {
    link: `${bare}#t=${maskKey(url.slice(at + 3))}`,
    note: "the key is shown in full only at a terminal — this output may be kept in a log. Start it with --key-file <path> to have a key you can read from a file.",
  };
}
