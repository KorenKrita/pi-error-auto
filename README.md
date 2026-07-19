# pi-error-auto

`pi-error-auto` automatically resumes retryable Pi turns without sending prompt text such as `continue` to the model.

It combines two ideas:

- Hodor-style detection for interrupted streams, length stops, thinking-only stops, and silent stops.
- Invisible continuation through Pi's native `AgentSession` lifecycle.

## How it works

When an assistant turn matches a configured trigger, the extension calls `pi.sendMessage()` with a hidden, empty custom marker:

```ts
pi.sendMessage(
  {
    customType: "pi-error-auto:resume",
    content: [],
    display: false,
  },
  {
    triggerTurn: true,
    deliverAs: "followUp",
  },
);
```

A `context` hook removes every marker before provider serialization. The LLM therefore receives no new prompt text, while Pi still owns the busy state, follow-up queue, retries, compaction, abort handling, and `agent_settled` lifecycle.

Each continuation leaves one hidden custom entry in the session journal. It is bookkeeping only: it is not shown in the TUI and is filtered from every LLM request.

## Triggers

The extension can continue when:

1. `stopReason === "error"` matches `errorPatterns` and does not match `deferredErrorPatterns`.
2. `stopReason === "length"` and enough context remains.
3. `stopReason === "stop"` after thinking-only output.
4. A silent stop follows a user message.
5. A silent stop follows a tool result.
6. A silent stop follows the extension's own hidden continuation marker.

Press `Escape` to suppress the current automatic continuation loop. A later real user input enables automatic continuation again.

## Install

From the local checkout:

```bash
pi install /home/krita/Code/pi-error-auto
```

For a one-off run:

```bash
pi -e /home/krita/Code/pi-error-auto
```

Restart Pi after installation, or use `/reload` when the package is loaded from an auto-discovered location.

## Configuration

Configuration is resolved in this order:

1. `./.pi-error-auto.json` for a trusted project.
2. `./.pi/pi-error-auto.json` for a trusted project.
3. `~/.pi/agent/extensions/pi-error-auto/config.json`.
4. The bundled `config.json`.

Create the editable global config with:

```text
/pi-error-auto:setup
```

Core default configuration (pattern lists abbreviated; `config.json` is the complete bundled default):

```json
{
  "enabled": true,
  "maxConsecutiveAutoContinues": 99,
  "notifyOnAutoContinue": true,
  "autoContinueOnLength": true,
  "minRemainingTokensForLengthAutoContinue": 16384,
  "autoContinueOnThinkingOnlyStop": true,
  "autoContinueOnSilentStopAfterTool": true,
  "deferredErrorPatterns": ["WebSocket error"],
  "errorPatterns": ["ECONNRESET", "ETIMEDOUT"]
}
```

`minRemainingTokensForLengthAutoContinue` prevents a length continuation when known remaining context is at or below the threshold, allowing Pi's compaction path to take over. Set it to `0` to disable this guard.

`deferredErrorPatterns` identifies errors that Pi or another layer already retries. Set it to `[]` to disable deferral.

`errorPatterns` identifies transient errors handled by this extension. Set it to `[]` to disable error-based continuation while keeping the other triggers.

## Development

```bash
npm install
npm run check
npm test
npm run pack:check
```

## Credits

The trigger model was adapted from [`pi-hodor`](https://github.com/vurihuang/pi-hodor). The hidden continuation transport was inspired by [`pi-invisible-continue`](https://github.com/monotykamary/pi-invisible-continue). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

MIT
