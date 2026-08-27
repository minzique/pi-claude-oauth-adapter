import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type ProviderHeaders, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DOCS_MARKER =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const IDENTITY_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";
const CUSTOM_TYPE = "claude-oauth-docs-context";
const READY_STATUS_KEY = "claude-oauth-ready";
const ISSUE_STATUS_KEY = "claude-oauth-issue";
const END_MARKERS = ["\n\n# Project Context", "\n\n<available_skills>", "\nCurrent date:"] as const;
const PI_TOPIC_REGEX =
  /\b(pi|@mariozechner\/pi-|pi-mono|coding agent harness|pi sdk|pi extension|pi theme|pi skill|pi tui|pi package|prompt templates?|keybindings?|custom providers?|adding models?)\b/i;
const DEFAULT_CLAUDE_CODE_VERSION = "2.1.226";
const BILLING_SALT = "59cf53e54c78";
const DEFAULT_ENTRYPOINT = "pi";
const DEFAULT_BILLING_CCH = "00000";
const QUOTA_CHECK_MODEL = "claude-haiku-4-5";
const QUOTA_CHECK_CACHE_TTL_MS = 30_000;
const SURPASSED_THRESHOLD_CLAIMS = [
  { claimAbbrev: "5h", rateLimitType: "five_hour" },
  { claimAbbrev: "7d", rateLimitType: "seven_day" },
  { claimAbbrev: "7d_oi", rateLimitType: "seven_day_overage_included" },
  { claimAbbrev: "overage", rateLimitType: "overage" },
] as const;
const RATE_LIMIT_WARNING_CONFIG = [
  {
    rateLimitType: "five_hour",
    claimAbbrev: "5h",
    windowSeconds: 18_000,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: "seven_day",
    claimAbbrev: "7d",
    windowSeconds: 604_800,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
] as const;

type ReinjectionMode = "none" | "prepend-custom-message" | "append-custom-message" | "user-reminder";
type ReinjectionScope = "never" | "always" | "pi-only";
type DocsSource = "system" | "fallback" | "missing";
type BillingHeaderState = "unknown" | "present" | "updated" | "injected";
type AdapterPhase = "inactive" | "ready" | "active" | "warning" | "issue";
type ClaudeRateLimitType = "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" | "overage";
type ClaudeRateLimitStatus = "allowed" | "allowed_warning" | "rejected";
type ClaudeOverageStatus = "allowed" | "allowed_warning" | "rejected";

interface ActiveTurnState {
  docsSection: string;
  shouldInject: boolean;
  mode: ReinjectionMode;
  prompt: string;
  timestamp: number;
}

interface AdapterStatusState {
  phase: AdapterPhase;
  applies: boolean;
  suppressWarning: boolean;
  docsSource: DocsSource;
  billingHeader: BillingHeaderState;
  reason: string;
  statusText: string;
}

interface ClaudeRateLimitState {
  status: ClaudeRateLimitStatus;
  rateLimitType?: ClaudeRateLimitType;
  resetsAt?: number;
  utilization?: number;
  overageStatus?: ClaudeOverageStatus;
  overageResetsAt?: number;
  overageDisabledReason?: string;
  overageInUse?: boolean;
  overageUtilization?: number;
  overageSurpassedThreshold?: number;
  overagePeriodMonthlyUtilization?: number;
  overagePeriodChannelUtilization?: number;
  rateLimitGraceActive?: boolean;
  upgradePaths?: string[];
  unifiedRateLimitFallbackAvailable: boolean;
  isUsingOverage: boolean;
}

interface ClaudeFooterStatus {
  message: string;
  severity: "warning" | "error";
}

interface TextContentPart {
  type: "text";
  text: string;
}

interface ImageContentPart {
  type: "image";
  source: unknown;
}

type MessageContentPart = TextContentPart | ImageContentPart;

type CustomLikeMessage = {
  role: "custom";
  customType: string;
  content: string | MessageContentPart[];
  display: boolean;
  timestamp: number;
};

type UserLikeMessage = Extract<AgentMessage, { role: "user" }>;

type TextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
};

interface PayloadLike {
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
}

interface ResolvedDocsSection {
  extracted: { docsSection: string; strippedPrompt: string } | null;
  docsSection: string | null;
  docsSource: DocsSource;
}

let activeTurn: ActiveTurnState | null = null;
let latestCtx: ExtensionContext | null = null;
let cachedQuotaFooterStatus: { keyHash: string; value: ClaudeFooterStatus | null; checkedAt: number } | null = null;
let adapterStatus: AdapterStatusState = {
  phase: "inactive",
  applies: false,
  suppressWarning: false,
  docsSource: "missing",
  billingHeader: "unknown",
  reason: "Not using Anthropic OAuth",
  statusText: "",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPayloadLike(value: unknown): value is PayloadLike {
  return isObject(value);
}

function isTextBlock(value: unknown): value is TextBlock {
  return isObject(value) && value.type === "text" && typeof value.text === "string";
}

function isUserMessage(message: AgentMessage): message is UserLikeMessage {
  return message.role === "user";
}

function getEnvMode(): ReinjectionMode {
  const value = process.env.PI_CLAUDE_OAUTH_REINJECT_MODE;
  if (value === "none" || value === "prepend-custom-message" || value === "append-custom-message" || value === "user-reminder") {
    return value;
  }
  return "prepend-custom-message";
}

function getEnvScope(): ReinjectionScope {
  const value = process.env.PI_CLAUDE_OAUTH_REINJECT_SCOPE;
  if (value === "never" || value === "always" || value === "pi-only") {
    return value;
  }
  return "pi-only";
}

function getClaudeCodeVersion(): string {
  return process.env.PI_CLAUDE_CODE_VERSION ?? process.env.CLAUDE_CODE_VERSION ?? DEFAULT_CLAUDE_CODE_VERSION;
}

function getEntrypoint(): string {
  return process.env.PI_CLAUDE_CODE_ENTRYPOINT ?? process.env.CLAUDE_CODE_ENTRYPOINT ?? DEFAULT_ENTRYPOINT;
}

function getClaudeCodeWorkload(): string | undefined {
  const workload = process.env.PI_CLAUDE_CODE_WORKLOAD ?? process.env.CLAUDE_CODE_WORKLOAD;
  return workload?.trim() ? workload.trim() : undefined;
}

function getClaudeSubscriptionType(): string | undefined {
  const subscriptionType = process.env.PI_CLAUDE_CODE_SUBSCRIPTION_TYPE ?? process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE;
  return subscriptionType?.trim() ? subscriptionType.trim() : undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getBillingMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
}

function isFirstPartyAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  const value = baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  if (!value) return true;
  try {
    return new URL(value).host === "api.anthropic.com";
  } catch {
    return false;
  }
}

