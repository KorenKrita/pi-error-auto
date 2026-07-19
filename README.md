# pi-error-auto

`pi-error-auto` recovers interrupted Pi turns without sending prompt text such as `continue` to the model.

It combines three ideas:

- Forced reclassification of otherwise non-retryable errors into Pi's bounded native retry loop.
- Hodor-style detection for interrupted streams, length stops, thinking-only stops, and silent stops.
- Invisible continuation through Pi's native `AgentSession` lifecycle.

## How it works

Errors are handled first. Context overflow remains on Pi's compaction path, Pi-native retryable errors remain unchanged, and other errors are reclassified for Pi's native retry loop when `forceNativeRetryForUnhandledErrors` is enabled. The original error is preserved in message diagnostics.

If an error is not forced, or a non-error stop matches another configured trigger, the extension calls `pi.sendMessage()` with a hidden, empty custom marker:
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

The extension can recover when:

1. An assistant error is not context overflow or already retryable, and `forceNativeRetryForUnhandledErrors` is enabled. This uses Pi's native retry settings and backoff.
2. `stopReason === "error"` matches `errorPatterns`, does not match `deferredErrorPatterns`, and forced native retry is disabled or inapplicable.
3. `stopReason === "length"` and enough context remains.
4. `stopReason === "stop"` after thinking-only output.
5. A silent stop follows a user message.
6. A silent stop follows a tool result.
7. A silent stop follows the extension's own hidden continuation marker.

Press `Escape` to use Pi's built-in interrupt handling. Pi aborts the active request or retry and clears queued continuations; the extension observes the aborted signal without registering a conflicting shortcut. A later real user input enables automatic continuation again.

## Install

Install globally from GitHub:

```bash
pi install git:github.com/KorenKrita/pi-error-auto
```

The extension is enabled immediately with its bundled defaults. Start a new Pi session after installation, or run `/reload` in the current session. No setup command is required unless you want to customize the configuration.

For a one-off run:

```bash
pi -e git:github.com/KorenKrita/pi-error-auto
```

For local development:

```bash
pi install /absolute/path/to/pi-error-auto
```

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
  "forceNativeRetryForUnhandledErrors": true,
  "notifyOnForcedRetry": true,
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

`forceNativeRetryForUnhandledErrors` reclassifies any assistant error that Pi would not normally retry, except context overflow. This includes normally fatal provider errors such as authentication, quota, billing, and invalid-request failures. Attempts and backoff are controlled by Pi's `retry` settings, not `maxConsecutiveAutoContinues`.

`notifyOnForcedRetry` controls the warning shown when an error is reclassified for native retry.

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
