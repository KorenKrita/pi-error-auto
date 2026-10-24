import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPermanentError,
  JEV_MODEL_ID,
  JEV_PROVIDER,
  resolveApiKey,
} from "./permanent-error.js";

const ANTHROPIC_TOS_ERROR =
  "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. If you believe this was in error, please contact support.";

const options = { threshold: 0.7, timeoutMs: 3_000 };

function registryReturning(result: unknown, calls: unknown[] = []) {
  return {
    findOfType: (...args: unknown[]) => {
      calls.push(["findOfType", ...args]);
      return { id: JEV_MODEL_ID };
    },
    classify: async (...args: unknown[]) => {
      calls.push(["classify", ...args]);
      return result as any;
    },
  };
}

test("reports a high-probability ToS refusal as permanent", async () => {
  const calls: any[] = [];
  const verdict = await classifyPermanentError(
    registryReturning({ stopReason: "stop", answers: { permanent: { type: "bool", probability: 0.96 } } }, calls),
    ANTHROPIC_TOS_ERROR,
    options,
  );

  assert.deepEqual(verdict, { permanent: true, probability: 0.96 });
  assert.deepEqual(calls[0], ["findOfType", "classifier", JEV_PROVIDER, JEV_MODEL_ID]);
  const [, , context, classifyOptions] = calls[1];
  assert.deepEqual(context.state, { error: ANTHROPIC_TOS_ERROR });
  assert.equal(context.questions.permanent.type, "bool");
  assert.ok(classifyOptions.signal instanceof AbortSignal);
});

test("probability below the threshold is not permanent", async () => {
  const verdict = await classifyPermanentError(
    registryReturning({ stopReason: "stop", answers: { permanent: { type: "bool", probability: 0.69 } } }),
    "unexpected EOF",
    options,
  );
  assert.deepEqual(verdict, { permanent: false, probability: 0.69 });
});

test("truncates long error text before classification", async () => {
  const calls: any[] = [];
  await classifyPermanentError(
    registryReturning({ stopReason: "stop", answers: { permanent: { type: "bool", probability: 0 } } }, calls),
    "x".repeat(20_000),
    options,
  );
  assert.equal(calls[1][2].state.error.length, 8_000);
});

test("fails open when the registry has no classifier API or Jev is missing", async () => {
  assert.equal((await classifyPermanentError(undefined, "e", options)).permanent, false);
  assert.equal((await classifyPermanentError({}, "e", options)).permanent, false);
  const verdict = await classifyPermanentError(
    { findOfType: () => undefined, classify: async () => assert.fail("must not classify") },
    "e",
    options,
  );
  assert.deepEqual(verdict, { permanent: false, failOpenReason: "Jev not configured" });
});

test("fails open on an error result, a missing answer, or a thrown exception", async () => {
  assert.deepEqual(
    await classifyPermanentError(registryReturning({ stopReason: "error", answers: {}, errorMessage: "401" }), "e", options),
    { permanent: false, failOpenReason: "401" },
  );
  assert.equal(
    (await classifyPermanentError(registryReturning({ stopReason: "stop", answers: {} }), "e", options)).permanent,
    false,
  );
  const verdict = await classifyPermanentError(
    { findOfType: () => ({}), classify: async () => { throw new Error("boom"); } },
    "e",
    options,
  );
  assert.deepEqual(verdict, { permanent: false, failOpenReason: "boom" });
});

test("fails open on timeout and aborts the classifier request, even if it ignores the signal", async () => {
  let seenSignal: AbortSignal | undefined;
  const started = Date.now();
  const verdict = await classifyPermanentError(
    {
      findOfType: () => ({}),
      classify: (_model, _context, classifyOptions) => {
        seenSignal = classifyOptions?.signal;
        return new Promise(() => {});
      },
    },
    "e",
    { threshold: 0.7, timeoutMs: 20 },
  );
  assert.deepEqual(verdict, { permanent: false, failOpenReason: "timeout" });
  assert.equal(seenSignal?.aborted, true);
  assert.ok(Date.now() - started < 1_000);
});

const STOP_ANSWER = { stopReason: "stop", answers: { permanent: { type: "bool", probability: 0.9 } } };

test("registry path uses the configured model and passes apiKey only when set", async () => {
  const calls: any[] = [];
  await classifyPermanentError(registryReturning(STOP_ANSWER, calls), "e", {
    ...options,
    model: "jev-2",
    apiKey: "sk-test",
  });
  assert.deepEqual(calls[0], ["findOfType", "classifier", JEV_PROVIDER, "jev-2"]);
  assert.equal(calls[1][3].apiKey, "sk-test");

  const noKey: any[] = [];
  await classifyPermanentError(registryReturning(STOP_ANSWER, noKey), "e", options);
  assert.deepEqual(noKey[0], ["findOfType", "classifier", JEV_PROVIDER, JEV_MODEL_ID]);
  assert.equal("apiKey" in noKey[1][3], false);
});

