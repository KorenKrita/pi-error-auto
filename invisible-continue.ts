import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AUTO_CONTINUE_CUSTOM_TYPE = "pi-error-auto:resume";

export function isAutoContinueMarker(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; customType?: unknown };
  return candidate.role === "custom" && candidate.customType === AUTO_CONTINUE_CUSTOM_TYPE;
}

export function registerInvisibleContinuation(pi: ExtensionAPI): void {
  pi.on("context", (event) => {
    const messages = event.messages.filter((message) => !isAutoContinueMarker(message));
    if (messages.length !== event.messages.length) return { messages };
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
