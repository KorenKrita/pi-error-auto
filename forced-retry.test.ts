import assert from "node:assert/strict";
import test from "node:test";
import {
  FORCED_RETRY_DIAGNOSTIC_TYPE,
  forceNativeRetry,
} from "./forced-retry.js";

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "error",
    errorMessage: "unexpected EOF",
    timestamp: 1,
    ...overrides,
  };
}

test("forces an unrecognized assistant error through Pi's native retry path", () => {
  const result = forceNativeRetry(assistant() as any);

  assert.equal(result?.errorMessage, "network error: pi-error-auto forced retry");
  assert.deepEqual(result?.content.at(-1), {
    type: "text",
    text: "[pi-error-auto original error]\nunexpected EOF",
  });
  assert.equal(result?.diagnostics?.at(-1)?.type, FORCED_RETRY_DIAGNOSTIC_TYPE);
  assert.equal(result?.diagnostics?.at(-1)?.error?.message, "unexpected EOF");
});

test("forces normally non-retryable quota errors", () => {
  const result = forceNativeRetry(
    assistant({ errorMessage: "insufficient_quota: billing limit reached" }) as any,
  );

  assert.equal(result?.errorMessage, "network error: pi-error-auto forced retry");
});

test("leaves Pi-native retryable errors unchanged", () => {
  assert.equal(
    forceNativeRetry(assistant({ errorMessage: "503 service unavailable" }) as any),
    undefined,
  );
});

test("leaves context overflow to Pi's compaction recovery", () => {
  assert.equal(
    forceNativeRetry(assistant({ errorMessage: "prompt is too long" }) as any),
    undefined,
  );
});

test("does not force the same message twice", () => {
  const first = forceNativeRetry(assistant() as any);
  assert.ok(first);
  assert.equal(forceNativeRetry(first), undefined);
});

test("ignores aborted and successful messages", () => {
  assert.equal(forceNativeRetry(assistant({ stopReason: "aborted" }) as any), undefined);
  assert.equal(
    forceNativeRetry(assistant({ stopReason: "stop", errorMessage: undefined }) as any),
    undefined,
  );
});
