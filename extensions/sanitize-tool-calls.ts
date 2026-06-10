import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * sanitize-tool-calls
 *
 * Some providers (observed with MegaLLM / Anthropic-format endpoints under
 * 503 overload) can stream back a malformed tool call with an empty `id` and
 * empty `name`. pi persists that turn into the session, and from then on every
 * subsequent request is hard-rejected by the API:
 *
 *   400 messages.N.content.0.tool_use.id: String should match pattern '^[a-zA-Z0-9...]'
 *
 * The context hook runs before each LLM call and strips, non-destructively (the
 * on-disk session file is untouched):
 *   - assistant toolCall items with an empty/invalid id or name
 *   - toolResult messages whose toolCallId is empty or doesn't match a kept call
 *   - assistant messages left with no content after stripping
 *
 * The tool_call hook also blocks the same malformed calls during the current
 * streamed response, preventing visible "Tool  not found" spam.
 *
 * Provider-agnostic: it cleans the message array pi sends to ANY provider and
 * blocks invalid live tool executions before pi dispatches them.
 */

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

function isValidToolCall(c: any): boolean {
  return (
    c &&
    c.type === "toolCall" &&
    typeof c.id === "string" &&
    c.id.length > 0 &&
    VALID_ID.test(c.id) &&
    typeof c.name === "string" &&
    c.name.length > 0
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    const toolCallLike = {
      type: "toolCall",
      id: event.toolCallId,
      name: event.toolName,
    };

    if (!isValidToolCall(toolCallLike)) {
      return { block: true, reason: "Blocked malformed empty/invalid tool call" };
    }
  });

  pi.on("context", async (event, _ctx) => {
    const messages = event.messages as any[];
    let changed = false;

    // First pass: collect the set of tool call ids we are keeping.
    const keptIds = new Set<string>();
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "toolCall" && isValidToolCall(c)) keptIds.add(c.id);
        }
      }
    }

    const cleaned: any[] = [];
    for (const m of messages) {
      // Drop toolResult messages that reference an invalid/missing call.
      if (m.role === "toolResult") {
        const id = m.toolCallId;
        if (typeof id !== "string" || id.length === 0 || !keptIds.has(id)) {
          changed = true;
          continue;
        }
        cleaned.push(m);
        continue;
      }

      // Strip bad toolCall items from assistant messages.
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const filtered = m.content.filter(
          (c: any) => c.type !== "toolCall" || isValidToolCall(c),
        );
        if (filtered.length !== m.content.length) {
          changed = true;
          // Drop the whole assistant turn if nothing meaningful remains
          // (e.g. only an empty text block was left beside the bad call).
          const hasSubstance = filtered.some(
            (c: any) =>
              (c.type === "toolCall") ||
              (c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0) ||
              (c.type === "thinking"),
          );
          if (!hasSubstance) continue;
          cleaned.push({ ...m, content: filtered });
          continue;
        }
      }

      cleaned.push(m);
    }

    if (changed) return { messages: cleaned };
  });
}
