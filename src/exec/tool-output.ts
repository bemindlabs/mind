/** A tool-free answer must not imitate the vendor's tool protocol. */
export const TOOL_FREE_INSTRUCTION = "This turn has no tools. You cannot use Read, Glob, Grep, Bash, or inspect the filesystem. Answer only from the supplied context. If evidence is missing, say what is missing and ask the user to attach it. Do not emit tool calls, <invoke> or <parameter> markup, or claim to have read files or run commands.";

/** Ignore fenced examples: an explanation of a protocol is still a valid answer. */
export function hasUnexecutedInvocation(text: string): boolean {
  let fence = "";
  const prose = text.split("\n").filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      return false;
    }
    return !fence;
  }).join("\n");
  return /(?:^|\n)[ \t]*<invoke\s+name=["'][^"'\n]+["']\s*>\s*<parameter\s+name=["'][^"'\n]+["']\s*>[\s\S]*?<\/parameter>\s*(?:[\s\S]*?)<\/invoke>/.test(prose);
}
