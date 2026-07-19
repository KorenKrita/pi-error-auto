import assert from "node:assert/strict";
import test from "node:test";
import { getAutoContinueDecision, type AutoContinueConfig } from "./auto-continue.js";

const config: AutoContinueConfig = {
  enabled: true,
  forceNativeRetryForUnhandledErrors: true,
  notifyOnForcedRetry: true,
  maxConsecutiveAutoContinues: 99,
  notifyOnAutoContinue: true,
  autoContinueOnLength: true,
  minRemainingTokensForLengthAutoContinue: 16_384,
  autoContinueOnThinkingOnlyStop: true,
  autoContinueOnSilentStopAfterTool: true,
  deferredErrorPatterns: ["WebSocket error"],
  errorPatterns: ["ECONNRESET"],
};

test("retries a silent stop after an invisible automatic continuation", () => {
  const decision = getAutoContinueDecision(
    { stopReason: "stop", content: [] },
    config,
    { previousMessageRole: "custom", previousMessageWasAutoContinue: true },
  );

  assert.deepEqual(decision, {
    action: "continue",
    reason: {
      kind: "silentStopAfterAutoContinue",
      notification: "Assistant stopped after an automatic continuation without visible output",
    },
  });
});

test("does not treat an unrelated custom message as an automatic continuation", () => {
  assert.deepEqual(
    getAutoContinueDecision(
      { stopReason: "stop", content: [] },
      config,
      { previousMessageRole: "custom", previousMessageWasAutoContinue: false },
    ),
    { action: "ignore" },
  );
});

test("retries a silent stop after a normal user message", () => {
  assert.equal(
    getAutoContinueDecision(
      { stopReason: "stop", content: [] },
      config,
      { previousMessageRole: "user" },
    ).action,
    "continue",
  );
});

test("retries a length stop when enough context remains", () => {
  assert.equal(
    getAutoContinueDecision(
      { stopReason: "length", content: [] },
      config,
      { contextUsage: { tokens: 100_000, contextWindow: 200_000, percent: 50 } },
    ).action,
    "continue",
  );
});

test("defers a length stop when remaining context is low", () => {
  assert.deepEqual(
    getAutoContinueDecision(
      { stopReason: "length", content: [] },
      config,
      { contextUsage: { tokens: 185_000, contextWindow: 200_000, percent: 92.5 } },
    ),
    { action: "defer", kind: "lengthContextTooFull" },
  );
});

test("leaves configured built-in retry errors to Pi", () => {
  assert.deepEqual(
    getAutoContinueDecision(
      { stopReason: "error", errorMessage: "Error: WebSocket error" },
      { ...config, errorPatterns: ["WebSocket error"] },
      {},
    ),
    { action: "ignore" },
  );
});

test("retries a configured transient error", () => {
  assert.equal(
    getAutoContinueDecision(
      { stopReason: "error", errorMessage: "read ECONNRESET" },
      config,
      {},
    ).action,
    "continue",
  );
});

test("retries a thinking-only stop", () => {
  assert.deepEqual(
    getAutoContinueDecision(
      {
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "unfinished reasoning" }],
      },
      config,
      {},
    ),
    {
      action: "continue",
      reason: {
        kind: "thinkingOnlyStop",
        notification: "Assistant stopped after emitting only thinking content",
      },
    },
  );
});

test("retries a silent stop after a tool result", () => {
  assert.deepEqual(
    getAutoContinueDecision(
      { stopReason: "stop", content: [] },
      config,
      { previousMessageRole: "toolResult" },
    ),
    {
      action: "continue",
      reason: {
        kind: "silentStopAfterTool",
        notification: "Assistant stopped after a tool result without visible output",
      },
    },
  );
});
