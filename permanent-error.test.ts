import assert from "node:assert/strict";
import test from "node:test";
import { classifyPermanentError, JEV_MODEL_ID, JEV_PROVIDER } from "./permanent-error.js";

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
