/**
 * A model server on a loopback port that speaks just enough of two wire formats for the real claude and grok
 * CLIs to run a turn against it: Anthropic's messages API and an OpenAI-style chat completions API.
 *
 * Its one trick: the first time it is asked for a turn that offers a shell tool, it answers with a call to
 * that tool running `command`; when the tool's result comes back it records it and ends the turn. So a test
 * decides what "the model" tries to do, and reads afterwards exactly what the vendor's shell said back. Nothing
 * leaves the machine and no quota is spent.
 */

export interface FakeModel {
  readonly port: number;
  /** The text each shell tool call returned, in order. */
  readonly toolResults: () => readonly string[];
  readonly stop: () => void;
}

const SHELL_TOOLS = ["Bash", "run_terminal_command"] as const;

function sse(events: readonly (readonly [string, unknown])[]): Response {
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const START = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "local-coder",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
};

function anthropicText(text: string, stream: boolean): Response {
  if (!stream) {
    return Response.json({ ...START.message, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } });
  }
  return sse([
    ["message_start", START],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function anthropicTool(name: string, input: unknown, stream: boolean): Response {
  if (!stream) {
    return Response.json({ ...START.message, content: [{ type: "tool_use", id: "toolu_1", name, input }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 5 } });
  }
  return sse([
    ["message_start", START],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function chunk(delta: unknown, finish: string | null = null): string {
  const data = { id: "c1", object: "chat.completion.chunk", created: 1, model: "local-coder", choices: [{ index: 0, delta, finish_reason: finish }] };
  return `data: ${JSON.stringify(data)}\n\n`;
}

function chat(parts: readonly string[]): Response {
  return new Response(`${parts.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

/** Start on a free loopback port. `command` is what the model asks the vendor's shell to run. */
export function startFakeModel(command: string): FakeModel {
  const results: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        // A probe with no body.
      }
      const input = { command, description: "run it" };

      if (request.method === "POST" && url.pathname.endsWith("/messages")) {
        const stream = body["stream"] === true;
        const messages = (body["messages"] as { content?: unknown }[] | undefined) ?? [];
        const content = messages.at(-1)?.content;
        const returned = Array.isArray(content) ? content.filter((part) => (part as { type?: string }).type === "tool_result") : [];
        if (returned.length > 0) {
          for (const part of returned) {
            const inner = (part as { content?: unknown }).content;
            results.push(typeof inner === "string" ? inner : JSON.stringify(inner));
          }
          return anthropicText("all done", stream);
        }
        const tools = ((body["tools"] as { name?: string }[] | undefined) ?? []).map((tool) => tool.name);
        return tools.includes("Bash") ? anthropicTool("Bash", input, stream) : anthropicText("plain", stream);
      }

      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const messages = (body["messages"] as { role?: string; content?: unknown }[] | undefined) ?? [];
        const last = messages.at(-1);
        if (last?.role === "tool") {
          results.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
          return chat([chunk({ role: "assistant", content: "all done" }), chunk({}, "stop")]);
        }
        const names = ((body["tools"] as { function?: { name?: string } }[] | undefined) ?? []).map((tool) => tool.function?.name);
        const shell = SHELL_TOOLS.find((name) => names.includes(name));
        if (shell === undefined) return chat([chunk({ role: "assistant", content: "plain" }), chunk({}, "stop")]);
        const call = { index: 0, id: "call_1", type: "function", function: { name: shell, arguments: JSON.stringify(input) } };
        return chat([chunk({ role: "assistant", tool_calls: [call] }), chunk({}, "tool_calls")]);
      }
      return Response.json({});
    },
  });
  return { port: server.port ?? 0, toolResults: () => [...results], stop: () => void server.stop(true) };
}
