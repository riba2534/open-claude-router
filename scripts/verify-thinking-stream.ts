/**
 * 流式转换协议回归测试：reasoning(thinking) 与 content/tool 各种排布下，
 * 产出的 Anthropic SSE 必须满足协议约束。
 *
 * 覆盖场景（修复前 c/d 必红）：
 *   a) reasoning → content            先想后答（线性）
 *   b) reasoning → tool_calls         想完调工具
 *   c) reasoning → content → reasoning → content   交错（qwen 视觉流形态）
 *   d) reasoning → finish             只想不答
 *
 * 协议断言：
 *   - content_block_start/stop 配对，不重复 start、不 stop 未开块
 *   - thinking_delta / signature_delta 只允许发往 thinking 块
 *   - text_delta 只允许发往 text 块；input_json_delta 只允许 tool_use 块
 *   - thinking 块 stop 之前必须已出现 signature_delta
 *   - 流结束时所有块已封口
 *
 * 运行：npx tsx scripts/verify-thinking-stream.ts
 */
import { AnthropicTransformer } from "../src/transformers/anthropic";

type Delta = Record<string, unknown>;

function openaiChunk(delta: Delta, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const SCENARIOS: Record<string, string[]> = {
  "a) reasoning→content": [
    openaiChunk({ reasoning_content: "thinking part 1 " }),
    openaiChunk({ reasoning_content: "thinking part 2" }),
    openaiChunk({ content: "answer part 1 " }),
    openaiChunk({ content: "answer part 2" }),
    openaiChunk({}, "stop"),
    "data: [DONE]\n\n",
  ],
  "b) reasoning→tool_calls": [
    openaiChunk({ reasoning_content: "let me check" }),
    openaiChunk({
      tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } },
      ],
    }),
    openaiChunk({
      tool_calls: [{ index: 0, function: { arguments: '{"q":"hi"}' } }],
    }),
    openaiChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ],
  "c) reasoning↔content 交错": [
    openaiChunk({ reasoning_content: "think round 1" }),
    openaiChunk({ content: "partial answer " }),
    openaiChunk({ reasoning_content: "think round 2" }),
    openaiChunk({ content: "final answer" }),
    openaiChunk({}, "stop"),
    "data: [DONE]\n\n",
  ],
  "d) reasoning→finish（只想不答）": [
    openaiChunk({ reasoning_content: "thinking only" }),
    openaiChunk({}, "stop"),
    "data: [DONE]\n\n",
  ],
};

function toStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

interface SseEvent {
  type: string;
  index?: number;
  delta?: { type?: string };
  content_block?: { type?: string };
}

async function collectEvents(resp: Response): Promise<SseEvent[]> {
  const text = await resp.text();
  const events: SseEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    events.push(JSON.parse(payload) as SseEvent);
  }
  return events;
}

/** Anthropic SSE 协议状态机断言。返回违规清单（空 = 合法）。 */
function checkProtocol(events: SseEvent[]): string[] {
  const errors: string[] = [];
  // index -> { type, signed, open }
  const blocks = new Map<number, { type: string; signed: boolean; open: boolean }>();
  const deltaTarget: Record<string, string> = {
    thinking_delta: "thinking",
    signature_delta: "thinking",
    text_delta: "text",
    input_json_delta: "tool_use",
  };

  for (const ev of events) {
    if (ev.type === "content_block_start") {
      const idx = ev.index!;
      if (blocks.get(idx)?.open) errors.push(`重复 start: index ${idx}`);
      blocks.set(idx, { type: ev.content_block?.type ?? "?", signed: false, open: true });
    } else if (ev.type === "content_block_delta") {
      const idx = ev.index!;
      const blk = blocks.get(idx);
      const dtype = ev.delta?.type ?? "?";
      if (!blk?.open) {
        errors.push(`delta(${dtype}) 发往未打开的块: index ${idx}`);
        continue;
      }
      const want = deltaTarget[dtype];
      if (want && blk.type !== want) {
        errors.push(`delta(${dtype}) 发往 ${blk.type} 块（应为 ${want}）: index ${idx}`);
      }
      if (dtype === "signature_delta") blk.signed = true;
    } else if (ev.type === "content_block_stop") {
      const idx = ev.index!;
      const blk = blocks.get(idx);
      if (!blk?.open) {
        errors.push(`stop 未打开的块: index ${idx}`);
        continue;
      }
      if (blk.type === "thinking" && !blk.signed) {
        errors.push(`thinking 块 stop 前缺 signature_delta: index ${idx}`);
      }
      blk.open = false;
    }
  }
  for (const [idx, blk] of blocks) {
    if (blk.open) errors.push(`流结束时块未封口: index ${idx} (${blk.type})`);
  }
  return errors;
}

async function main() {
  const transformer = new AnthropicTransformer();
  transformer.logger = { debug() {}, info() {}, warn() {}, error() {} };

  let failed = 0;
  for (const [name, chunks] of Object.entries(SCENARIOS)) {
    const upstream = new Response(toStream(chunks), {
      headers: { "Content-Type": "text/event-stream" },
    });
    const out = await transformer.transformResponseIn(upstream, {
      req: { id: "verify" },
    } as never);
    const events = await collectEvents(out);
    const errors = checkProtocol(events);
    if (errors.length === 0) {
      console.log(`  ok  ${name}`);
    } else {
      failed++;
      console.error(`FAIL  ${name}`);
      for (const e of errors) console.error(`        - ${e}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} scenario(s) failed`);
    process.exit(1);
  }
  console.log("\nall scenarios passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
