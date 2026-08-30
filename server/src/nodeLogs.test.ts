import assert from "node:assert/strict";
import { test } from "node:test";

import { splitJsonObjects } from "./nodeLogs";

test("切分背靠背的 JSON 对象", () => {
  const split = splitJsonObjects();
  const out = split('{"log":"a"}{"log":"b"}');
  assert.deepEqual(out, ['{"log":"a"}', '{"log":"b"}']);
});

test("对象被 chunk 边界切断时跨批缓存", () => {
  const split = splitJsonObjects();
  assert.deepEqual(split('{"log":"he'), []);
  assert.deepEqual(split('llo"}'), ['{"log":"hello"}']);
});

test("字符串里的花括号不参与配平", () => {
  const split = splitJsonObjects();
  const out = split('{"log":"{not an object}"}{"log":"ok"}');
  assert.deepEqual(out, ['{"log":"{not an object}"}', '{"log":"ok"}']);
  assert.equal(JSON.parse(out[0]).log, "{not an object}");
});

test("转义引号不会被当作字符串结束", () => {
  const split = splitJsonObjects();
  // 日志正文里常见 level="INFO" 这类带引号的内容。
  const raw = JSON.stringify({ log: 'say \\"hi\\" }' });
  const out = split(raw + raw);
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]).log, 'say \\"hi\\" }');
});

test("嵌套对象按顶层切分", () => {
  const split = splitJsonObjects();
  const out = split('{"status":{"code":0,"details":[]},"log":"x"}');
  assert.deepEqual(out, ['{"status":{"code":0,"details":[]},"log":"x"}']);
});

test("逐字节喂入也能正确切分", () => {
  const split = splitJsonObjects();
  const raw = '{"status":{"message":"success"},"log":"line1\\nline2"}{"log":"line3"}';
  const collected: string[] = [];
  for (const ch of raw) collected.push(...split(ch));
  assert.deepEqual(collected.map((s) => JSON.parse(s).log), [
    "line1\nline2",
    "line3",
  ]);
});

test("对象之间的空白被忽略", () => {
  const split = splitJsonObjects();
  const out = split('{"log":"a"}\n  {"log":"b"}\n');
  assert.deepEqual(out.map((s) => JSON.parse(s).log), ["a", "b"]);
});
