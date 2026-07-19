import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAutoContinueDecision, type AutoContinueConfig } from "./auto-continue.js";
import {
  isAutoContinueMarker,
  registerInvisibleContinuation,
  sendInvisibleContinue,
} from "./invisible-continue.js";

const EXTENSION_NAME = "pi-error-auto";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG_PATH = join(MODULE_DIR, "config.json");
const GLOBAL_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  EXTENSION_NAME,
  "config.json",
);

export const DEFAULT_CONFIG: AutoContinueConfig = {
  enabled: true,
  maxConsecutiveAutoContinues: 99,
  notifyOnAutoContinue: true,
  autoContinueOnLength: true,
  minRemainingTokensForLengthAutoContinue: 16_384,
  autoContinueOnThinkingOnlyStop: true,
  autoContinueOnSilentStopAfterTool: true,
  deferredErrorPatterns: [
    "overloaded",
    "provider returned error",
    "provider error",
    "rate limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "service unavailable",
    "server error",
    "internal error",
    "network error",
    "connection error",
    "connection refused",
    "other side closed",
    "fetch failed",
    "upstream connect",
    "reset before headers",
    "socket hang up",
    "ended without",
    "timed out",
    "timeout",
    "terminated",
    "retry delay",
    "WebSocket error",
  ],
  errorPatterns: [
    "上游流式响应中断",
    "error decoding response body",
    "stream disconnected before completion",
    "stream closed before",
    "stream closed unexpectedly",
    "stream interrupted",
    "stream ended unexpectedly",
    "premature close",
    "connection reset by peer",
    "connection reset",
    "read ECONNRESET",
    "ECONNRESET",
    "ETIMEDOUT",
    "unexpected end of JSON input",
    "unexpected end of input",
  ],
};

type NotifyLevel = NonNullable<Parameters<ExtensionContext["ui"]["notify"]>[1]>;
type NotifierContext = Pick<ExtensionContext, "hasUI" | "ui">;
type ConfigContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "isProjectTrusted" | "ui"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((pattern): pattern is string => typeof pattern === "string")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

export function normalizeConfig(raw: unknown): AutoContinueConfig {
  const config = isRecord(raw) ? raw : {};
  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_CONFIG.enabled,
    maxConsecutiveAutoContinues: Math.floor(
      normalizeNonNegativeNumber(
        config.maxConsecutiveAutoContinues,
        DEFAULT_CONFIG.maxConsecutiveAutoContinues,
      ),
    ),
    notifyOnAutoContinue:
      typeof config.notifyOnAutoContinue === "boolean"
        ? config.notifyOnAutoContinue
        : DEFAULT_CONFIG.notifyOnAutoContinue,
    autoContinueOnLength:
      typeof config.autoContinueOnLength === "boolean"
        ? config.autoContinueOnLength
        : DEFAULT_CONFIG.autoContinueOnLength,
    minRemainingTokensForLengthAutoContinue: normalizeNonNegativeNumber(
      config.minRemainingTokensForLengthAutoContinue,
      DEFAULT_CONFIG.minRemainingTokensForLengthAutoContinue,
    ),
    autoContinueOnThinkingOnlyStop:
      typeof config.autoContinueOnThinkingOnlyStop === "boolean"
        ? config.autoContinueOnThinkingOnlyStop
        : DEFAULT_CONFIG.autoContinueOnThinkingOnlyStop,
    autoContinueOnSilentStopAfterTool:
      typeof config.autoContinueOnSilentStopAfterTool === "boolean"
        ? config.autoContinueOnSilentStopAfterTool
        : DEFAULT_CONFIG.autoContinueOnSilentStopAfterTool,
    deferredErrorPatterns: normalizeStringList(
      config.deferredErrorPatterns,
      DEFAULT_CONFIG.deferredErrorPatterns,
    ),
    errorPatterns: normalizeStringList(config.errorPatterns, DEFAULT_CONFIG.errorPatterns),
  };
}

function safeNotify(ctx: NotifierContext, message: string, level: NotifyLevel): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function getProjectConfigCandidates(
  ctx: Pick<ConfigContext, "cwd" | "isProjectTrusted">,
): string[] {
  if (!ctx.isProjectTrusted()) return [];
  return [
    join(ctx.cwd, `.${EXTENSION_NAME}.json`),
    join(ctx.cwd, CONFIG_DIR_NAME, `${EXTENSION_NAME}.json`),
  ];
}

