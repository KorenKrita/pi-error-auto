import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

export const FORCED_RETRY_DIAGNOSTIC_TYPE = "pi-error-auto-original-error";
const FORCED_ERROR_MESSAGE = "network error: pi-error-auto forced retry";

function wasAlreadyForced(message: AssistantMessage): boolean {
  return (
    message.diagnostics?.some(
      (diagnostic) => diagnostic.type === FORCED_RETRY_DIAGNOSTIC_TYPE,
    ) ?? false
  );
}

/**
 * Reclassify an otherwise non-retryable assistant/API error so Pi's native
 * retry loop handles it. Context overflow remains on Pi's compaction path.
 */
export function forceNativeRetry(
  message: AssistantMessage,
  contextWindow = 0,
): AssistantMessage | undefined {
  if (message.stopReason !== "error" || !message.errorMessage) return;
  if (wasAlreadyForced(message)) return;
  if (isContextOverflow(message, contextWindow)) return;
  if (isRetryableAssistantError(message)) return;

  const originalError = message.errorMessage;

  return {
    ...message,
    content: [
      ...message.content,
      {
        type: "text",
        text: `[pi-error-auto original error]\n${originalError}`,
      },
    ],
    diagnostics: [
      ...(message.diagnostics ?? []),
      {
        type: FORCED_RETRY_DIAGNOSTIC_TYPE,
        timestamp: Date.now(),
        error: { message: originalError },
        details: { forcedRetry: true },
      },
    ],
    // Keep known non-retryable keywords out of errorMessage. Pi checks those
    // before retryable markers; the exact original remains above and in diagnostics.
    errorMessage: FORCED_ERROR_MESSAGE,
  };
}
