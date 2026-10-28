/**
 * Opt-in, process-local aggregate MCP tool telemetry.
 * No arguments, results, file paths, prompts, session IDs, or secrets are retained.
 */
const SAMPLE_LIMIT = 256;

interface MetricBucket {
  name: string;
  calls: number;
  errors: number;
  elapsed: number[];
  bytes: number[];
}

const buckets = new Map<string, MetricBucket>();

export function isToolMetricsEnabled(): boolean {
  return process.env.LOCAL_CODER_METRICS === "1";
}

function safeToolName(name: string): string {
  return /^[a-zA-Z0-9_:-]{1,80}$/.test(name) ? name : "other";
}

function isToolError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const response = result as {
    isError?: unknown;
    structuredContent?: { ok?: unknown };
  };
  return response.isError === true || response.structuredContent?.ok === false;
}

function responseBytes(result: unknown): number {
  try {
    const encoded = JSON.stringify(result);
    return encoded === undefined ? 0 : Buffer.byteLength(encoded, "utf8");
  } catch {
    return 0;
  }
}

function addSample(samples: number[], value: number): void {
  if (samples.length === SAMPLE_LIMIT) samples.shift();
  samples.push(value);
}

function quantiles(samples: number[]): { p50: number; p95: number } {
  if (samples.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => {
    const index = Math.ceil(fraction * sorted.length) - 1;
    return Math.round(sorted[index]! * 100) / 100;
  };
  return { p50: percentile(0.5), p95: percentile(0.95) };
}

export function recordToolMetric(
  name: string,
  elapsedMs: number,
  result: unknown,
  thrown = false
): void {
  if (!isToolMetricsEnabled()) return;
  const safeName = safeToolName(name);
  let bucket = buckets.get(safeName);
  if (!bucket) {
    bucket = { name: safeName, calls: 0, errors: 0, elapsed: [], bytes: [] };
    buckets.set(safeName, bucket);
  }
  bucket.calls++;
  if (thrown || isToolError(result)) bucket.errors++;
  addSample(bucket.elapsed, Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0);
  addSample(bucket.bytes, thrown ? 0 : responseBytes(result));
}

export function getToolMetricsSnapshot(): {
  enabled: boolean;
  tools: Array<{
    name: string;
    calls: number;
    errors: number;
    sample_count: number;
    latency_ms: { p50: number; p95: number };
    response_bytes: { p50: number; p95: number };
  }>;
} {
  if (!isToolMetricsEnabled()) return { enabled: false, tools: [] };
  return {
    enabled: true,
    tools: [...buckets.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((bucket) => ({
        name: bucket.name,
        calls: bucket.calls,
        errors: bucket.errors,
        sample_count: bucket.elapsed.length,
        latency_ms: quantiles(bucket.elapsed),
        response_bytes: quantiles(bucket.bytes),
      })),
  };
}