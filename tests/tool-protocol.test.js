import test from "node:test";
import assert from "node:assert/strict";
import { validateChatRequest } from "../server/native-chat.js";
import { AppError } from "../server/provider.js";

const call = {
  id: "call-1", type: "function",
  function: { name: "example", arguments: "{}" },
};
const result = { role: "tool", tool_call_id: call.id, content: "result" };

test("nullable assistant tool_calls round-trip unchanged as no calls", () => {
  const body = { model: "strategy", messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "draft", tool_calls: null },
    { role: "user", content: "continue" },
  ] };
  const snapshot = structuredClone(body);
  assert.equal(validateChatRequest(body), body);
  assert.deepEqual(body, snapshot);
});

test("malformed history calls are client errors rather than TypeErrors", () => {
  for (const bad of [null, 0, "call", [], {}, { ...call, id: 123 },
    { ...call, function: null }, { ...call, function: { name: "", arguments: "{}" } }]) {
    const body = { model: "strategy", messages: [
      { role: "assistant", content: null, tool_calls: [bad] }, result,
    ] };
    assert.throws(() => validateChatRequest(body), error =>
      error instanceof AppError && error.status === 400 && /工具调用格式/.test(error.message));
  }
});

test("duplicate unresolved IDs cannot be satisfied by one tool result", () => {
  const body = { model: "strategy", messages: [
    { role: "assistant", content: null, tool_calls: [call, structuredClone(call)] }, result,
  ] };
  assert.throws(() => validateChatRequest(body), error =>
    error instanceof AppError && error.status === 400 && /重复/.test(error.message));
});

test("completed batches and historical tool error arguments remain unchanged", () => {
  const historical = { ...call, function: { name: "old_tool", arguments: "unfinished JSON" } };
  const body = { model: "strategy", messages: [
    { role: "assistant", content: null, tool_calls: [historical] },
    { ...result, content: "The client reported an argument error" },
    { role: "assistant", content: null, tool_calls: [call] }, result,
  ] };
  const snapshot = structuredClone(body);
  assert.equal(validateChatRequest(body), body);
  assert.deepEqual(body, snapshot);
});
