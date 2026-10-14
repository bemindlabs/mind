/**
 * The page's keys in the browser's storage.
 *
 * The page keeps a few things in this browser: the key that opens it (session storage, so it dies with the tab),
 * the tab it was on, the conversation, the backend and model chosen here, and what the memory map shows. They are
 * `mind-t`, `mind-tab`, `mind-chat`, `mind-backend`, `mind-model` and `mind-map-*`.
 *
 * Plain browser JavaScript kept as a string, like `markdown.ts`, so the page stays one file; the test runs the very
 * same text against a fake storage. Every call is guarded: storage can be missing, full or blocked.
 */

/**
 * Defines `webKeep` with `get(area, key)` (the value, or `null`), `set(area, key, value)` and `remove(area, key)`.
 * `area` is `sessionStorage` or `localStorage`.
 */
export const STORAGE_JS = `
const webKeep = {
  get(area, key) { try { return area.getItem(key); } catch { return null; } },
  set(area, key, value) { try { area.setItem(key, value); } catch {} },
  remove(area, key) { try { area.removeItem(key); } catch {} },
};
`;