function getClaudeUserAgent(): string {
  return `claude-cli/${getClaudeCodeVersion()} (external, ${getEntrypoint()})`;
}

function buildBillingHeader(messages: unknown, entrypoint: string = getEntrypoint(), includeCch: boolean = isFirstPartyAnthropicBaseUrl(undefined)): string {
  const list = Array.isArray(messages) ? messages : [];
  // Skip the injected docs block so the sampled characters come from the first
  // real user message, matching what Claude Code itself would sample.
  const firstUserMessage = list.find(
    (message) =>
      isObject(message) &&
      message.role === "user" &&
      !getBillingMessageText(message.content).startsWith("<pi-docs-context>"),
  ) as Record<string, unknown> | undefined;
  const messageText = firstUserMessage ? getBillingMessageText(firstUserMessage.content) : "";
  const version = getClaudeCodeVersion();
  const sampledChars = [4, 7, 20].map((index) => messageText[index] ?? "0").join("");
  const versionHash = sha256Hex(`${BILLING_SALT}${sampledChars}${version}`).slice(0, 3);
  const workload = getClaudeCodeWorkload();
  const workloadSuffix = workload ? ` cc_workload=${workload};` : "";
  const cchSuffix = includeCch ? ` cch=${DEFAULT_BILLING_CCH};` : "";
  return `x-anthropic-billing-header: cc_version=${version}.${versionHash}; cc_entrypoint=${entrypoint};${cchSuffix}${workloadSuffix}`;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  if (typeof headers[name] === "string") return headers[name];
  const lowerName = name.toLowerCase();
  if (typeof headers[lowerName] === "string") return headers[lowerName];
  const matchedEntry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return matchedEntry?.[1];
}

function parseNumberHeader(headers: Record<string, string>, name: string): number | undefined {
  const value = getHeader(headers, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasUnifiedRateLimitHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase().startsWith("anthropic-ratelimit-unified-"));
}

function isClaudeRateLimitType(value: string | undefined): value is ClaudeRateLimitType {
  return value === "five_hour" || value === "seven_day" || value === "seven_day_opus" || value === "seven_day_sonnet" || value === "seven_day_overage_included" || value === "overage";
}

function isClaudeRateLimitStatus(value: string | undefined): value is ClaudeRateLimitStatus {
  return value === "allowed" || value === "allowed_warning" || value === "rejected";
}

function isClaudeOverageStatus(value: string | undefined): value is ClaudeOverageStatus {
  return value === "allowed" || value === "allowed_warning" || value === "rejected";
}

function getResetProgress(resetAt: number, windowSeconds: number): number {
  const now = Date.now() / 1000;
  const startedAt = resetAt - windowSeconds;
  return Math.max(0, Math.min(1, (now - startedAt) / windowSeconds));
}

// Warning state from this helper is always merged with `upgradePaths` and
// `unifiedRateLimitFallbackAvailable` by the caller, so we deliberately omit
// those fields here to avoid setting defaults that would be silently overridden.
type WarningRateLimitState = Omit<ClaudeRateLimitState, "upgradePaths" | "unifiedRateLimitFallbackAvailable">;

function getWarningRateLimitState(headers: Record<string, string>): WarningRateLimitState | null {
  for (const { claimAbbrev, rateLimitType } of SURPASSED_THRESHOLD_CLAIMS) {
    const surpassedThreshold = getHeader(headers, `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`);
    if (surpassedThreshold === undefined) continue;

    return {
      status: "allowed_warning",
      rateLimitType,
      resetsAt: parseNumberHeader(headers, `anthropic-ratelimit-unified-${claimAbbrev}-reset`),
      utilization: parseNumberHeader(headers, `anthropic-ratelimit-unified-${claimAbbrev}-utilization`),
      isUsingOverage: false,
    };
  }

  for (const config of RATE_LIMIT_WARNING_CONFIG) {
    const utilization = parseNumberHeader(headers, `anthropic-ratelimit-unified-${config.claimAbbrev}-utilization`);
    const resetsAt = parseNumberHeader(headers, `anthropic-ratelimit-unified-${config.claimAbbrev}-reset`);
    if (utilization === undefined || resetsAt === undefined) continue;

    const progress = getResetProgress(resetsAt, config.windowSeconds);
    const shouldWarn = config.thresholds.some((threshold) => utilization >= threshold.utilization && progress <= threshold.timePct);
    if (!shouldWarn) continue;

    return {
      status: "allowed_warning",
      rateLimitType: config.rateLimitType,
      resetsAt,
      utilization,
      isUsingOverage: false,
    };
  }

  return null;
}

function parseUpgradePaths(headers: Record<string, string>): string[] | undefined {
  const value = getHeader(headers, "anthropic-ratelimit-unified-upgrade-paths");
  if (!value) return undefined;

  const paths = value.split(",").map((path) => path.trim()).filter((path) => path.length > 0);
  return paths.length > 0 ? paths : undefined;
}

