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

test("normalizes Jev model, base URL, and API key settings", () => {
  assert.equal(DEFAULT_CONFIG.jevModel, "jev-latest");
  assert.equal("jevBaseUrl" in DEFAULT_CONFIG, false);
  assert.equal("jevApiKey" in DEFAULT_CONFIG, false);
  assert.deepEqual(normalizeConfig({ jevModel: "  ", jevBaseUrl: "", jevApiKey: 3 }), DEFAULT_CONFIG);
  const config = normalizeConfig({
    jevModel: " jev-2 ",
    jevBaseUrl: " https://jev.example ",
    jevApiKey: "$TYPESAFE_API_KEY",
  });
  assert.equal(config.jevModel, "jev-2");
  assert.equal(config.jevBaseUrl, "https://jev.example");
  assert.equal(config.jevApiKey, "$TYPESAFE_API_KEY");
});

test("neutralizes continuation markers without changing context membership or identities", () => {
  const { handlers } = setupExtension();
  const user = { role: "user", content: [{ type: "text", text: "work" }] };
  const marker = {
    role: "custom",
    customType: AUTO_CONTINUE_CUSTOM_TYPE,
    content: [{ type: "text", text: "stale marker text" }],
  };
  const messages = [marker, user, marker];
  const original = [...messages];
  assert.equal(handlers.context[0]({ messages }, {}), undefined);
  assert.equal(messages.length, original.length);
  messages.forEach((message, i) => assert.equal(message, original[i]));
  assert.deepEqual(marker.content, []);
  assert.deepEqual(user.content, [{ type: "text", text: "work" }]);
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

const ANTHROPIC_TOS_ERROR =
  "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. If you believe this was in error, please contact support.";

function mockRegistry(classify: (...args: any[]) => Promise<unknown>) {
  const calls: any[][] = [];
  return {
    calls,
    registry: {
      findOfType: () => ({ id: "jev-latest" }),
      classify: (...args: any[]) => {
        calls.push(args);
        return classify(...args);
      },
    },
  };
}

function jevAnswer(probability: number) {
  return async () => ({ stopReason: "stop", answers: { permanent: { type: "bool", probability } } });
}

async function withJevConfig(
  overrides: Record<string, unknown>,
  run: (cwd: string) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-error-auto-test-"));
  try {
    await writeFile(
      join(cwd, ".pi-error-auto.json"),
      `${JSON.stringify({
        ...DEFAULT_CONFIG,
        notifyOnForcedRetry: false,
        notifyOnAutoContinue: false,
        ...overrides,
      })}\n`,
      "utf8",
    );
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("a permanent rejection judged by Jev keeps the original error and is not retried", async () => {
  await withJevConfig({}, async (cwd) => {
    const { handlers, sentMessages } = setupExtension();
    const { registry, calls } = mockRegistry(jevAnswer(0.97));
    const message = makeAssistantError(ANTHROPIC_TOS_ERROR);
    const result = await handlers.message_end[0](
      { message },
      { ...makeContext(cwd), modelRegistry: registry },
    );

    assert.equal(result, undefined);
    assert.equal(message.errorMessage, ANTHROPIC_TOS_ERROR);
    assert.equal(sentMessages.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].state, { error: ANTHROPIC_TOS_ERROR });
  });
});

test("a transient error judged by Jev is still force-retried", async () => {
  await withJevConfig({}, async (cwd) => {
    const { handlers } = setupExtension();
    const { registry, calls } = mockRegistry(jevAnswer(0.1));
    const result = await handlers.message_end[0](
      { message: makeAssistantError("unexpected EOF") },
      { ...makeContext(cwd), modelRegistry: registry },
    );

    assert.equal(result?.message.errorMessage, "network error: pi-error-auto forced retry");
    assert.equal(calls.length, 1);
  });
});

test("the permanent threshold is configurable", async () => {
  await withJevConfig({ permanentErrorProbabilityThreshold: 0.95 }, async (cwd) => {
    const { handlers } = setupExtension();
    const { registry } = mockRegistry(jevAnswer(0.9));
    const result = await handlers.message_end[0](
      { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
      { ...makeContext(cwd), modelRegistry: registry },
    );
    assert.equal(result?.message.errorMessage, "network error: pi-error-auto forced retry");
  });
});

test("fails open to forced retry when Jev is missing, errors, throws, or times out", async () => {
  await withJevConfig({ permanentErrorClassifierTimeoutMs: 20 }, async (cwd) => {
    const registries = [
      undefined,
      { findOfType: () => undefined, classify: async () => assert.fail("must not classify") },
      mockRegistry(async () => ({ stopReason: "error", answers: {}, errorMessage: "503" })).registry,
      mockRegistry(async () => {
        throw new Error("boom");
      }).registry,
      mockRegistry(() => new Promise(() => {})).registry,
    ];
    for (const modelRegistry of registries) {
      const { handlers } = setupExtension();
      const result = await handlers.message_end[0](
        { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
        { ...makeContext(cwd), modelRegistry },
      );
      assert.equal(result?.message.errorMessage, "network error: pi-error-auto forced retry");
    }
  });
});

test("does not call Jev when forced retry would not apply or the check is disabled", async () => {
  await withJevConfig({}, async (cwd) => {
    const { registry, calls } = mockRegistry(jevAnswer(0.99));
    const ctx = { ...makeContext(cwd), modelRegistry: registry };
    const { handlers } = setupExtension();

    // Pi-native retryable, context overflow, already forced, user abort, non-error stop.
    await handlers.message_end[0]({ message: makeAssistantError("503 service unavailable") }, ctx);
    await handlers.message_end[0]({ message: makeAssistantError("prompt is too long") }, ctx);
    const forced = await handlers.message_end[0](
      { message: makeAssistantError("unexpected EOF") },
      { ...ctx, modelRegistry: mockRegistry(jevAnswer(0)).registry },
    );
    await handlers.message_end[0]({ message: forced.message }, ctx);
    await handlers.message_end[0](
      { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
      { ...ctx, signal: AbortSignal.abort() },
    );
    await handlers.message_end[0](
      { message: { role: "assistant", stopReason: "length", content: [] } },
      ctx,
    );
    assert.equal(calls.length, 0);
  });

  await withJevConfig({ skipPermanentErrorsWithJev: false }, async (cwd) => {
    const { registry, calls } = mockRegistry(jevAnswer(0.99));
    const { handlers } = setupExtension();
    const result = await handlers.message_end[0](
      { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
      { ...makeContext(cwd), modelRegistry: registry },
    );
    assert.equal(result?.message.errorMessage, "network error: pi-error-auto forced retry");
    assert.equal(calls.length, 0);
  });

  await withJevConfig({ forceNativeRetryForUnhandledErrors: false }, async (cwd) => {
    const { registry, calls } = mockRegistry(jevAnswer(0.99));
    const { handlers } = setupExtension();
    await handlers.message_end[0](
      { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
      { ...makeContext(cwd), modelRegistry: registry },
    );
    assert.equal(calls.length, 0);
  });
});

test("passes the configured Jev model and $VAR-resolved API key to the registry", async () => {
  const previous = process.env.PI_ERROR_AUTO_TEST_JEV_KEY;
  process.env.PI_ERROR_AUTO_TEST_JEV_KEY = "sk-from-env";
  try {
    await withJevConfig(
      { jevModel: "jev-2", jevApiKey: "$PI_ERROR_AUTO_TEST_JEV_KEY" },
      async (cwd) => {
        const findCalls: unknown[][] = [];
        const { registry, calls } = mockRegistry(jevAnswer(0.97));
        const { handlers } = setupExtension();
        await handlers.message_end[0](
          { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
          {
            ...makeContext(cwd),
            modelRegistry: {
              ...registry,
              findOfType: (...args: unknown[]) => {
                findCalls.push(args);
                return { id: "jev-2" };
              },
            },
          },
        );
        assert.deepEqual(findCalls[0], ["classifier", "typesafe", "jev-2"]);
        assert.equal(calls[0][2].apiKey, "sk-from-env");
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_ERROR_AUTO_TEST_JEV_KEY;
    else process.env.PI_ERROR_AUTO_TEST_JEV_KEY = previous;
  }
});

test("with jevBaseUrl, calls the typesafe provider directly and fails open without one", async () => {
  await withJevConfig(
    { jevModel: "jev-2", jevBaseUrl: "https://jev.example", jevApiKey: "sk-plain" },
    async (cwd) => {
      const direct: any[] = [];
      const { handlers, sentMessages } = setupExtension();
      const message = makeAssistantError(ANTHROPIC_TOS_ERROR);
      const result = await handlers.message_end[0](
        { message },
        {
          ...makeContext(cwd),
          modelRegistry: {
            findOfType: () => undefined,
            classify: async () => assert.fail("must not use registry.classify"),
            getProvider: (id: string) =>
              id === "typesafe"
                ? {
                    classify: async (model: any, _context: any, options: any) => {
                      direct.push({ model, options });
                      return { stopReason: "stop", answers: { permanent: { type: "bool", probability: 0.97 } } };
                    },
                  }
                : undefined,
          },
        },
      );
      assert.equal(result, undefined);
      assert.equal(sentMessages.length, 0);
      assert.equal(direct[0].model.id, "jev-2");
      assert.equal(direct[0].model.baseUrl, "https://jev.example");
      assert.equal(direct[0].options.apiKey, "sk-plain");

      const fallback = await handlers.message_end[0](
        { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
        { ...makeContext(cwd), modelRegistry: mockRegistry(jevAnswer(0.99)).registry },
      );
      assert.equal(fallback?.message.errorMessage, "network error: pi-error-auto forced retry");
    },
  );
});

test("does not pass an apiKey to the registry when jevApiKey is unset", async () => {
  await withJevConfig({}, async (cwd) => {
    const { registry, calls } = mockRegistry(jevAnswer(0.1));
    const { handlers } = setupExtension();
    await handlers.message_end[0](
      { message: makeAssistantError(ANTHROPIC_TOS_ERROR) },
      { ...makeContext(cwd), modelRegistry: registry },
    );
    assert.equal("apiKey" in calls[0][2], false);
  });
});

test("a user abort during classification neither retries nor continues", async () => {
  await withJevConfig({}, async (cwd) => {
    const controller = new AbortController();
    const { registry } = mockRegistry(async () => {
      controller.abort();
      return { stopReason: "aborted", answers: {} };
    });
    const { handlers, sentMessages } = setupExtension();
    const result = await handlers.message_end[0](
      { message: makeAssistantError("read ECONNRESET weird") },
      { ...makeContext(cwd), modelRegistry: registry, signal: controller.signal },
    );
    assert.equal(result, undefined);
    assert.equal(sentMessages.length, 0);
  });
});
