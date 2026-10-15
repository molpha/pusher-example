import assert from "node:assert/strict";
import { test } from "node:test";
import { SubmitQueue } from "../src/queue.js";

const q = (over: Partial<ConstructorParameters<typeof SubmitQueue>[0]> = {}) =>
  new SubmitQueue<string>({ mode: "all", maxAgeMs: 10_000, maxBacklog: 100, ...over });

test("sorts out-of-order rounds by timestamp and batches oldest first", () => {
  const s = q();
  s.add(300, "c", 1000);
  s.add(100, "a", 1000);
  s.add(200, "b", 1000);
  const batch = s.take(2, 1000);
  assert.deepEqual(batch.map((i) => i.value), ["a", "b"]);
  assert.deepEqual(s.take(2, 1000).map((i) => i.value), ["c"]);
});

test("a round older than one already sent is dropped as late", () => {
  const s = q();
  s.add(200, "b", 1000);
  s.take(5, 1000);
  assert.equal(s.add(100, "a", 1000), false);
  assert.equal(s.drops.late, 1);
  assert.equal(s.add(300, "c", 1000), true);
});

test("duplicate timestamps are dropped", () => {
  const s = q();
  s.add(100, "a", 1000);
  assert.equal(s.add(100, "a2", 1000), false);
  assert.equal(s.drops.duplicate, 1);
});

test("expired updates are dropped before sending", () => {
  const s = q({ maxAgeMs: 500 });
  s.add(100, "old", 1000);
  s.add(900, "new", 1000);
  const batch = s.take(5, 1000);
  assert.deepEqual(batch.map((i) => i.value), ["new"]);
  assert.equal(s.drops.expired, 1);
});

test("latest mode sends only the newest", () => {
  const s = q({ mode: "latest" });
  for (const ts of [100, 200, 300]) s.add(ts, String(ts), 1000);
  assert.deepEqual(s.take(5, 1000).map((i) => i.value), ["300"]);
  assert.equal(s.drops.superseded, 2);
});

test("backlog cap drops the oldest", () => {
  const s = q({ maxBacklog: 2 });
  for (const ts of [100, 200, 300, 400]) s.add(ts, String(ts), 1000);
  assert.deepEqual(s.take(5, 1000).map((i) => i.value), ["300", "400"]);
  assert.equal(s.drops.backlog, 2);
});

test("requeue after a transient failure puts items back and lowers the high-water mark", () => {
  const s = q();
  s.add(100, "a", 1000);
  s.add(200, "b", 1000);
  const batch = s.take(5, 1000);
  s.add(300, "c", 1000);
  assert.equal(s.requeue(batch, 3), 0);
  assert.deepEqual(s.take(5, 1000).map((i) => i.value), ["a", "b", "c"]);
});

test("requeue gives up after maxAttempts", () => {
  const s = q();
  s.add(100, "a", 1000);
  let batch = s.take(5, 1000);
  assert.equal(s.requeue(batch, 2), 0);
  batch = s.take(5, 1000);
  assert.equal(s.requeue(batch, 2), 1);
  assert.equal(s.length, 0);
});

test("after a landed batch a resend is no longer possible", () => {
  const s = q();
  s.add(100, "a", 1000);
  const batch = s.take(5, 1000);
  s.landedBatch(batch);
  assert.equal(s.newestLanded, 100);
  assert.equal(s.add(100, "a", 1000), false);
});
