/**
 * Ask TypeSafe's Jev classifier whether an assistant/API error is a permanent
 * rejection (policy, auth, billing, missing model, malformed request) that
 * retrying cannot fix. Every failure mode fails open: the caller keeps retrying.
 */

export const JEV_PROVIDER = "typesafe";
export const JEV_MODEL_ID = "jev-latest";
export const JEV_API = "typesafe-system-one";
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
    "a random 404 or bad gateway from a load balancer, a proxy or account pool reporting that no credential or account is available right now " +
    "(such as auth_unavailable or all accounts cooling down), a status code with no body, and empty or unrecognizable errors.",
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

export interface ClassifyContext {
  state: Record<string, unknown>;
  questions: Record<string, typeof PERMANENT_ERROR_QUESTION>;
}

export interface ClassifyCallOptions {
  signal?: AbortSignal;
  apiKey?: string;
}

export interface ClassifyResult {
  stopReason: string;
  answers?: Record<string, { type: string; probability?: number } | undefined>;
  errorMessage?: string;
}

/** Structural subset of Pi's ModelRegistry; older Pi versions lack these methods. */
export interface ClassifierRegistry {
  findOfType?: (type: "classifier", provider: string, modelId: string) => unknown;
  classify?: (model: any, context: ClassifyContext, options?: ClassifyCallOptions) => Promise<ClassifyResult>;
  /** Provider implementation; its classify uses the passed model's baseUrl as-is. */
  getProvider?: (id: string) =>
    | {
        classify?: (
          model: any,
          context: ClassifyContext,
          options: ClassifyCallOptions,
        ) => Promise<ClassifyResult>;
      }
    | undefined;
}

export interface PermanentErrorOptions {
  threshold: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Jev model id; defaults to `jev-latest`. */
  model?: string;
  /**
   * When set, call the `typesafe` provider directly: registry.classify would
   * replace this baseUrl with the provider's configured one.
   */
  baseUrl?: string;
  /** Already resolved API key; passed to the classifier only when set. */
  apiKey?: string;
}

/**
 * Resolve a configured API key. A value starting with `$` names an environment
 * variable (e.g. `$TYPESAFE_API_KEY`); empty or unset values resolve to undefined.
 */
export function resolveApiKey(
  value: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("$")) return trimmed;
  const resolved = env[trimmed.slice(1)]?.trim();
  return resolved || undefined;
}

function buildDirectModel(template: unknown, modelId: string, baseUrl: string): Record<string, unknown> {
  const base =
    template && typeof template === "object"
      ? (template as Record<string, unknown>)
      : {
          type: "classifier",
          api: JEV_API,
          provider: JEV_PROVIDER,
          name: modelId,
          contextWindow: 32_000,
          input: ["text"],
          // pi-ai reads model.cost.* when computing usage; omitting it throws.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
  return { ...base, id: modelId, baseUrl };
}

export type PermanentErrorVerdict =
  | { permanent: true; probability: number }
  | { permanent: false; probability?: number; failOpenReason?: string };

export async function classifyPermanentError(
  registry: ClassifierRegistry | undefined,
  errorText: string,
  options: PermanentErrorOptions,
): Promise<PermanentErrorVerdict> {
  const modelId = options.model?.trim() || JEV_MODEL_ID;
  const baseUrl = options.baseUrl?.trim() || undefined;
  let provider: ReturnType<NonNullable<ClassifierRegistry["getProvider"]>>;
  try {
    provider = baseUrl ? registry?.getProvider?.(JEV_PROVIDER) : undefined;
  } catch (error) {
    return { permanent: false, failOpenReason: error instanceof Error ? error.message : String(error) };
  }
  if (
    baseUrl
      ? typeof provider?.classify !== "function"
      : typeof registry?.findOfType !== "function" || typeof registry.classify !== "function"
  ) {
    return { permanent: false, failOpenReason: "classifier API unavailable" };
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  const context: ClassifyContext = {
    state: { error: errorText.slice(0, MAX_ERROR_CHARS) },
    questions: { permanent: PERMANENT_ERROR_QUESTION },
  };
  const callOptions: ClassifyCallOptions = { signal: controller.signal };
  if (options.apiKey) callOptions.apiKey = options.apiKey;

  const run = async (): Promise<ClassifyResult | "not-configured"> => {
    if (baseUrl) {
      const template =
        typeof registry?.findOfType === "function"
          ? registry.findOfType("classifier", JEV_PROVIDER, modelId)
          : undefined;
      return provider!.classify!(buildDirectModel(template, modelId, baseUrl), context, callOptions);
    }
    const jev = registry!.findOfType!("classifier", JEV_PROVIDER, modelId);
    if (!jev) return "not-configured";
    return registry!.classify!(jev, context, callOptions);
  };

  try {
    // Race the timer too, in case a provider ignores the abort signal.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, options.timeoutMs);
    });
    const result = await Promise.race([run(), timeout]);

    if (result === "timeout") return { permanent: false, failOpenReason: "timeout" };
    if (result === "not-configured") return { permanent: false, failOpenReason: "Jev not configured" };
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
