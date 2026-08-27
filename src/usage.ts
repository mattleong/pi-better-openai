import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodexCredentials } from "./codex-auth.ts";
export { AUTH_FILE, readCodexAuth } from "./codex-auth.ts";

export type UsageWindow = {
  used_percent?: number | null;
  limit_window_seconds?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
};

export type RateLimitBucket = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: UsageWindow | null;
  secondary_window?: UsageWindow | null;
};

export type CodexUsageResponse = {
  rate_limit?: RateLimitBucket | null;
  additional_rate_limits?: Record<string, unknown> | unknown[] | null;
};

export type UsageSnapshotWindow = {
  label: string;
  leftPercent: number | null;
  resetInSeconds: number | null;
  windowSeconds: number | null;
};

export type UsageSnapshot = {
  capturedAt: number;
  scope: UsageScope;
  windows: UsageSnapshotWindow[];
  isLimited: boolean;
};

export type UsageScope = "default" | "spark";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SPARK_LIMIT_NAME = "GPT-5.3-Codex-Spark";
type ResetClockFormatters = {
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
};
const RESET_CLOCK_FORMATTER_CACHE_LIMIT = 4;
const resetClockFormatters = new Map<string, ResetClockFormatters>();

function currentTimeZoneKey(date: Date): string {
  const zoneLabel = /\(([^)]+)\)$/.exec(date.toString())?.[1] ?? "";
  return `${process.env.TZ ?? ""}:${date.getTimezoneOffset()}:${zoneLabel}`;
}

function getResetClockFormatters(now: Date, reset: Date): ResetClockFormatters {
  const timeZoneKey = `${currentTimeZoneKey(now)}:${reset.getTimezoneOffset()}`;
  let formatters = resetClockFormatters.get(timeZoneKey);
  if (!formatters) {
    formatters = {
      time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
      weekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }),
    };
    resetClockFormatters.set(timeZoneKey, formatters);
    while (resetClockFormatters.size > RESET_CLOCK_FORMATTER_CACHE_LIMIT) {
      const oldestKey = resetClockFormatters.keys().next().value;
      if (oldestKey === undefined) break;
      resetClockFormatters.delete(oldestKey);
    }
  }
  return formatters;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usedToLeftPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampPercent(100 - value);
}

export function formatResetCountdown(seconds: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m`;
  return `${secs}s`;
}

function formatResetClock(seconds: number | null, now = Date.now()): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const resetDate = new Date(now + seconds * 1000);
  const currentDate = new Date(now);
  const formatters = getResetClockFormatters(currentDate, resetDate);
  const time = formatters.time.format(resetDate);
  if (resetDate.toDateString() === currentDate.toDateString()) return time;
  return `${formatters.weekday.format(resetDate)} ${time}`;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

export async function requestCodexUsage(
  ctxOrSignal?: ExtensionContext | AbortSignal,
  signal?: AbortSignal,
): Promise<CodexUsageResponse | undefined> {
  const ctx = isAbortSignal(ctxOrSignal) ? undefined : ctxOrSignal;
  const requestSignal = isAbortSignal(ctxOrSignal) ? ctxOrSignal : signal;
  const credentials = await getCodexCredentials(ctx, requestSignal);
  if (!credentials) return undefined;
  const response = await fetch(USAGE_URL, {
    headers: {
      accept: "*/*",
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
    },
    signal: requestSignal,
  });
  if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`);
  return (await response.json()) as CodexUsageResponse;
}

function normalizeRateLimitBucket(value: unknown): RateLimitBucket | null {
  const record = asObject(value);
  if (!record) return null;
  if (
    !(
      "primary_window" in record ||
      "secondary_window" in record ||
      "limit_reached" in record ||
      "allowed" in record
    )
  )
    return null;
  return record as RateLimitBucket;
}

function extractSparkRateLimitFromEntry(value: unknown): RateLimitBucket | null {
  const record = asObject(value);
  if (!record || record.limit_name !== SPARK_LIMIT_NAME) return null;
  return normalizeRateLimitBucket(record.rate_limit);
}