function resolveRateLimitStatus(headers: Record<string, string>, httpStatus?: number): ClaudeRateLimitStatus {
  const statusHeader = getHeader(headers, "anthropic-ratelimit-unified-status");
  if (isClaudeRateLimitStatus(statusHeader)) return statusHeader;

  const hasRepresentativeClaim = getHeader(headers, "anthropic-ratelimit-unified-representative-claim") !== undefined;
  const hasOverageStatus = getHeader(headers, "anthropic-ratelimit-unified-overage-status") !== undefined;
  // Match Claude Code's `rl_` fallback in decoded/2490.js: a 429 with rate-limit
  // representative-claim or overage headers is treated as `rejected`. We pin to
  // exactly 429 because 5xx errors don't carry these headers and we don't want
  // the rate-limit footer to fire on unrelated server failures.
  if (httpStatus === 429 && (hasRepresentativeClaim || hasOverageStatus)) return "rejected";

  return "allowed";
}

function parseClaudeRateLimitState(headers: Record<string, string>, httpStatus?: number): ClaudeRateLimitState | null {
  if (!hasUnifiedRateLimitHeaders(headers)) return null;

  const status = resolveRateLimitStatus(headers, httpStatus);
  const rateLimitTypeHeader = getHeader(headers, "anthropic-ratelimit-unified-representative-claim");
  const rateLimitType = isClaudeRateLimitType(rateLimitTypeHeader) ? rateLimitTypeHeader : undefined;
  const overageStatusHeader = getHeader(headers, "anthropic-ratelimit-unified-overage-status");
  const overageStatus = isClaudeOverageStatus(overageStatusHeader) ? overageStatusHeader : undefined;
  const overageResetsAt = parseNumberHeader(headers, "anthropic-ratelimit-unified-overage-reset");
  const overageDisabledReason = getHeader(headers, "anthropic-ratelimit-unified-overage-disabled-reason");
  const overageInUse = getHeader(headers, "anthropic-ratelimit-unified-overage-in-use") === "true";
  const overageUtilization = parseNumberHeader(headers, "anthropic-ratelimit-unified-overage-utilization");
  const overageSurpassedThreshold = parseNumberHeader(headers, "anthropic-ratelimit-unified-overage-surpassed-threshold");
  const overagePeriodMonthlyUtilization = parseNumberHeader(headers, "anthropic-ratelimit-unified-overage-period-monthly-utilization");
  const overagePeriodChannelUtilization = parseNumberHeader(headers, "anthropic-ratelimit-unified-overage-period-channel-utilization");
  const graceStatus = getHeader(headers, "anthropic-ratelimit-unified-grace-status");
  const graceFiveHourUtilization = parseNumberHeader(headers, "anthropic-ratelimit-unified-grace-5h-utilization") ?? 0;
  const graceSevenDayUtilization = parseNumberHeader(headers, "anthropic-ratelimit-unified-grace-7d-utilization") ?? 0;
  const rateLimitGraceActive = graceStatus !== undefined && Math.max(graceFiveHourUtilization, graceSevenDayUtilization) > 0;
  const upgradePaths = parseUpgradePaths(headers);
  const unifiedRateLimitFallbackAvailable = getHeader(headers, "anthropic-ratelimit-unified-fallback") === "available";

  if (status === "allowed" || status === "allowed_warning") {
    const warningState = getWarningRateLimitState(headers);
    if (warningState) {
      return {
        ...warningState,
        upgradePaths,
        unifiedRateLimitFallbackAvailable,
        overageInUse,
        overageUtilization,
        overageSurpassedThreshold,
        overagePeriodMonthlyUtilization,
        overagePeriodChannelUtilization,
        rateLimitGraceActive,
      };
    }
  }

  return {
    status,
    rateLimitType,
    resetsAt: parseNumberHeader(headers, "anthropic-ratelimit-unified-reset"),
    overageStatus,
    overageResetsAt,
    overageDisabledReason,
    overageInUse,
    overageUtilization,
    overageSurpassedThreshold,
    overagePeriodMonthlyUtilization,
    overagePeriodChannelUtilization,
    rateLimitGraceActive,
    upgradePaths,
    unifiedRateLimitFallbackAvailable,
    isUsingOverage: status === "rejected" && (overageStatus === "allowed" || overageStatus === "allowed_warning"),
  };
}

function getSystemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatResetTime(resetAt: number, includeTimeZone: boolean = false, includeTime: boolean = true): string {
  const resetDate = new Date(resetAt * 1000);
  const now = new Date();
  const minutes = resetDate.getMinutes();
  const timeZoneSuffix = includeTimeZone ? ` (${getSystemTimeZone()})` : "";

  if ((resetDate.getTime() - now.getTime()) / 3_600_000 > 24) {
    const options: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      hour: includeTime ? "numeric" : undefined,
      minute: !includeTime || minutes === 0 ? undefined : "2-digit",
      hour12: includeTime ? true : undefined,
    };
    if (resetDate.getFullYear() !== now.getFullYear()) options.year = "numeric";
    return `${resetDate.toLocaleString("en-US", options).replace(/ ([AP]M)/i, (_match, meridiem: string) => meridiem.toLowerCase())}${timeZoneSuffix}`;
  }

  return `${resetDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: minutes === 0 ? undefined : "2-digit",
    hour12: true,
  }).replace(/ ([AP]M)/i, (_match, meridiem: string) => meridiem.toLowerCase())}${timeZoneSuffix}`;
}

function getRateLimitLabel(rateLimitType: ClaudeRateLimitType | undefined): string | null {
  switch (rateLimitType) {
    case "five_hour":
      return "session limit";
    case "seven_day":
      return "weekly limit";
    case "seven_day_opus":
      return "Opus limit";
    case "seven_day_sonnet": {
      const subscriptionType = getClaudeSubscriptionType();
      return subscriptionType === "pro" || subscriptionType === "enterprise" ? "weekly limit" : "Sonnet limit";
    }
    case "seven_day_overage_included":
      return "Fable 5 limit";
    case "overage":
      return "usage credit limit";
    default:
      return null;
  }
}

