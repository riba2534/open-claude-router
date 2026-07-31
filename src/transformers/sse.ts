export interface DecodedSseEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

/**
 * Incrementally decodes Server-Sent Events.
 *
 * Event boundaries and data field folding follow the WHATWG event-stream
 * algorithm: LF, CRLF, and CR terminate lines, while multiple `data` fields in
 * one event are joined with a single LF.
 */
export class SseBlockDecoder {
  // Upper bound for one line (the partial we retain between pushes). SSE data
  // lines can legitimately be large — inline base64 payloads — but an upstream
  // that never sends a newline must fail the stream instead of buffering
  // forever.
  private static readonly MAX_BUFFERED_LINE = 16 * 1024 * 1024;
  // Bound a complete event as well as an individual line. Without this second
  // limit an upstream can bypass MAX_BUFFERED_LINE with an unbounded sequence
  // of small `data:` lines and no blank event terminator.
  private static readonly MAX_EVENT_CHARACTERS = 16 * 1024 * 1024;
  private static readonly MAX_EVENT_LINES = 65_536;

  private readonly decoder = new TextDecoder();
  // Partial-line accumulation. A chunk without a line terminator is appended
  // here in O(1) and only joined + scanned once a terminator (or EOF) arrives,
  // so a long line arriving across many chunks costs O(n) total — repeatedly
  // concatenating and re-scanning one growing string is quadratic and blocks
  // the event loop for seconds at a few megabytes.
  private pendingParts: string[] = [];
  private pendingLength = 0;
  // True when the retained partial ends with a CR whose matching LF may arrive
  // at the start of the next chunk.
  private pendingCr = false;
  private dataLines: string[] = [];
  private eventType: string | undefined;
  private lastEventId: string | undefined;
  private retry: number | undefined;
  private eventCharacters = 0;
  private eventLines = 0;

  push(chunk: Uint8Array): DecodedSseEvent[] {
    const decoded = this.decoder.decode(chunk, { stream: true });
    if (!decoded) return [];
    if (
      !this.pendingCr &&
      !decoded.includes("\n") &&
      !decoded.includes("\r")
    ) {
      this.pendingParts.push(decoded);
      this.pendingLength += decoded.length;
      this.assertBounded();
      return [];
    }
    return this.drainText(this.takeBuffered() + decoded, false);
  }

  finish(): DecodedSseEvent[] {
    const events = this.drainText(
      this.takeBuffered() + this.decoder.decode(),
      true,
    );
    // Compatibility extension: some OpenAI-compatible upstreams close after
    // the final data line without the blank line required to dispatch an SSE
    // event. Preserve that trailing block at EOF instead of dropping it.
    const trailingEvent = this.dispatchEvent();
    if (trailingEvent) {
      events.push(trailingEvent);
    }
    return events;
  }

  private takeBuffered(): string {
    if (this.pendingParts.length === 0) return "";
    const text =
      this.pendingParts.length === 1
        ? this.pendingParts[0]
        : this.pendingParts.join("");
    this.pendingParts = [];
    this.pendingLength = 0;
    return text;
  }

  private retainPartial(text: string): void {
    if (text) {
      this.pendingParts.push(text);
      this.pendingLength = text.length;
      this.pendingCr = text.endsWith("\r");
      this.assertBounded();
    } else {
      this.pendingCr = false;
    }
  }

  private assertBounded(): void {
    if (this.pendingLength > SseBlockDecoder.MAX_BUFFERED_LINE) {
      throw new Error(
        `SSE line exceeded ${SseBlockDecoder.MAX_BUFFERED_LINE} characters without a line terminator`,
      );
    }
  }

  private drainText(text: string, final: boolean): DecodedSseEvent[] {
    const events: DecodedSseEvent[] = [];
    let lineStart = 0;
    let index = 0;

    while (index < text.length) {
      const character = text[index];
      if (character === "\n") {
        this.processLine(text.slice(lineStart, index), events);
        index += 1;
        lineStart = index;
        continue;
      }

      if (character === "\r") {
        if (index + 1 === text.length && !final) {
          // A CR at the chunk boundary may be half of a CRLF; re-examine it
          // once the next chunk arrives.
          break;
        }

        this.processLine(text.slice(lineStart, index), events);
        index += text[index + 1] === "\n" ? 2 : 1;
        lineStart = index;
        continue;
      }

      index += 1;
    }

    let remainder = text.slice(lineStart);
    if (final && remainder) {
      this.processLine(remainder, events);
      remainder = "";
    }
    this.retainPartial(remainder);
    return events;
  }

  private processLine(line: string, events: DecodedSseEvent[]): void {
    if (line === "") {
      const event = this.dispatchEvent();
      if (event) {
        events.push(event);
      }
      return;
    }

    this.eventLines += 1;
    this.eventCharacters += line.length + 1;
    if (
      this.eventLines > SseBlockDecoder.MAX_EVENT_LINES ||
      this.eventCharacters > SseBlockDecoder.MAX_EVENT_CHARACTERS
    ) {
      throw new Error(
        `SSE event exceeded ${SseBlockDecoder.MAX_EVENT_CHARACTERS} characters or ${SseBlockDecoder.MAX_EVENT_LINES} lines without an event terminator`,
      );
    }

    if (line.startsWith(":")) {
      return;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex < 0 ? line : line.slice(0, colonIndex);
    let value = colonIndex < 0 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      this.dataLines.push(value);
      return;
    }

    if (field === "event") {
      this.eventType = value;
      return;
    }

    if (field === "id") {
      if (!value.includes("\0")) {
        this.lastEventId = value;
      }
      return;
    }

    if (field === "retry" && /^[0-9]+$/.test(value)) {
      this.retry = Number(value);
    }
  }

  private dispatchEvent(): DecodedSseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventType = undefined;
      this.eventCharacters = 0;
      this.eventLines = 0;
      return null;
    }

    const event: DecodedSseEvent = {
      data: this.dataLines.join("\n"),
      ...(this.eventType ? { event: this.eventType } : {}),
      ...(this.lastEventId !== undefined ? { id: this.lastEventId } : {}),
      ...(this.retry !== undefined ? { retry: this.retry } : {}),
    };
    this.dataLines = [];
    this.eventType = undefined;
    this.eventCharacters = 0;
    this.eventLines = 0;
    return event;
  }
}
