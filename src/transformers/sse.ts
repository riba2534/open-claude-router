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
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private dataLines: string[] = [];
  private eventType: string | undefined;
  private lastEventId: string | undefined;
  private retry: number | undefined;

  push(chunk: Uint8Array): DecodedSseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drainLines(false);
  }

  finish(): DecodedSseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drainLines(true);
    // Compatibility extension: some OpenAI-compatible upstreams close after
    // the final data line without the blank line required to dispatch an SSE
    // event. Preserve that trailing block at EOF instead of dropping it.
    const trailingEvent = this.dispatchEvent();
    if (trailingEvent) {
      events.push(trailingEvent);
    }
    return events;
  }

  private drainLines(final: boolean): DecodedSseEvent[] {
    const events: DecodedSseEvent[] = [];
    let lineStart = 0;
    let index = 0;

    while (index < this.buffer.length) {
      const character = this.buffer[index];
      if (character === "\n") {
        this.processLine(this.buffer.slice(lineStart, index), events);
        index += 1;
        lineStart = index;
        continue;
      }

      if (character === "\r") {
        if (index + 1 === this.buffer.length && !final) {
          break;
        }

        this.processLine(this.buffer.slice(lineStart, index), events);
        index += this.buffer[index + 1] === "\n" ? 2 : 1;
        lineStart = index;
        continue;
      }

      index += 1;
    }

    this.buffer = this.buffer.slice(lineStart);
    if (final && this.buffer) {
      this.processLine(this.buffer, events);
      this.buffer = "";
    }
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
    return event;
  }
}