function formatRejectedRateLimitMessage(state: ClaudeRateLimitState): string {
  const resetText = state.resetsAt ? formatResetTime(state.resetsAt, true) : undefined;
  const overageResetText = state.overageResetsAt ? formatResetTime(state.overageResetsAt, true) : undefined;
  const suffix = resetText ? ` · resets ${resetText}` : "";

  if (state.overageStatus === "rejected") {
    let overageSuffix = "";
    if (resetText && overageResetText && state.resetsAt && state.overageResetsAt) {
      overageSuffix = state.resetsAt < state.overageResetsAt ? ` · resets ${resetText}` : ` · resets ${overageResetText}`;
    } else if (resetText) {
      overageSuffix = ` · resets ${resetText}`;
    } else if (overageResetText) {
      overageSuffix = ` · resets ${overageResetText}`;
    }

    if (state.overageDisabledReason === "out_of_credits") {
      return `You're out of usage credits${overageSuffix}`;
    }
    if (state.overageDisabledReason === "org_spend_cap_reached") {
      return `Your org is out of usage${overageSuffix}`;
    }
    if (state.overageDisabledReason === "seat_tier_level_disabled" || state.overageDisabledReason === "seat_tier_zero_credit_limit") {
      return "Your seat type doesn't include usage credits";
    }
    if (state.overageDisabledReason === "org_service_level_disabled") {
      return "This service is disabled for your org";
    }
    if (state.overageDisabledReason === "member_level_disabled" || state.overageDisabledReason === "member_zero_credit_limit") {
      return "Your usage allocation has been disabled by your admin";
    }
    if (state.overageDisabledReason === "group_zero_credit_limit") {
      return "Your group's usage limit is set to $0";
    }
    if (state.overageDisabledReason === "org_level_disabled_until") {
      return `Your org's monthly usage limit has been reached${overageSuffix}`;
    }

    return `You've hit your usage limit${overageSuffix}`;
  }

  const label = getRateLimitLabel(state.rateLimitType);
  return `You've hit your ${label ?? "usage limit"}${suffix}`;
}

function formatWarningRateLimitMessage(state: ClaudeRateLimitState): string | null {
  const label = getRateLimitLabel(state.rateLimitType);
  if (!label) return null;

  const utilizationPct = typeof state.utilization === "number" ? Math.floor(state.utilization * 100) : undefined;
  const resetText = state.resetsAt ? formatResetTime(state.resetsAt, true) : undefined;
  if (utilizationPct !== undefined && resetText) {
    return `You've used ${utilizationPct}% of your ${label} · resets ${resetText}`;
  }

  if (utilizationPct !== undefined) {
    return `You've used ${utilizationPct}% of your ${label}`;
  }

  if (resetText) {
    return `Approaching ${label} · resets ${resetText}`;
  }

  return `Approaching ${label}`;
}

function getClaudeFooterStatus(headers: Record<string, string>, httpStatus?: number): ClaudeFooterStatus | null {
  const state = parseClaudeRateLimitState(headers, httpStatus);
  if (!state) return null;

  if (state.status === "rejected" && !state.isUsingOverage) {
    return { message: formatRejectedRateLimitMessage(state), severity: "error" };
  }

  if (state.rateLimitGraceActive) {
    return { message: "Usage limit reached — grace window active. Wrap up or checkpoint soon.", severity: "warning" };
  }

  if (state.isUsingOverage) {
    if (state.overageStatus === "allowed_warning") {
      return { message: "You're close to your usage credit limit", severity: "warning" };
    }
    return null;
  }

  if (state.status === "allowed_warning") {
    if (typeof state.utilization === "number" && state.utilization < 0.7) return null;
    const message = formatWarningRateLimitMessage(state);
    return message ? { message, severity: "warning" } : null;
  }

  return null;
}

function getUnifiedRateLimitHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase().startsWith("anthropic-ratelimit-unified-")),
  );
}

function isAnthropicOAuthToken(apiKey: string | undefined): apiKey is string {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function isAnthropicRateLimitError(message: string | undefined): boolean {
  if (!message) return false;
  return /(^|\b)429(\b|$)|rate_limit_error|too many requests|rate limit/i.test(message);
}

function getQuotaCheckUrl(baseUrl: string | undefined): string {
  const normalizedBaseUrl = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  if (normalizedBaseUrl.endsWith("/v1/messages")) return normalizedBaseUrl;
  if (normalizedBaseUrl.endsWith("/v1")) return `${normalizedBaseUrl}/messages`;
  return `${normalizedBaseUrl}/v1/messages`;
}

function getOAuthUsageUrl(baseUrl: string | undefined): string | null {
  if (!isFirstPartyAnthropicBaseUrl(baseUrl)) return null;
  return "https://api.anthropic.com/api/oauth/usage";
}

function parseUsageReset(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.round(timestamp / 1000) : undefined;
}

function getUsageLimit(value: unknown): { utilization: number; resetsAt?: number } | null {
  if (!isObject(value) || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) return null;
  return { utilization: value.utilization / 100, resetsAt: parseUsageReset(value.resets_at) };
}

function usageResponseToRateLimitHeaders(value: unknown): Record<string, string> | null {
  if (!isObject(value)) return null;
  const candidates: Array<{ type: ClaudeRateLimitType; value: { utilization: number; resetsAt?: number } | null }> = [
    { type: "five_hour", value: getUsageLimit(value.five_hour) },
    { type: "seven_day", value: getUsageLimit(value.seven_day) },
    { type: "seven_day_opus", value: getUsageLimit(value.seven_day_opus) },
    { type: "seven_day_sonnet", value: getUsageLimit(value.seven_day_sonnet) },
  ];
  const representative = candidates
    .filter((candidate): candidate is { type: ClaudeRateLimitType; value: { utilization: number; resetsAt?: number } } =>
      candidate.value !== null && candidate.value.utilization >= 1,
    )
    .sort((a, b) => b.value.utilization - a.value.utilization)[0];
  const extraUsage = isObject(value.extra_usage) ? value.extra_usage : null;
  const disabledReason = extraUsage && typeof extraUsage.disabled_reason === "string" ? extraUsage.disabled_reason : undefined;
  if (!representative && !disabledReason) return null;

  const result: Record<string, string> = {
    "anthropic-ratelimit-unified-status": "rejected",
  };
  if (representative) {
    result["anthropic-ratelimit-unified-representative-claim"] = representative.type;
    if (representative.value.resetsAt !== undefined) {
      result["anthropic-ratelimit-unified-reset"] = String(representative.value.resetsAt);
    }
  }
  if (disabledReason) {
    result["anthropic-ratelimit-unified-overage-status"] = "rejected";
    result["anthropic-ratelimit-unified-overage-disabled-reason"] = disabledReason;
  }
  return result;
}

async function fetchQuotaCheckHeaders(
  apiKey: string,
  baseUrl: string | undefined,
  headers: ProviderHeaders | undefined,
): Promise<{ headers: Record<string, string>; status: number } | null> {
  const usageUrl = getOAuthUsageUrl(baseUrl);
  const nonNullHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  const sharedHeaders = {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": getClaudeUserAgent(),
    "x-app": "cli",
    ...nonNullHeaders,
  };

  if (usageUrl) {
    const usageResponse = await fetch(usageUrl, {
      method: "GET",
      headers: sharedHeaders,
    });
    const usageHeaders = Object.fromEntries(usageResponse.headers.entries());
    if (hasUnifiedRateLimitHeaders(usageHeaders)) {
      return { headers: usageHeaders, status: usageResponse.status };
    }
    if (usageResponse.ok) {
      const usageBody: unknown = await usageResponse.json();
      const synthesizedHeaders = usageResponseToRateLimitHeaders(usageBody);
      if (synthesizedHeaders) return { headers: synthesizedHeaders, status: 429 };
    }
  }

  const response = await fetch(getQuotaCheckUrl(baseUrl), {
    method: "POST",
    headers: {
      ...sharedHeaders,
      "x-anthropic-billing-header": buildBillingHeader(
        [{ role: "user", content: "quota" }],
        getEntrypoint(),
        isFirstPartyAnthropicBaseUrl(baseUrl),
      ),
    },
    body: JSON.stringify({
      model: QUOTA_CHECK_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "quota" }],
    }),
  });

  return { headers: Object.fromEntries(response.headers.entries()), status: response.status };
}

