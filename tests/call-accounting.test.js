import test from "node:test";
import assert from "node:assert/strict";
import { recordModelCall, totals } from "../server/call-accounting.js";
import { NativeChatEngine } from "../server/native-chat.js";
import { AppError, failureDetails } from "../server/provider.js";

test("parallel success and failure retain known details without a false complete total", async () => {
  const run = { calls: [] };
  const model = { id: "test", name: "Test model" };
  const result = { usage: { input: 20, output: 10, source: "provider" }, cost: 0.001, latencyMs: 1 };
  const secretError = new Error("private-test-key");
  const attempts = await Promise.allSettled([
    recordModelCall(run, model, "executor", async () => result),
    recordModelCall(run, model, "executor", async () => { throw secretError; }),
  ]);
  assert.deepEqual(attempts.map(attempt => attempt.status), ["fulfilled", "rejected"]);
  assert.equal(attempts[1].reason, secretError);
  assert.deepEqual(run.calls[0].usage, result.usage);
  assert.equal(run.calls[0].cost, 0.001);
  assert.equal(run.calls[1].status, "failed");
  assert(Number.isFinite(run.calls[1].latencyMs));
  assert.deepEqual(run.totals, { input: null, output: null, cost: null, calls: 2 });
  assert(!JSON.stringify(run).includes("private-test-key"));
});

test("malformed usage and non-finite prices cannot become a known zero or JSON null cost", () => {
  for (const usage of [undefined, { source: "provider", input: null, output: null },
    { source: "provider", input: -1, output: 0 },
    { source: "unavailable", input: 0, output: 0 }]) {
    const value = totals([{ usage, cost: Infinity }]);
    assert.deepEqual(value, { input: null, output: null, cost: null, calls: 1 });
  }
});

test("pre-cancelled requests and local decryption failures do not count an upstream attempt", async () => {
  const model = { id: "test", name: "Test", kind: "live", maxTokens: 2048 };
  const run = { calls: [], requestedReasoningEffort: "medium" };
  let decrypted = 0;
  const engine = new NativeChatEngine({
    decrypt() { decrypted++; throw new Error("local decryption failed"); },
    save() { assert.fail("No upstream attempt should have been recorded"); },
  }, new Map());
  await assert.rejects(engine.invoke(run, model, [], {}, "executor", AbortSignal.abort()), /取消/);
  assert.equal(decrypted, 0);
  await assert.rejects(engine.invoke(run, model, [], {}, "executor"), /decryption/);
  assert.equal(decrypted, 1);
  assert.equal(run.calls.length, 0);
});

test("only fixed diagnostic labels are persisted on failed calls", async () => {
  const run = { calls: [] };
  const error = Object.assign(new AppError("模型调用超时。", 502), {
    failureKind: "timeout", failurePhase: "body", cause: new Error("private-test-key"),
  });
  await assert.rejects(recordModelCall(run, { id: "test", name: "Test" }, "executor", async () => { throw error; }));
  assert.equal(run.calls[0].failureKind, "timeout");
  assert.equal(run.calls[0].failurePhase, "body");
  assert(!JSON.stringify(run).includes("private-test-key"));
  assert.deepEqual(failureDetails({ failureKind: "private-test-key", failurePhase: "private-test-key" }), {});
});