test("resolveApiKey reads $VAR from the environment and treats blanks as unset", () => {
  const env = { TYPESAFE_API_KEY: "sk-env", BLANK: "  " };
  assert.equal(resolveApiKey("$TYPESAFE_API_KEY", env), "sk-env");
  assert.equal(resolveApiKey("$MISSING", env), undefined);
  assert.equal(resolveApiKey("$BLANK", env), undefined);
  assert.equal(resolveApiKey(" sk-plain ", env), "sk-plain");
  assert.equal(resolveApiKey("", env), undefined);
  assert.equal(resolveApiKey(undefined, env), undefined);
});

function providerRegistry(
  providerClassify: (...args: any[]) => Promise<unknown>,
  extra: Record<string, unknown> = {},
) {
  const providerIds: string[] = [];
  return {
    providerIds,
    registry: {
      classify: async () => assert.fail("must not use registry.classify"),
      getProvider: (id: string) => {
        providerIds.push(id);
        return { classify: providerClassify as any };
      },
      ...extra,
    },
  };
}

test("baseUrl bypasses registry.classify and calls the typesafe provider with a built model", async () => {
  const direct: any[] = [];
  const { registry, providerIds } = providerRegistry(async (model, context, callOptions) => {
    direct.push({ model, context, callOptions });
    return STOP_ANSWER;
  });
  const verdict = await classifyPermanentError(registry, "e", {
    ...options,
    model: "jev-2",
    baseUrl: "https://jev.example/v1",
    apiKey: "sk-test",
  });
  assert.deepEqual(verdict, { permanent: true, probability: 0.9 });
  assert.deepEqual(providerIds, [JEV_PROVIDER]);
  assert.equal(direct.length, 1);
  const { model, context, callOptions } = direct[0];
  assert.equal(model.id, "jev-2");
  assert.equal(model.name, "jev-2");
  assert.equal(model.baseUrl, "https://jev.example/v1");
  assert.equal(model.api, "typesafe-system-one");
  assert.equal(model.provider, JEV_PROVIDER);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(context.state, { error: "e" });
  assert.equal(context.questions.permanent.type, "bool");
  assert.equal(callOptions.apiKey, "sk-test");
  assert.ok(callOptions.signal instanceof AbortSignal);
});

test("baseUrl path uses a registry model as template but overrides id and baseUrl", async () => {
  const direct: any[] = [];
  const findCalls: unknown[][] = [];
  const { registry } = providerRegistry(
    async (model) => {
      direct.push(model);
      return STOP_ANSWER;
    },
    {
      findOfType: (...args: unknown[]) => {
        findCalls.push(args);
        return { id: "x", name: "Jev", api: "typesafe-system-one", baseUrl: "https://provider", cost: { input: 1 } };
      },
    },
  );
  await classifyPermanentError(registry, "e", { ...options, baseUrl: "https://override" });
  assert.deepEqual(findCalls[0], ["classifier", JEV_PROVIDER, JEV_MODEL_ID]);
  assert.deepEqual(direct[0], {
    id: JEV_MODEL_ID,
    name: "Jev",
    api: "typesafe-system-one",
    baseUrl: "https://override",
    cost: { input: 1 },
  });
});

test("baseUrl path fails open without a provider classify, or when lookup or the call fails", async () => {
  const base = { ...options, baseUrl: "https://override" };
  const unavailable = { permanent: false, failOpenReason: "classifier API unavailable" };
  assert.deepEqual(await classifyPermanentError(undefined, "e", base), unavailable);
  assert.deepEqual(await classifyPermanentError({}, "e", base), unavailable);
  assert.deepEqual(await classifyPermanentError({ getProvider: () => undefined }, "e", base), unavailable);
  assert.deepEqual(await classifyPermanentError({ getProvider: () => ({}) }, "e", base), unavailable);
  assert.deepEqual(
    await classifyPermanentError(
      {
        getProvider: () => {
          throw new Error("no provider");
        },
      },
      "e",
      base,
    ),
    { permanent: false, failOpenReason: "no provider" },
  );
  assert.deepEqual(
    await classifyPermanentError(
      providerRegistry(async () => STOP_ANSWER, {
        findOfType: () => {
          throw new Error("registry broke");
        },
      }).registry,
      "e",
      base,
    ),
    { permanent: false, failOpenReason: "registry broke" },
  );
  assert.deepEqual(
    await classifyPermanentError(
      providerRegistry(async () => ({ stopReason: "error", errorMessage: "401 Unauthorized" })).registry,
      "e",
      base,
    ),
    { permanent: false, failOpenReason: "401 Unauthorized" },
  );
  assert.deepEqual(
    await classifyPermanentError(
      providerRegistry(async () => {
        throw new Error("fetch failed");
      }).registry,
      "e",
      base,
    ),
    { permanent: false, failOpenReason: "fetch failed" },
  );
  assert.deepEqual(
    await classifyPermanentError(providerRegistry(() => new Promise(() => {})).registry, "e", {
      ...base,
      timeoutMs: 20,
    }),
    { permanent: false, failOpenReason: "timeout" },
  );
});