async function resolveAnthropicQuotaFooterStatus(
  model: Model<"anthropic-messages">,
  options: SimpleStreamOptions | undefined,
): Promise<ClaudeFooterStatus | null> {
  const apiKey = options?.apiKey;
  if (!isAnthropicOAuthToken(apiKey)) return null;

  const keyHash = sha256Hex(apiKey);
  if (cachedQuotaFooterStatus && cachedQuotaFooterStatus.keyHash === keyHash && Date.now() - cachedQuotaFooterStatus.checkedAt < QUOTA_CHECK_CACHE_TTL_MS) {
    return cachedQuotaFooterStatus.value;
  }

  try {
    const quotaCheck = await fetchQuotaCheckHeaders(apiKey, model.baseUrl, options?.headers);
    if (!quotaCheck) return null;
    const footerStatus = getClaudeFooterStatus(quotaCheck.headers, quotaCheck.status);
    cachedQuotaFooterStatus = { keyHash, value: footerStatus, checkedAt: Date.now() };
    return footerStatus;
  } catch (error) {
    log("quota_check_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function createAnthropicErrorEvent(model: Model<"anthropic-messages">, message: string): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

function applyFooterStatusToCurrentContext(footerStatus: ClaudeFooterStatus): void {
  if (!latestCtx || !shouldApply(latestCtx)) return;

  setAdapterStatus(latestCtx, {
    phase: "warning",
    applies: true,
    suppressWarning: true,
    docsSource: adapterStatus.docsSource,
    billingHeader: adapterStatus.billingHeader,
    reason: "Resolved Claude usage state from Anthropic quota check",
    statusText: footerStatus.message,
  });
}

function getLogFile(): string | null {
  const path = process.env.PI_CLAUDE_OAUTH_LOG_FILE;
  return path ? resolve(path) : null;
}

function log(event: string, details: Record<string, unknown>): void {
  const logFile = getLogFile();
  if (!logFile) return;

  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
      "utf8",
    );
  } catch {
    // Never let optional debug logging break the session.
  }
}

function shouldApply(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return !!model && model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
}

function clearAdapterStatuses(ctx: ExtensionContext): void {
  ctx.ui.setStatus(READY_STATUS_KEY, undefined);
  ctx.ui.setStatus(ISSUE_STATUS_KEY, undefined);
}

function renderAdapterStatus(ctx: ExtensionContext): void {
  clearAdapterStatuses(ctx);

  if (!adapterStatus.applies) return;

  const theme = ctx.ui.theme;
  if (adapterStatus.phase === "ready") {
    ctx.ui.setStatus(READY_STATUS_KEY, theme.fg("success", adapterStatus.statusText || "✓ Claude OAuth ready"));
    return;
  }

  if (adapterStatus.phase === "active") {
    ctx.ui.setStatus(READY_STATUS_KEY, theme.fg("success", adapterStatus.statusText || "✓ Claude OAuth active"));
    return;
  }

  if (adapterStatus.phase === "warning") {
    ctx.ui.setStatus(ISSUE_STATUS_KEY, theme.fg("warning", adapterStatus.statusText || "Claude usage limit"));
    return;
  }

  if (adapterStatus.phase === "issue") {
    ctx.ui.setStatus(ISSUE_STATUS_KEY, theme.fg("warning", adapterStatus.statusText || "⚠ Claude OAuth setup"));
  }
}

function setAdapterStatus(ctx: ExtensionContext, nextStatus: AdapterStatusState): void {
  adapterStatus = nextStatus;
  renderAdapterStatus(ctx);
}

function shouldInjectDocs(prompt: string): boolean {
  const scope = getEnvScope();
  if (scope === "never") return false;
  if (scope === "always") return true;
  return PI_TOPIC_REGEX.test(prompt);
}

function extractDocsSection(systemPrompt: string): { docsSection: string; strippedPrompt: string } | null {
  const start = systemPrompt.indexOf(DOCS_MARKER);
  if (start < 0) return null;

  let end = systemPrompt.length;
  for (const marker of END_MARKERS) {
    const index = systemPrompt.indexOf(marker, start);
    if (index >= 0 && index < end) end = index;
  }

  const docsSection = systemPrompt.slice(start, end).trim();
  const before = systemPrompt.slice(0, start).trimEnd();
  const after = systemPrompt.slice(end).trimStart();
  const strippedPrompt = [before, after].filter((part) => part.length > 0).join("\n\n").trim();
  return { docsSection, strippedPrompt };
}

function getPiPackageRoot(): string | null {
  const cliPath = process.argv[1];
  if (!cliPath) return null;

  try {
    const resolvedCliPath = realpathSync(cliPath);
    return dirname(dirname(resolvedCliPath));
  } catch {
    return null;
  }
}

function buildDynamicFallbackDocsSection(): string | null {
  const piRoot = getPiPackageRoot();
  if (!piRoot) return null;

  const readmePath = join(piRoot, "README.md");
  const docsPath = join(piRoot, "docs");
  const examplesPath = join(piRoot, "examples");
  return [
    DOCS_MARKER,
    `- Main documentation: ${readmePath}`,
    `- Additional docs: ${docsPath}`,
    `- Examples: ${examplesPath} (extensions, custom tools, SDK)`,
    "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
    "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
  ].join("\n");
}

function readFallbackDocsSection(): string | null {
  const override = process.env.PI_CLAUDE_OAUTH_DOCS_FILE;
  if (override) {
    const path = resolve(override);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      if (content.length > 0) return content;
    }
  }

  return buildDynamicFallbackDocsSection();
}

