import assert from "node:assert/strict";
import { createServer } from "node:http";

const total = positiveInteger(process.env.OCR_BENCH_REQUESTS, 5_000);
const concurrency = positiveInteger(process.env.OCR_BENCH_CONCURRENCY, 100);
const warmup = positiveInteger(process.env.OCR_BENCH_WARMUP, 500);
const targets = (process.env.OCR_BENCH_ROUTER_URLS ?? "rust=http://127.0.0.1:3457")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf("=");
    assert(separator > 0, "OCR_BENCH_ROUTER_URLS entries must be name=http://host:port");
    return { name: entry.slice(0, separator), url: entry.slice(separator + 1).replace(/\/$/, "") };
  });

const upstream = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-benchmark",
      object: "chat.completion",
      model: "benchmark-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }));
  });
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
assert(address && typeof address === "object");
const upstreamUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;

try {
  for (const target of targets) {
    await runBatch(target.url, upstreamUrl, warmup, Math.min(concurrency, 50), false);
    const result = await runBatch(target.url, upstreamUrl, total, concurrency, true);
    console.log(JSON.stringify({ target: target.name, ...result }));
  }
} finally {
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
}

async function runBatch(
  routerUrl: string,
  upstreamUrl: string,
  count: number,
  workers: number,
  measure: boolean,
) {
  let cursor = 0;
  let errors = 0;
  const latencies: number[] = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      const requestStarted = performance.now();
      try {
        const response = await fetch(`${routerUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-upstream-url": upstreamUrl,
            "x-upstream-authorization": "Bearer benchmark-placeholder",
          },
          body: JSON.stringify({
            model: "benchmark-model",
            max_tokens: 16,
            messages: [{ role: "user", content: "hello" }],
          }),
        });
        const body = await response.json() as any;
        if (!response.ok || body?.content?.[0]?.text !== "ok") errors += 1;
      } catch {
        errors += 1;
      }
      if (measure) latencies.push(performance.now() - requestStarted);
    }
  }));
  const elapsedMs = performance.now() - started;
  latencies.sort((left, right) => left - right);
  return {
    requests: count,
    concurrency: workers,
    errors,
    elapsed_ms: round(elapsedMs),
    requests_per_second: round(count * 1_000 / elapsedMs),
    latency_ms: {
      p50: round(percentile(latencies, 0.50)),
      p95: round(percentile(latencies, 0.95)),
      p99: round(percentile(latencies, 0.99)),
    },
  };
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  assert(Number.isSafeInteger(parsed) && parsed > 0, "benchmark counts must be positive integers");
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
