/**
 * The header the page's key travels in: `x-mind-token`, and only that one.
 */

export const TOKEN_HEADER = "x-mind-token";

/** The key a request carries, or `null` when it carries none. */
export function requestToken(headers: Pick<Headers, "get">): string | null {
  return headers.get(TOKEN_HEADER);
}