function findSparkRateLimitBucket(data: CodexUsageResponse): RateLimitBucket | null {
  const additional = data.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const bucket = extractSparkRateLimitFromEntry(entry);
      if (bucket) return bucket;
    }
  } else {
    const map = asObject(additional);
    if (map) {
      for (const value of Object.values(map)) {
        const bucket = extractSparkRateLimitFromEntry(value);
        if (bucket) return bucket;
      }
    }
  }
  return null;
}

function getResetSeconds(window: UsageWindow | null | undefined, now: number): number | null {
  if (
    typeof window?.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds)
  )
    return window.reset_after_seconds;
  if (typeof window?.reset_at !== "number" || !Number.isFinite(window.reset_at)) return null;
  const resetAtSeconds =
    window.reset_at > 100_000_000_000 ? window.reset_at / 1000 : window.reset_at;
  return Math.max(0, resetAtSeconds - now / 1000);
}

export function usageScopeForModel(modelId: string | undefined): UsageScope {
  return modelId === SPARK_MODEL_ID ? "spark" : "default";
}

function formatUsageWindowLabel(seconds: number | null, fallbackIndex: number): string {
  if (seconds !== null) {
    if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
    if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
  }
  return fallbackIndex === 0 ? "5h" : "7d";
}

function parseUsageWindow(
  window: UsageWindow,
  fallbackIndex: number,
  now: number,
): UsageSnapshotWindow {
  const windowSeconds =
    typeof window.limit_window_seconds === "number" &&
    Number.isFinite(window.limit_window_seconds) &&
    window.limit_window_seconds > 0
      ? window.limit_window_seconds
      : null;
  return {
    label: formatUsageWindowLabel(windowSeconds, fallbackIndex),
    leftPercent: usedToLeftPercent(window.used_percent),
    resetInSeconds: getResetSeconds(window, now),
    windowSeconds,
  };
}

export function parseUsageSnapshot(
  data: CodexUsageResponse,
  modelId: string | undefined,
  now = Date.now(),
): UsageSnapshot {
  const scope = usageScopeForModel(modelId);
  const bucket =
    scope === "spark"
      ? (findSparkRateLimitBucket(data) ?? normalizeRateLimitBucket(data.rate_limit))
      : normalizeRateLimitBucket(data.rate_limit);
  const windows = [bucket?.primary_window, bucket?.secondary_window]
    .map((window, index) => (window ? parseUsageWindow(window, index, now) : null))
    .filter((window): window is UsageSnapshotWindow => window !== null)
    .sort((left, right) => {
      if (left.windowSeconds === null || right.windowSeconds === null) return 0;
      return left.windowSeconds - right.windowSeconds;
    });
  return {
    capturedAt: now,
    scope,
    windows,
    isLimited: bucket?.limit_reached === true || bucket?.allowed === false,
  };
}

export function formatPercent(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
}

export function formatUsageSnapshot(
  snapshot: UsageSnapshot,
  options: { showResetTimes: boolean },
  now = Date.now(),
): string {
  const windows = snapshot.windows.map((window) => {
    const usage = `${window.label} ${formatPercent(window.leftPercent)}`;
    if (!options.showResetTimes) return usage;

    const resetInSeconds = remainingResetSeconds(window.resetInSeconds, snapshot.capturedAt, now);
    const countdown = formatResetCountdown(resetInSeconds);
    const clock = formatResetClock(resetInSeconds, now);
    return countdown && clock ? `${usage} · resets in ${countdown} (${clock})` : usage;
  });
  return `Usage: ${windows.length > 0 ? windows.join(" | ") : "--"}`;
}

function remainingResetSeconds(
  seconds: number | null,
  capturedAt: number,
  now: number,
): number | null {
  return seconds === null ? null : seconds - (now - capturedAt) / 1000;
}
