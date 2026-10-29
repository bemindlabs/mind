export function firstWord(text) {
  return text.trim().match(/^\S+/)[0].toLowerCase();
}