function resolveDocsSection(systemPrompt: string): ResolvedDocsSection {
  const extracted = extractDocsSection(systemPrompt);
  if (extracted) {
    return { extracted, docsSection: extracted.docsSection, docsSource: "system" };
  }

  const fallbackDocs = readFallbackDocsSection();
  if (fallbackDocs) {
    return { extracted: null, docsSection: fallbackDocs, docsSource: "fallback" };
  }

  return { extracted: null, docsSection: null, docsSource: "missing" };
}

function syncSetupStatus(ctx: ExtensionContext, systemPrompt: string): ResolvedDocsSection {
  latestCtx = ctx;

  if (!shouldApply(ctx)) {
    setAdapterStatus(ctx, {
      phase: "inactive",
      applies: false,
      suppressWarning: false,
      docsSource: "missing",
      billingHeader: "unknown",
      reason: "Not using Anthropic OAuth",
      statusText: "",
    });
    return { extracted: null, docsSection: null, docsSource: "missing" };
  }

  const resolved = resolveDocsSection(systemPrompt);
  if (!resolved.docsSection) {
    setAdapterStatus(ctx, {
      phase: "issue",
      applies: true,
      suppressWarning: false,
      docsSource: resolved.docsSource,
      billingHeader: "unknown",
      reason: "No Pi docs context available to rehydrate Anthropic OAuth requests",
      statusText: "⚠ Claude OAuth setup",
    });
    return resolved;
  }

  const nextPhase: AdapterPhase = adapterStatus.phase === "active" ? "active" : "ready";
  const nextReason = resolved.docsSource === "system"
    ? "Using system prompt docs context"
    : "Using fallback docs context";

  setAdapterStatus(ctx, {
    phase: nextPhase,
    applies: true,
    suppressWarning: true,
    docsSource: resolved.docsSource,
    billingHeader: adapterStatus.billingHeader,
    reason: nextReason,
    statusText: nextPhase === "ready" ? "✓ Claude OAuth ready" : adapterStatus.statusText,
  });

  return resolved;
}

function wrapDocsContext(docsSection: string): string {
  return `<pi-docs-context>\n${docsSection}\n</pi-docs-context>`;
}

function summarizeMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.slice(-4).map((message) => {
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      const content = Array.isArray(message.content)
        ? message.content
            .filter((part): part is TextContentPart => isObject(part) && part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
        : String(message.content);
      return { role: message.role, text: content.slice(0, 140) };
    }

    if (message.role === "custom") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part): part is TextContentPart => part.type === "text")
            .map((part) => part.text)
            .join("\n");
      return { role: message.role, customType: message.customType, text: content.slice(0, 140) };
    }

    return { role: message.role };
  });
}

function prependCustomMessage(messages: AgentMessage[], docsSection: string, timestamp: number): AgentMessage[] {
  const customMessage: CustomLikeMessage = {
    role: "custom",
    customType: CUSTOM_TYPE,
    content: wrapDocsContext(docsSection),
    display: false,
    timestamp,
  };

  // Index 0, because it never moves. Any anchor that tracks the conversation
  // shifts between turns, and every shift re-bills the cached prefix.
  return [customMessage as AgentMessage, ...messages];
}

function appendCustomMessage(messages: AgentMessage[], docsSection: string, timestamp: number): AgentMessage[] {
  const customMessage: CustomLikeMessage = {
    role: "custom",
    customType: CUSTOM_TYPE,
    content: wrapDocsContext(docsSection),
    display: false,
    timestamp,
  };

  const latestUserIndex = [...messages].findLastIndex((message) => isUserMessage(message));
  if (latestUserIndex < 0) return [...messages, customMessage as AgentMessage];

  const nextMessages = [...messages];
  nextMessages.splice(latestUserIndex + 1, 0, customMessage as AgentMessage);
  return nextMessages;
}

function prependReminderToLatestUser(messages: AgentMessage[], docsSection: string): AgentMessage[] {
  const latestUserIndex = [...messages].findLastIndex((message) => isUserMessage(message));
  if (latestUserIndex < 0) return messages;

  const reminder = `<system-reminder>\n${docsSection}\n</system-reminder>\n\n`;
  const nextMessages = structuredClone(messages);
  const latestUser = nextMessages[latestUserIndex];
  if (!isUserMessage(latestUser)) return messages;

  if (typeof latestUser.content === "string") {
    if (!latestUser.content.startsWith("<system-reminder>")) {
      latestUser.content = `${reminder}${latestUser.content}`;
    }
    return nextMessages;
  }

  const firstTextIndex = latestUser.content.findIndex((part) => part.type === "text");
  if (firstTextIndex < 0) {
    latestUser.content.unshift({ type: "text", text: reminder } as TextContentPart);
    return nextMessages;
  }

  const firstText = latestUser.content[firstTextIndex];
  if (firstText.type === "text" && !firstText.text.startsWith("<system-reminder>")) {
    latestUser.content[firstTextIndex] = { ...firstText, text: `${reminder}${firstText.text}` };
  }
  return nextMessages;
}

