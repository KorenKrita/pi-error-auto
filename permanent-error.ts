/**
 * Ask TypeSafe's Jev classifier whether an assistant/API error is a permanent
 * rejection (policy, auth, billing, missing model, malformed request) that
 * retrying cannot fix. Every failure mode fails open: the caller keeps retrying.
 */

export const JEV_PROVIDER = "typesafe";
export const JEV_MODEL_ID = "jev-latest";
const MAX_ERROR_CHARS = 8_000;

export const PERMANENT_ERROR_QUESTION = {
  type: "bool",
  instructions:
    "`error` is the error message an LLM API provider or proxy returned for one request. " +
    "Decide whether sending the exact same request again would fail the same way. " +
    "Permanent errors: policy, Terms of Service, or safety refusals (request blocked, flagged, or violating usage policies); " +
    "authentication or permission failures (invalid, missing, or expired API key; unauthorized; forbidden; account disabled or suspended); " +
    "billing or quota exhausted (insufficient credits or balance, insufficient_quota, payment required, spending or monthly limit reached); " +
    "model not found, not available to this account, or not supported; " +
    "a malformed or invalid request that will fail identically (invalid parameter, schema or validation error, unsupported field). " +
    "Transient errors: network failures, connection resets, timeouts, 5xx server errors, overloaded or capacity errors, " +
    "rate limits that ask to retry later, upstream proxy or gateway hiccups, interrupted streams, " +
    "a random 404 or bad gateway from a load balancer, and empty or unrecognizable errors.",
  criteria: {
    true:
      "Permanent: retrying the same request is pointless because it will be rejected again " +
      "(policy/ToS/safety refusal, authentication or permission failure, billing or quota exhausted, " +
      "model not found or unsupported, malformed request).",
    false:
      "Transient or unclear: a retry may succeed (network error, timeout, 5xx, overloaded, " +
      "rate limit with retry-after, upstream proxy hiccup, sporadic load-balancer 404, unknown error).",
  },
} as const;

/** Structural subset of Pi's ModelRegistry; older Pi versions lack these methods. */
export interface ClassifierRegistry {
  findOfType?: (type: "classifier", provider: string, modelId: string) => unknown;
  classify?: (
    model: any,
    context: {
      state: Record<string, unknown>;
      questions: Record<string, typeof PERMANENT_ERROR_QUESTION>;
    },
    options?: { signal?: AbortSignal },
  ) => Promise<{
    stopReason: string;
    answers?: Record<string, { type: string; probability?: number } | undefined>;
    errorMessage?: string;
  }>;
}

export interface PermanentErrorOptions {
  threshold: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type PermanentErrorVerdict =
  | { permanent: true; probability: number }
  | { permanent: false; probability?: number; failOpenReason?: string };

export async function classifyPermanentError(
  registry: ClassifierRegistry | undefined,
  errorText: string,
  options: PermanentErrorOptions,
): Promise<PermanentErrorVerdict> {
  if (typeof registry?.findOfType !== "function" || typeof registry.classify !== "function") {
    return { permanent: false, failOpenReason: "classifier API unavailable" };
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const jev = registry.findOfType("classifier", JEV_PROVIDER, JEV_MODEL_ID);
    if (!jev) return { permanent: false, failOpenReason: "Jev not configured" };

    // Race the timer too, in case a provider ignores the abort signal.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, options.timeoutMs);
    });
    const result = await Promise.race([
      registry.classify(
        jev,
        {
          state: { error: errorText.slice(0, MAX_ERROR_CHARS) },
          questions: { permanent: PERMANENT_ERROR_QUESTION },
        },
        { signal: controller.signal },
      ),
      timeout,
    ]);

    if (result === "timeout") return { permanent: false, failOpenReason: "timeout" };
    if (result.stopReason !== "stop") {
      return {
        permanent: false,
        failOpenReason: result.errorMessage || `stopReason ${result.stopReason}`,
      };
    }
    const answer = result.answers?.permanent;
    if (answer?.type !== "bool" || typeof answer.probability !== "number") {
      return { permanent: false, failOpenReason: "missing answer" };
    }
    return answer.probability >= options.threshold
      ? { permanent: true, probability: answer.probability }
      : { permanent: false, probability: answer.probability };
  } catch (error) {
    return {
      permanent: false,
      failOpenReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
