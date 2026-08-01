import {
  appendFile,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const LOG_FILE_PATTERN = /^model-interactions-(\d{4}-\d{2}-\d{2})\.ndjson$/;

export type ModelInteractionLogMode = "full" | "metadata" | "off";

export interface ModelInteractionLogConfig {
  mode: ModelInteractionLogMode;
  directory: string;
  retentionDays: number;
  maxBodyBytes: number;
  cleanupIntervalMs?: number;
}

interface DiagnosticLogger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface ModelInteractionStart {
  requestId: string;
  upstreamUrl: string;
  format: string;
  model?: unknown;
  stream: boolean;
}

export interface ModelInteractionExchange extends ModelInteractionStart {
  startedAtMs: number;
}

interface BodyCapture {
  body?: unknown;
  body_text?: string;
  body_bytes: number;
  body_truncated: boolean;
}

function parseInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
  minimum: number,
): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function loadModelInteractionLogConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ModelInteractionLogConfig {
  const rawMode = (env.OCR_MODEL_LOG_MODE ?? "full").trim().toLowerCase();
  if (rawMode !== "full" && rawMode !== "metadata" && rawMode !== "off") {
    throw new Error("OCR_MODEL_LOG_MODE must be full, metadata, or off");
  }

  return {
    mode: rawMode,
    directory: path.resolve(cwd, env.OCR_MODEL_LOG_DIR?.trim() || "logs"),
    // 0 is the obvious way to ask for "keep nothing", and `enabled` already
    // treats it as off. Rejecting it would kill the process at startup over a
    // value whose intent is unambiguous.
    retentionDays: parseInteger(
      env.OCR_MODEL_LOG_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
      "OCR_MODEL_LOG_RETENTION_DAYS",
      0,
    ),
    maxBodyBytes: parseInteger(
      env.OCR_MODEL_LOG_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
      "OCR_MODEL_LOG_MAX_BODY_BYTES",
      1,
    ),
  };
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function sanitizeUpstreamUrlForLogging(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid upstream URL]";
  }
}

function serializeRequestBody(value: unknown): Uint8Array {
  try {
    return Buffer.from(JSON.stringify(value) ?? "null", "utf8");
  } catch (error: any) {
    return Buffer.from(
      JSON.stringify({
        serialization_error: error?.message ?? String(error),
      }),
      "utf8",
    );
  }
}

function captureBody(
  bytes: Uint8Array,
  totalBytes: number,
  contentType: string,
): BodyCapture {
  const truncated = totalBytes > bytes.byteLength;
  const text = Buffer.from(bytes).toString("utf8");
  const capture: BodyCapture = {
    body_bytes: totalBytes,
    body_truncated: truncated,
  };

  if (
    !truncated &&
    contentType.toLowerCase().includes("json") &&
    text.length > 0
  ) {
    try {
      capture.body = JSON.parse(text);
      return capture;
    } catch {
      // Preserve malformed JSON as text. The logger observes protocol bytes;
      // it does not reinterpret or reject an upstream response.
    }
  }

  capture.body_text = text;
  return capture;
}

function selectedResponseHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of [
    "content-type",
    "content-length",
    "request-id",
    "x-request-id",
    "openai-request-id",
  ]) {
    const value = headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

/**
 * Append-only, daily-rotated logs of the exact model-facing protocol boundary.
 * Writes are deliberately fail-open: a logging filesystem failure must never
 * change request forwarding, response bytes, retry ownership, or status codes.
 */
export class ModelInteractionLogger {
  private readonly clock: () => Date;
  private readonly cleanupIntervalMs: number;
  private pending: Promise<void> = Promise.resolve();
  private cleanupTimer?: NodeJS.Timeout;
  private lastReportedErrorAt = 0;

  constructor(
    readonly config: ModelInteractionLogConfig,
    private readonly diagnosticLogger?: DiagnosticLogger,
    clock: () => Date = () => new Date(),
  ) {
    this.clock = clock;
    this.cleanupIntervalMs =
      config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  }

  get enabled(): boolean {
    return this.config.mode !== "off" && this.config.retentionDays > 0;
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      this.diagnosticLogger?.info(
        "model interaction logging disabled",
      );
      return;
    }

    try {
      await mkdir(this.config.directory, { recursive: true });
      await this.cleanupExpiredFiles();
    } catch (error) {
      this.reportError(error, "initialize");
    }

    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.enqueue(() => this.cleanupExpiredFiles());
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref();
    }

    this.diagnosticLogger?.info(
      {
        mode: this.config.mode,
        directory: this.config.directory,
        retention_days: this.config.retentionDays,
        max_body_bytes: this.config.maxBodyBytes,
      },
      "model interaction logging enabled",
    );
  }

  begin(
    fields: ModelInteractionStart,
    outboundBody: unknown,
  ): ModelInteractionExchange {
    const now = this.clock();
    const exchange: ModelInteractionExchange = {
      ...fields,
      upstreamUrl: sanitizeUpstreamUrlForLogging(fields.upstreamUrl),
      startedAtMs: now.getTime(),
    };
    if (!this.enabled) return exchange;

    const serialized = serializeRequestBody(outboundBody);
    const captured = serialized.subarray(
      0,
      Math.min(serialized.byteLength, this.config.maxBodyBytes),
    );
    const entry: Record<string, unknown> = {
      timestamp: now.toISOString(),
      event: "model_request",
      request_id: exchange.requestId,
      upstream_url: exchange.upstreamUrl,
      format: exchange.format,
      model: exchange.model,
      stream: exchange.stream,
    };
    if (this.config.mode === "full") {
      Object.assign(
        entry,
        captureBody(
          captured,
          serialized.byteLength,
          "application/json",
        ),
      );
    } else {
      entry.body_bytes = serialized.byteLength;
    }
    this.append(entry);
    return exchange;
  }

  recordTransportError(
    exchange: ModelInteractionExchange,
    error: unknown,
  ): void {
    if (!this.enabled) return;
    const now = this.clock();
    this.append({
      timestamp: now.toISOString(),
      event: "model_transport_error",
      request_id: exchange.requestId,
      upstream_url: exchange.upstreamUrl,
      format: exchange.format,
      model: exchange.model,
      stream: exchange.stream,
      duration_ms: Math.max(0, now.getTime() - exchange.startedAtMs),
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  captureResponse(
    exchange: ModelInteractionExchange,
    response: Response,
  ): Response {
    if (!this.enabled) return response;

    const headers = selectedResponseHeaders(response.headers);
    if (!response.body) {
      this.recordResponse(
        exchange,
        response.status,
        headers,
        new Uint8Array(),
        0,
        true,
      );
      return response;
    }

    const source = response.body;
    let captured = Buffer.alloc(0);
    let capturedBytes = 0;
    let totalBytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finalized = false;

    const finalize = (
      complete: boolean,
      error?: unknown,
      bodyCancelled = false,
    ) => {
      if (finalized) return;
      finalized = true;
      this.recordResponse(
        exchange,
        response.status,
        headers,
        captured.subarray(0, capturedBytes),
        totalBytes,
        complete,
        error,
        bodyCancelled,
      );
    };

    const tapped = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          reader ??= source.getReader();
          const { done, value } = await reader.read();
          if (done) {
            finalize(true);
            controller.close();
            return;
          }

          totalBytes += value.byteLength;
          if (
            this.config.mode === "full" &&
            capturedBytes < this.config.maxBodyBytes
          ) {
            const remaining = this.config.maxBodyBytes - capturedBytes;
            const part = value.subarray(0, Math.min(value.byteLength, remaining));
            const required = capturedBytes + part.byteLength;
            if (required > captured.byteLength) {
              const capacity = Math.min(
                this.config.maxBodyBytes,
                Math.max(required, Math.max(4096, captured.byteLength * 2)),
              );
              const grown = Buffer.allocUnsafe(capacity);
              captured.copy(grown, 0, 0, capturedBytes);
              captured = grown;
            }
            captured.set(part, capturedBytes);
            capturedBytes += part.byteLength;
          }
          controller.enqueue(value);
        } catch (error) {
          finalize(false, error);
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          if (reader) {
            await reader.cancel(reason);
          } else {
            await source.cancel(reason);
          }
        } finally {
          // Protocol transformers intentionally stop after a terminal SSE
          // marker, while a disconnected client also cancels consumption.
          // Record the transport fact without guessing which business-level
          // outcome caused it or mislabeling a normal terminal as an error.
          finalize(false, undefined, true);
        }
      },
    });

    try {
      return new Response(tapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      // Construction should only fail for an invalid Response invariant. The
      // source is still unlocked because getReader() is deferred until pull.
      finalize(false, error);
      return response;
    }
  }

  async cleanupExpiredFiles(): Promise<void> {
    if (!this.enabled) return;
    const entries = await readdir(this.config.directory, {
      withFileTypes: true,
    });
    const now = this.clock();
    const startOfTodayUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const cutoff =
      startOfTodayUtc - (this.config.retentionDays - 1) * DAY_MS;

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() && !entry.isSymbolicLink()) return;
        const match = LOG_FILE_PATTERN.exec(entry.name);
        if (!match) return;
        const fileDate = Date.parse(`${match[1]}T00:00:00.000Z`);
        if (!Number.isFinite(fileDate) || fileDate >= cutoff) return;
        await rm(path.join(this.config.directory, entry.name), { force: true });
      }),
    );
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.flush();
  }

  private recordResponse(
    exchange: ModelInteractionExchange,
    status: number,
    headers: Record<string, string>,
    captured: Uint8Array,
    totalBytes: number,
    complete: boolean,
    error?: unknown,
    bodyCancelled = false,
  ): void {
    const now = this.clock();
    const entry: Record<string, unknown> = {
      timestamp: now.toISOString(),
      event: "model_response",
      request_id: exchange.requestId,
      upstream_url: exchange.upstreamUrl,
      format: exchange.format,
      model: exchange.model,
      stream: exchange.stream,
      status,
      headers,
      duration_ms: Math.max(0, now.getTime() - exchange.startedAtMs),
      complete,
    };

    if (bodyCancelled) entry.body_cancelled = true;

    if (this.config.mode === "full") {
      Object.assign(
        entry,
        captureBody(
          captured,
          totalBytes,
          headers["content-type"] ?? "",
        ),
      );
    } else {
      entry.body_bytes = totalBytes;
    }

    if (error !== undefined) {
      entry.read_error = {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.append(entry);
  }

  private append(entry: Record<string, unknown>): void {
    this.enqueue(async () => {
      await mkdir(this.config.directory, { recursive: true });
      const timestamp = new Date(String(entry.timestamp));
      const fileName = `model-interactions-${utcDate(timestamp)}.ndjson`;
      await appendFile(
        path.join(this.config.directory, fileName),
        `${JSON.stringify(entry)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.pending = this.pending.then(operation).catch((error) => {
      this.reportError(error, "write");
    });
  }

  private reportError(error: unknown, operation: string): void {
    const now = Date.now();
    if (now - this.lastReportedErrorAt < 60_000) return;
    this.lastReportedErrorAt = now;
    this.diagnosticLogger?.error(
      {
        err: error,
        operation,
        directory: this.config.directory,
      },
      "model interaction logging failed; request forwarding is unaffected",
    );
  }
}
