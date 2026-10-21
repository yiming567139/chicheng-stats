/**
 * Functional checks for the DSH 0.2.x compatibility fixes (dev-only, not shipped):
 *   1. sessionLogPath picks the newest generation (session.v4.jsonl.zstd) and legacy names;
 *   2. streamFirstTokenTime reads packed runs + raw chunks;
 *   3. createFold produces ttft/duration from a modern (v2+) event sequence.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "./lib/index.js";

const I = mod._internals;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// 1. sessionLogPath -----------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), "cstats-test-"));
for (const s of ["s1", "s2", "s3", "s4"]) await mkdir(join(dir, s), { recursive: true });
await writeFile(join(dir, "s1", "session.v4.jsonl.zstd"), "");
await writeFile(join(dir, "s1", "session.v3.jsonl.zstd"), "");
await writeFile(join(dir, "s2", "session.jsonl.zstd"), "");
await writeFile(join(dir, "s3", "session.v2.jsonl"), "");
await writeFile(join(dir, "s4", "other.txt"), "");
check("newest generation wins", await I.sessionLogPath(join(dir, "s1")), join(dir, "s1", "session.v4.jsonl.zstd"));
check("legacy zstd still found", await I.sessionLogPath(join(dir, "s2")), join(dir, "s2", "session.jsonl.zstd"));
check("legacy raw found", await I.sessionLogPath(join(dir, "s3")), join(dir, "s3", "session.v2.jsonl"));
check("no log -> null", await I.sessionLogPath(join(dir, "s4")), null);
check("missing dir -> null", await I.sessionLogPath(join(dir, "nope")), null);

// 2. streamFirstTokenTime -----------------------------------------------------
check("packed runs, first non-empty fragment", I.streamFirstTokenTime([
  { type: "reasoning-chunks", time0: 100, index: 0, dt: [5, 5], texts: ["", "abc"] },
  { type: "text-chunks", time0: 200, index: 0, dt: [10], texts: ["hi"] },
]), 105);
check("named tool-call run starts at time0", I.streamFirstTokenTime([
  { type: "tool-call-chunks", time0: 500, index: 0, dt: [7], id: "t1", name: "pw", args: ["{"] },
]), 500);
check("unnamed tool run, first non-empty arg", I.streamFirstTokenTime([
  { type: "tool-call-chunks", time0: 900, index: 0, dt: [3], id: "t2", args: ["", "{"] },
]), 903);
check("raw content chunk time", I.streamFirstTokenTime([
  { type: "chunk", time: 42, chunk: { type: "block-start", index: 0, blockType: "text" } },
  { type: "chunk", time: 77, chunk: { type: "text-delta", index: 0, text: "x" } },
]), 77);
check("empty stream", I.streamFirstTokenTime([]), null);
check("non-array stream", I.streamFirstTokenTime(undefined), null);

// 3. fold on a modern-format event sequence ------------------------------------
const fold = I.createFold();
const base = Date.now() - 60000;
const events = [
  { type: "request/header", time: base + 10, seq: 1, data: { header: { config: { model: "deepseek-chat", provider: "deepseek" } }, reason: "turn" } },
  { type: "step/start", time: base + 20, seq: 2, data: { turn: 1, step: 1 } },
  { type: "assistant/message", time: base + 1120, seq: 3, data: {
      turn: 1, step: 1,
      message: { role: "assistant", content: "hi" },
      stream: [{ type: "text-chunks", time0: base + 220, index: 0, dt: [10], texts: ["h", "i"] }],
      usage: { inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 5 },
  } },
  { type: "step/end", time: base + 1130, seq: 4, data: { turn: 1, step: 1 } },
];
for (const e of events) fold.ingest("sess-1", e);
const rec = fold.allRecords()[0];
check("record emitted", Boolean(rec), true);
check("ttft from embedded stream", rec?.ttft, 200);
check("duration from step start", rec?.duration, 1100);
check("model from request/header", rec?.model, "deepseek-chat");
check("input", rec?.input, 10);
check("cacheRead", rec?.cacheRead, 30);
check("output", rec?.output, 5);
const snap = fold.snapshot();
const day = Object.keys(snap.days)[0];
check("day bucket tokens", snap.days[day]?.tokens, 45);
check("day bucket requests", snap.days[day]?.requests, 1);

// 4. legacy fold path still works (v0/v1 logs with assistant/chunk) ------------
const foldLegacy = I.createFold();
foldLegacy.ingest("sess-2", { type: "step/start", time: base, seq: 1, data: { turn: 1, step: 1 } });
foldLegacy.ingest("sess-2", { type: "assistant/chunk", time: base + 150, seq: 2, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "a" } } });
foldLegacy.ingest("sess-2", { type: "assistant/chunk", time: base + 400, seq: 3, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } } } });
const recLegacy = foldLegacy.allRecords()[0];
check("legacy ttft via assistant/chunk", recLegacy?.ttft, 150);
check("legacy usage via assistant/chunk", recLegacy?.output, 2);

await rm(dir, { recursive: true, force: true });
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
