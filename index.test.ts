import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piErrorAutoExtension, {
  DEFAULT_CONFIG,
  getProjectConfigCandidates,
  normalizeConfig,
} from "./index.js";
import { AUTO_CONTINUE_CUSTOM_TYPE } from "./invisible-continue.js";

type Handler = (event: any, ctx: any) => any;
type Shortcut = { handler: (ctx?: any) => any };

function setupExtension() {
  const handlers: Record<string, Handler[]> = {};
  const shortcuts: Record<string, Shortcut> = {};
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand() {},
    registerShortcut(name: string, shortcut: Shortcut) {
      shortcuts[name] = shortcut;
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  };
  piErrorAutoExtension(pi as any);
  return { handlers, shortcuts, sentMessages };
}

function makeContext(cwd: string) {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { notify() {} },
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
    hasPendingMessages: () => false,
    signal: undefined,
  };
}

function makeAssistantError(errorMessage: string) {
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
    errorMessage,
    timestamp: 1,
  };
}

test("normalizes invalid configuration values at the file boundary", () => {
  assert.deepEqual(
    normalizeConfig({
      enabled: "yes",
      maxConsecutiveAutoContinues: -2,
      errorPatterns: [" ECONNRESET ", 4, ""],
    }),
    {
      ...DEFAULT_CONFIG,
      maxConsecutiveAutoContinues: 0,
      errorPatterns: ["ECONNRESET"],
    },
  );
});

test("filters every private continuation marker from provider context", () => {
  const { handlers } = setupExtension();
  const user = { role: "user", content: [{ type: "text", text: "work" }] };
  const marker = {
    role: "custom",
    customType: AUTO_CONTINUE_CUSTOM_TYPE,
    content: [],
  };

  assert.deepEqual(handlers.context[0]({ messages: [marker, user, marker] }, {}), {
    messages: [user],
  });
});

