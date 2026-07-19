import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export interface AutoContinueConfig {
  enabled: boolean;
  maxConsecutiveAutoContinues: number;
  notifyOnAutoContinue: boolean;
  autoContinueOnLength: boolean;
  minRemainingTokensForLengthAutoContinue: number;
  autoContinueOnThinkingOnlyStop: boolean;
  autoContinueOnSilentStopAfterTool: boolean;
  deferredErrorPatterns: string[];
  errorPatterns: string[];
}

export type AutoContinueReason = {
  kind:
    | "error"
    | "length"
    | "thinkingOnlyStop"
    | "silentStopAfterTool"
    | "silentStopAfterAutoContinue"
    | "silentStopAfterUser";
  notification: string;
};

export type AutoContinueDecision =
  | { action: "continue"; reason: AutoContinueReason }
  | { action: "defer"; kind: "lengthContextTooFull" }
  | { action: "ignore" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!isRecord(block) || block.type !== "text") return [];
      return typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n")
    .trim();
}

function matchesConfiguredError(errorText: string, patterns: string[]): boolean {
  const normalizedError = errorText.toLowerCase();
  return patterns.some((pattern) => normalizedError.includes(pattern.toLowerCase()));
}

function hasContentBlockType(content: unknown, type: string): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === type);
}

function hasVisibleAssistantOutput(content: unknown): boolean {
  return extractTextBlocks(content).length > 0 || hasContentBlockType(content, "toolCall");
}

function isThinkingOnlyStop(content: unknown): boolean {
  return hasContentBlockType(content, "thinking") && !hasVisibleAssistantOutput(content);
}

function shouldDeferLengthAutoContinue(
  config: AutoContinueConfig,
  contextUsage?: ContextUsage,
): boolean {
  if (!contextUsage || config.minRemainingTokensForLengthAutoContinue <= 0) return false;
  if (typeof contextUsage.tokens !== "number") return false;
  if (!Number.isFinite(contextUsage.tokens) || !Number.isFinite(contextUsage.contextWindow)) {
    return false;
  }

  return (
    contextUsage.contextWindow - contextUsage.tokens <=
    config.minRemainingTokensForLengthAutoContinue
  );
}

export function getAutoContinueDecision(
  message: {
    stopReason?: string;
    content?: unknown;
    errorMessage?: string;
  },
  config: AutoContinueConfig,
  context: {
    previousMessageRole?: string;
    previousMessageWasAutoContinue?: boolean;
    contextUsage?: ContextUsage;
  },
): AutoContinueDecision {
  if (message.stopReason === "error") {
    const errorText = [message.errorMessage, extractTextBlocks(message.content)]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n");
    if (!errorText || matchesConfiguredError(errorText, config.deferredErrorPatterns)) {
      return { action: "ignore" };
    }
    if (!matchesConfiguredError(errorText, config.errorPatterns)) return { action: "ignore" };
    return {
      action: "continue",
      reason: {
        kind: "error",
        notification: "Matched a configured error",
      },
    };
  }

  if (message.stopReason === "length" && config.autoContinueOnLength) {
    if (shouldDeferLengthAutoContinue(config, context.contextUsage)) {
      return { action: "defer", kind: "lengthContextTooFull" };
    }
    return {
      action: "continue",
      reason: {
        kind: "length",
        notification: 'Assistant stopped with stopReason "length"',
      },
    };
  }

  if (message.stopReason !== "stop") return { action: "ignore" };

  if (config.autoContinueOnThinkingOnlyStop && isThinkingOnlyStop(message.content)) {
    return {
      action: "continue",
      reason: {
        kind: "thinkingOnlyStop",
        notification: "Assistant stopped after emitting only thinking content",
      },
    };
  }

  if (!config.autoContinueOnSilentStopAfterTool || hasVisibleAssistantOutput(message.content)) {
    return { action: "ignore" };
  }

  if (context.previousMessageRole === "toolResult") {
    return {
      action: "continue",
      reason: {
        kind: "silentStopAfterTool",
        notification: "Assistant stopped after a tool result without visible output",
      },
    };
  }

  if (context.previousMessageWasAutoContinue) {
    return {
      action: "continue",
      reason: {
        kind: "silentStopAfterAutoContinue",
        notification: "Assistant stopped after an automatic continuation without visible output",
      },
    };
  }

  if (context.previousMessageRole === "user") {
    return {
      action: "continue",
      reason: {
        kind: "silentStopAfterUser",
        notification: "Assistant stopped after a user message without visible output",
      },
    };
  }

  return { action: "ignore" };
}
