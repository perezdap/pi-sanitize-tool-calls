# pi-sanitize-tool-calls

A [pi coding agent](https://pi.dev) extension that sanitizes malformed tool calls
out of the message history **before every LLM request**, so a transient provider
glitch can't permanently corrupt a session.

## The problem

Some providers — observed with MegaLLM / Anthropic-format endpoints under `503`
overload — can stream back a malformed tool call with an **empty `id` and empty
`name`**:

```json
{ "type": "toolCall", "id": "", "name": "", "arguments": {} }
```

pi persists that turn into the session file. From then on, **every** subsequent
request is hard-rejected by the API, on every provider that validates tool ids:

```
400 messages.N.content.0.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'
```

Switching models or providers does not help, because the corruption lives in the
session history, not the provider config. The session is effectively bricked.

## The fix

This extension hooks pi's `context` event, which fires before each LLM call on
**every** provider, and non-destructively strips:

- assistant `toolCall` items with an empty/invalid `id` or `name`
- orphaned `toolResult` messages pointing at a call that no longer exists
- assistant turns left empty after stripping

The on-disk session `.jsonl` is **never modified** — pi simply doesn't transmit
the malformed turn. This both prevents future corruption and makes an
already-poisoned session resumable.

## Install

### As a global extension (simplest)

Copy the extension into your global extensions directory:

```bash
# macOS / Linux
cp extensions/sanitize-tool-calls.ts ~/.pi/agent/extensions/

# Windows (PowerShell)
Copy-Item extensions\sanitize-tool-calls.ts "$env:USERPROFILE\.pi\agent\extensions\"
```

Restart pi. Extensions load at startup and apply to every session.

### As a pi package (git)

Add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/perezdap/pi-sanitize-tool-calls"
  ]
}
```

## How it works

```text
user prompt ─► agent loop ─► context hook (this extension) ─► provider request
                                   │
                                   └─ strips invalid toolCall / orphan toolResult
```

The `context` hook receives a deep copy of the outgoing messages and returns a
filtered array. Validity check for a tool call id is `^[a-zA-Z0-9_-]+$` with a
non-empty `name`.

## Scope / limitations

- This guards against **persisted corruption**. It does not fix the underlying
  provider `503` overload — that is server-side capacity; retry still applies.
- The malformed turn is dropped, not reconstructed. Any genuine content in that
  turn (rare — usually it's an empty text block beside the bad call) is lost,
  which is the correct outcome since the API rejects it anyway.

## License

MIT