function userMessageText(message: UserLikeMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is TextContentPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function messageScanText(message: AgentMessage): string {
  if (isUserMessage(message)) return userMessageText(message);
  // Compaction and branch summaries replace the user messages they cover, so
  // they must count too or compaction would silently un-latch the block.
  const summary = (message as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary : "";
}

// Decide from persisted messages only, so the answer is the same after
// `pi -c`, resume, or fork. A block that comes and goes from index 0 re-bills
// the whole conversation. Once a message matches, every request injects.
function shouldInjectAtHead(messages: AgentMessage[]): boolean {
  const scope = getEnvScope();
  if (scope === "never") return false;
  if (scope === "always") return true;
  return messages.some((message) => PI_TOPIC_REGEX.test(messageScanText(message)));
}

function injectDocs(messages: AgentMessage[], state: ActiveTurnState): AgentMessage[] {
  if (state.mode === "none") return messages;

  if (state.mode === "prepend-custom-message") {
    if (!shouldInjectAtHead(messages)) return messages;
    return prependCustomMessage(messages, state.docsSection, state.timestamp);
  }

  if (!state.shouldInject) return messages;

  switch (state.mode) {
    case "append-custom-message":
      return appendCustomMessage(messages, state.docsSection, state.timestamp);
    case "user-reminder":
      return prependReminderToLatestUser(messages, state.docsSection);
  }
}

function cloneBlock(block: TextBlock): TextBlock {
  return block.cache_control ? { ...block, cache_control: { ...block.cache_control } } : { ...block };
}

function ensurePromptBlock(blocks: TextBlock[], ctx: ExtensionContext): TextBlock[] {
  if (blocks.some((block) => !block.text.startsWith("x-anthropic-billing-header:"))) {
    return blocks;
  }

  const systemPrompt = ctx.getSystemPrompt();
  const extracted = extractDocsSection(systemPrompt);
  const text = extracted?.strippedPrompt ?? systemPrompt;
  if (!text.trim()) return blocks;

  const template = blocks.find((block) => block.cache_control)?.cache_control;
  return [
    ...blocks,
    template ? { type: "text", text, cache_control: { ...template } } : { type: "text", text },
  ];
}

function normalizeSystemBlocks(
  blocks: TextBlock[],
  ctx: ExtensionContext,
  messages: unknown,
): { blocks: TextBlock[]; billingState: BillingHeaderState } {
  const billingHeader = buildBillingHeader(messages);
  let billingState: BillingHeaderState = "unknown";
  let sawBillingHeader = false;
  const nextBlocks: TextBlock[] = [];

  for (const block of blocks) {
    if (block.text === IDENTITY_BLOCK) {
      continue;
    }

    if (block.text.startsWith("x-anthropic-billing-header:")) {
      if (sawBillingHeader) continue;
      sawBillingHeader = true;
      if (block.text === billingHeader) {
        billingState = "present";
        nextBlocks.push(cloneBlock(block));
      } else {
        billingState = "updated";
        nextBlocks.push({ ...cloneBlock(block), text: billingHeader });
      }
      continue;
    }

    if (!block.text.includes(DOCS_MARKER)) {
      nextBlocks.push(cloneBlock(block));
      continue;
    }

    const extracted = extractDocsSection(block.text);
    if (!extracted || extracted.strippedPrompt.length === 0) {
      continue;
    }
    nextBlocks.push({ ...cloneBlock(block), text: extracted.strippedPrompt });
  }

  if (!sawBillingHeader) {
    nextBlocks.unshift({ type: "text", text: billingHeader });
    billingState = "injected";
  }

  return { blocks: ensurePromptBlock(nextBlocks, ctx), billingState };
}

export default function claudeOauthAdapter(pi: ExtensionAPI) {
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const anthropicModel = model as Model<"anthropic-messages">;
      log("custom_stream_invoked", {
        model: anthropicModel.id,
        provider: anthropicModel.provider,
        isOAuth: isAnthropicOAuthToken(options?.apiKey),
      });
      if (!isAnthropicOAuthToken(options?.apiKey)) {
        return streamSimpleAnthropic(anthropicModel, context, options);
      }

      const outer = createAssistantMessageEventStream();

      void (async () => {
        try {
          const preflightFooterStatus = await resolveAnthropicQuotaFooterStatus(anthropicModel, options);
          if (preflightFooterStatus?.severity === "error") {
            log("custom_stream_preflight_rejected", { message: preflightFooterStatus.message });
            applyFooterStatusToCurrentContext(preflightFooterStatus);
            outer.push(createAnthropicErrorEvent(anthropicModel, preflightFooterStatus.message));
            return;
          }

          if (preflightFooterStatus?.severity === "warning") {
            log("custom_stream_preflight_warning", { message: preflightFooterStatus.message });
            applyFooterStatusToCurrentContext(preflightFooterStatus);
          }

          const inner = streamSimpleAnthropic(anthropicModel, context, options);
          for await (const event of inner) {
            log("custom_stream_event", { type: event.type, hasErrorMessage: event.type === "error" ? !!event.error.errorMessage : false });
            if (event.type === "error" && isAnthropicRateLimitError(event.error.errorMessage)) {
              log("custom_stream_rate_limit", { message: event.error.errorMessage });
              const footerStatus = await resolveAnthropicQuotaFooterStatus(anthropicModel, options);
              if (footerStatus) {
                log("custom_stream_quota_resolved", { message: footerStatus.message, severity: footerStatus.severity });
                applyFooterStatusToCurrentContext(footerStatus);
                outer.push(createAnthropicErrorEvent(anthropicModel, footerStatus.message));
                continue;
              }
            }

            outer.push(event);
          }
          outer.end();
        } catch (error) {
          outer.push(createAnthropicErrorEvent(anthropicModel, error instanceof Error ? error.message : String(error)));
        }
      })();

      return outer;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    syncSetupStatus(ctx, ctx.getSystemPrompt());
  });

  pi.on("model_select", (_event, ctx) => {
    syncSetupStatus(ctx, ctx.getSystemPrompt());
  });

  pi.on("before_agent_start", (event, ctx) => {
    const resolved = syncSetupStatus(ctx, event.systemPrompt);
    if (!shouldApply(ctx)) {
      activeTurn = null;
      return;
    }

    if (!resolved.docsSection) {
      activeTurn = null;
      return;
    }

    activeTurn = {
      docsSection: resolved.docsSection,
      shouldInject: shouldInjectDocs(event.prompt),
      mode: getEnvMode(),
      prompt: event.prompt,
      timestamp: Date.now(),
    };

    log("before_agent_start", {
      prompt: event.prompt,
      shouldInject: activeTurn.shouldInject,
      mode: activeTurn.mode,
      scope: getEnvScope(),
      docsLength: resolved.docsSection.length,
      docsSource: resolved.docsSource,
      strippedFromSystem: !!resolved.extracted,
      suppressWarning: adapterStatus.suppressWarning,
    });

    if (resolved.extracted) {
      return { systemPrompt: resolved.extracted.strippedPrompt };
    }

    return;
  });

  pi.on("context", (event, ctx) => {
    latestCtx = ctx;
    if (!shouldApply(ctx) || !activeTurn) return;
    const nextMessages = injectDocs(event.messages, activeTurn);
    log("context", {
      mode: activeTurn.mode,
      injected: nextMessages !== event.messages,
      messagesBefore: summarizeMessages(event.messages),
      messagesAfter: summarizeMessages(nextMessages),
    });
    return { messages: nextMessages };
  });

  pi.on("before_provider_request", (event, ctx) => {
    latestCtx = ctx;
    if (!shouldApply(ctx) || !isPayloadLike(event.payload)) return;

    const currentBlocks = Array.isArray(event.payload.system) ? event.payload.system.filter(isTextBlock) : [];
    const normalized = normalizeSystemBlocks(currentBlocks, ctx, event.payload.messages);
    const changed =
      normalized.billingState === "injected" ||
      normalized.billingState === "updated" ||
      normalized.blocks.length !== currentBlocks.length ||
      normalized.blocks.some((block, index) => currentBlocks[index]?.text !== block.text);

    const nextPayload = changed
      ? { ...event.payload, system: normalized.blocks }
      : event.payload;

    const reason =
      normalized.billingState === "injected"
        ? "Injected Claude billing header into Anthropic OAuth request"
        : normalized.billingState === "updated"
          ? "Updated Claude billing header to Claude Code 2.1.226 shape"
          : normalized.billingState === "present"
            ? "Anthropic OAuth request already includes Claude billing header"
            : "Normalized Anthropic OAuth request";

    setAdapterStatus(ctx, {
      phase: "active",
      applies: true,
      suppressWarning: true,
      docsSource: adapterStatus.docsSource === "missing" ? "fallback" : adapterStatus.docsSource,
      billingHeader: normalized.billingState,
      reason,
      statusText: "✓ Claude OAuth active",
    });

    log("before_provider_request", {
      changed,
      billingState: normalized.billingState,
      docsSource: adapterStatus.docsSource,
      suppressWarning: adapterStatus.suppressWarning,
      systemBefore: currentBlocks.map((block, index) => `${index}: ${block.text.slice(0, 140)}`),
      systemAfter: normalized.blocks.map((block, index) => `${index}: ${block.text.slice(0, 140)}`),
      messageCount: Array.isArray(nextPayload.messages) ? nextPayload.messages.length : undefined,
      toolCount: Array.isArray(nextPayload.tools) ? nextPayload.tools.length : undefined,
    });

    return nextPayload;
  });

  pi.on("after_provider_response", (event, ctx) => {
    latestCtx = ctx;
    if (!shouldApply(ctx)) return;

    const footerStatus = getClaudeFooterStatus(event.headers, event.status);
    log("after_provider_response", {
      status: event.status,
      unifiedRateLimitHeaders: getUnifiedRateLimitHeaders(event.headers),
      footerStatus,
    });

    if (footerStatus) {
      setAdapterStatus(ctx, {
        phase: "warning",
        applies: true,
        suppressWarning: true,
        docsSource: adapterStatus.docsSource,
        billingHeader: adapterStatus.billingHeader,
        reason: `Anthropic OAuth request reported Claude usage state (${event.status})`,
        statusText: footerStatus.message,
      });
      return;
    }

    if (event.status >= 400) {
      setAdapterStatus(ctx, {
        phase: "issue",
        applies: true,
        suppressWarning: false,
        docsSource: adapterStatus.docsSource,
        billingHeader: adapterStatus.billingHeader,
        reason: `Anthropic OAuth request failed with HTTP ${event.status}`,
        statusText: "⚠ Claude OAuth setup",
      });
      return;
    }

    if (adapterStatus.phase === "active" || adapterStatus.phase === "warning") {
      setAdapterStatus(ctx, {
        ...adapterStatus,
        phase: "active",
        applies: true,
        suppressWarning: true,
        reason: `Anthropic OAuth request succeeded (${event.status})`,
        statusText: "✓ Claude OAuth active",
      });
    }
  });

  pi.on("agent_end", () => {
    activeTurn = null;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    latestCtx = null;
    activeTurn = null;
    adapterStatus = {
      phase: "inactive",
      applies: false,
      suppressWarning: false,
      docsSource: "missing",
      billingHeader: "unknown",
      reason: "Session ended",
      statusText: "",
    };
    clearAdapterStatuses(ctx);
  });
}
