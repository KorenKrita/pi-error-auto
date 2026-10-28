import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AUTO_CONTINUE_CUSTOM_TYPE = "pi-error-auto:resume";

export function isAutoContinueMarker(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; customType?: unknown };
  return candidate.role === "custom" && candidate.customType === AUTO_CONTINUE_CUSTOM_TYPE;
}

export function registerInvisibleContinuation(pi: ExtensionAPI): void {
  pi.on("context", (event) => {
    // Keep the same objects at the same indices. Removing a marker makes Pi fold
    // mid-conversation system messages into its leading system prompt.
    for (const message of event.messages) {
      if (isAutoContinueMarker(message) && message.role === "custom") message.content = [];
    }
  });
}

export function sendInvisibleContinue(pi: Pick<ExtensionAPI, "sendMessage">): void {
  pi.sendMessage(
    {
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
      details: undefined,
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );
}