async function resolveConfigPath(ctx: ConfigContext): Promise<string> {
  for (const candidate of getProjectConfigCandidates(ctx)) {
    if (await pathExists(candidate)) return candidate;
  }

  if (await pathExists(GLOBAL_CONFIG_PATH)) return GLOBAL_CONFIG_PATH;
  return BUNDLED_CONFIG_PATH;
}

async function loadConfig(
  ctx: ConfigContext,
  lastConfigError: { value?: string },
): Promise<AutoContinueConfig> {
  const configPath = await resolveConfigPath(ctx);
  try {
    const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    lastConfigError.value = undefined;
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorKey = `${configPath}:${message}`;
    if (lastConfigError.value !== errorKey) {
      lastConfigError.value = errorKey;
      safeNotify(
        ctx,
        `[${EXTENSION_NAME}] Failed to read ${configPath}; using built-in defaults: ${message}`,
        "warning",
      );
    }
    return DEFAULT_CONFIG;
  }
}

export default function piErrorAutoExtension(pi: ExtensionAPI): void {
  let consecutiveAutoContinues = 0;
  let previousMessageRole: string | undefined;
  let lastMessageWasAutoContinueMarker = false;
  let autoContinueSuppressed = false;
  const lastConfigError: { value?: string } = {};

  function resetAutoContinueState(): void {
    consecutiveAutoContinues = 0;
  }

  function suppressAutoContinue(): void {
    autoContinueSuppressed = true;
    resetAutoContinueState();
  }

  registerInvisibleContinuation(pi);

  pi.registerCommand("pi-error-auto:setup", {
    description: `Copy the default ${EXTENSION_NAME} config to ${GLOBAL_CONFIG_PATH}`,
    handler: async (_args, ctx) => {
      if (await pathExists(GLOBAL_CONFIG_PATH)) {
        ctx.ui.notify(`[${EXTENSION_NAME}] Config already exists at ${GLOBAL_CONFIG_PATH}`, "warning");
        return;
      }
      try {
        await mkdir(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
        await copyFile(BUNDLED_CONFIG_PATH, GLOBAL_CONFIG_PATH);
        ctx.ui.notify(`[${EXTENSION_NAME}] Config copied to ${GLOBAL_CONFIG_PATH}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `[${EXTENSION_NAME}] Failed to create config at ${GLOBAL_CONFIG_PATH}: ${message}`,
          "error",
        );
      }
    },
  });

  pi.registerShortcut("escape", {
    description: `Stop the ${EXTENSION_NAME} automatic continuation loop`,
    handler: () => {
      suppressAutoContinue();
    },
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") autoContinueSuppressed = false;
  });

  pi.on("message_end", async (event, ctx) => {
    const messageRole = event.message.role;
    const previousRole = previousMessageRole;
    const previousMessageWasAutoContinue =
      previousRole === "custom" && lastMessageWasAutoContinueMarker;

    previousMessageRole = messageRole;
    lastMessageWasAutoContinueMarker = isAutoContinueMarker(event.message);

    if (messageRole === "user") {
      autoContinueSuppressed = false;
      resetAutoContinueState();
      return;
    }
    if (messageRole !== "assistant") return;

    if (!["error", "length", "stop"].includes(event.message.stopReason)) {
      resetAutoContinueState();
      return;
    }

    const config = await loadConfig(ctx, lastConfigError);
    if (!config.enabled) {
      resetAutoContinueState();
      return;
    }

    const decision = getAutoContinueDecision(event.message, config, {
      previousMessageRole: previousRole,
      previousMessageWasAutoContinue,
      contextUsage: ctx.getContextUsage(),
    });
    if (decision.action !== "continue") {
      resetAutoContinueState();
      return;
    }

    if (ctx.signal?.aborted) {
      suppressAutoContinue();
      return;
    }
    if (autoContinueSuppressed || ctx.hasPendingMessages()) return;

    if (consecutiveAutoContinues >= config.maxConsecutiveAutoContinues) {
      if (config.notifyOnAutoContinue) {
        safeNotify(
          ctx,
          `[${EXTENSION_NAME}] Reached the consecutive auto-continue limit (${config.maxConsecutiveAutoContinues}).`,
          "warning",
        );
      }
      return;
    }

    consecutiveAutoContinues += 1;
    if (config.notifyOnAutoContinue) {
      safeNotify(
        ctx,
        `[${EXTENSION_NAME}] ${decision.reason.notification}. Continuing invisibly (${consecutiveAutoContinues}/${config.maxConsecutiveAutoContinues}).`,
        "info",
      );
    }

    sendInvisibleContinue(pi);
  });
}