test("uses Hodor-style triggers with an invisible follow-up transport", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({ ...DEFAULT_CONFIG, notifyOnAutoContinue: false })}\n`,
      "utf8",
    );
    const { handlers, sentMessages } = setupExtension();
    const ctx = makeContext(cwd);

    await handlers.message_end[0](
      {
        message: {
          role: "assistant",
          stopReason: "length",
          content: [],
        },
      },
      ctx,
    );

    assert.deepEqual(sentMessages, [
      {
        message: {
          customType: AUTO_CONTINUE_CUSTOM_TYPE,
          content: [],
          display: false,
          details: undefined,
        },
        options: { triggerTurn: true, deliverAs: "followUp" },
      },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("continues again after its own hidden marker is followed by a silent stop", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({ ...DEFAULT_CONFIG, notifyOnAutoContinue: false })}\n`,
      "utf8",
    );
    const { handlers, sentMessages } = setupExtension();
    const ctx = makeContext(cwd);

    await handlers.message_end[0](
      {
        message: {
          role: "custom",
          customType: AUTO_CONTINUE_CUSTOM_TYPE,
          content: [],
        },
      },
      ctx,
    );
    await handlers.message_end[0](
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
      },
      ctx,
    );

    assert.equal(sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("never reads project config candidates for an untrusted project", () => {
  const cwd = "/untrusted/project";
  assert.deepEqual(
    getProjectConfigCandidates({ cwd, isProjectTrusted: () => false }),
    [],
  );
  assert.deepEqual(
    getProjectConfigCandidates({ cwd, isProjectTrusted: () => true }),
    [join(cwd, ".pi-error-auto.json"), join(cwd, ".pi", "pi-error-auto.json")],
  );
});

test("keeps the bundled config synchronized with runtime defaults", async () => {
  const bundledConfig = JSON.parse(
    await readFile(new URL("./config.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(normalizeConfig(bundledConfig), DEFAULT_CONFIG);
});

test("keeps deferred errors out of the handled error list", () => {
  const deferredPatterns = new Set(
    DEFAULT_CONFIG.deferredErrorPatterns.map((pattern) => pattern.toLowerCase()),
  );
  assert.deepEqual(
    DEFAULT_CONFIG.errorPatterns.filter((pattern) => deferredPatterns.has(pattern.toLowerCase())),
    [],
  );
});

test("stops at the configured consecutive auto-continue limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({
        ...DEFAULT_CONFIG,
        notifyOnAutoContinue: false,
        maxConsecutiveAutoContinues: 1,
      })}\n`,
      "utf8",
    );
    const { handlers, sentMessages } = setupExtension();
    const ctx = makeContext(cwd);

    await handlers.message_end[0](
      { message: { role: "assistant", stopReason: "length", content: [] } },
      ctx,
    );
    await handlers.message_end[0](
      {
        message: {
          role: "custom",
          customType: AUTO_CONTINUE_CUSTOM_TYPE,
          content: [],
        },
      },
      ctx,
    );
    await handlers.message_end[0](
      { message: { role: "assistant", stopReason: "stop", content: [] } },
      ctx,
    );

    assert.equal(sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("does not register Pi's built-in Escape shortcut", () => {
  const { shortcuts } = setupExtension();

  assert.equal(shortcuts.escape, undefined);
});

test("an aborted turn suppresses the loop until real user input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({ ...DEFAULT_CONFIG, notifyOnAutoContinue: false })}\n`,
      "utf8",
    );
    const { handlers, sentMessages } = setupExtension();
    const ctx = makeContext(cwd);

    await handlers.message_end[0](
      { message: { role: "assistant", stopReason: "length", content: [] } },
      { ...ctx, signal: AbortSignal.abort() },
    );
    await handlers.message_end[0](
      { message: { role: "assistant", stopReason: "length", content: [] } },
      ctx,
    );
    assert.equal(sentMessages.length, 0);

    handlers.input[0]({ source: "interactive" }, ctx);
    await handlers.message_end[0](
      { message: { role: "assistant", stopReason: "length", content: [] } },
      ctx,
    );
    assert.equal(sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("routes unhandled errors through native retry without queuing an invisible continuation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({
        ...DEFAULT_CONFIG,
        forceNativeRetryForUnhandledErrors: true,
        notifyOnForcedRetry: false,
      })}\n`,
      "utf8",
    );
    const { handlers, sentMessages } = setupExtension();
    const replacement = await handlers.message_end[0](
      { message: makeAssistantError("unexpected EOF") },
      makeContext(cwd),
    );

    assert.equal(
      replacement?.message.errorMessage,
      "network error: pi-error-auto forced retry",
    );
    assert.equal(sentMessages.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keeps configured invisible error continuation when forced native retry is disabled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({
        ...DEFAULT_CONFIG,
        forceNativeRetryForUnhandledErrors: false,
        notifyOnAutoContinue: false,
      })}\n`,
      "utf8",
    );
    const { handlers, sentMessages } = setupExtension();
    const replacement = await handlers.message_end[0](
      { message: makeAssistantError("read ECONNRESET") },
      makeContext(cwd),
    );

    assert.equal(replacement, undefined);
    assert.equal(sentMessages.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a user abort (ESC) that surfaces as an error is neither force-retried nor continued", async () => {
  // Real session 01a0c846… 2026-09-22 09:38: ESC mid-request produced stopReason "error"
  // "This operation was aborted", which was rewritten into a forced network-error retry.
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({ ...DEFAULT_CONFIG, notifyOnForcedRetry: false, notifyOnAutoContinue: false })}\n`,
      "utf8",
    );
    const { handlers, sentMessages } = setupExtension();
    const replacement = await handlers.message_end[0](
      { message: makeAssistantError("This operation was aborted") },
      { ...makeContext(cwd), signal: AbortSignal.abort() },
    );

    assert.equal(replacement, undefined);
    assert.equal(sentMessages.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
