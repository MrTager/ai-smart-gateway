import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createApplication } from "../server/index.js";
import { Store } from "../server/store.js";
import { validateStrategy } from "../server/strategy.js";
import { currentTask, simpleTask, decisionContext, taskFingerprint, toolSignature } from "../server/decision-routing.js";

const tools = [{ type: "function", function: { name: "run_step", description: "Run a checked step", parameters: { type: "object" } } }];
const call = (id, step = id) => ({ id, type: "function", function: { name: "run_step", arguments: JSON.stringify({ step }) } });
function reply(res, content, toolCalls) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    finish_reason: toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
}
async function fixture(t, handler, strategy = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-decision-test-"));
  const upstream = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    const planning = body.messages[0]?.content.includes("模型路由规划器");
    await handler(body, res, planning);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const app = await createApplication({ directory });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method,
      headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    await Promise.all([...app.engine.active.values()]);
    app.server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => app.server.close(r)), new Promise(r => upstream.close(r))]);
    await rm(directory, { recursive: true, force: true });
  });
  for (const model of ["openai/gpt-6.1-sol", "openai/gpt-5.6-luna--fast", "kimi-code/k3.1-pro-highspeed"]) {
    assert.equal((await request("/api/models", "POST", { name: model, model, kind: "live",
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, maxTokens: 4096, contextWindow: 128000 })).status, 201);
  }
  const models = app.store.state.models.filter(m => m.kind === "live");
  assert.equal((await request("/api/strategy", "PUT", { ...app.store.state.strategy,
    plannerId: models[0].id, executorIds: [models[1].id], review: false, ...strategy })).status, 200);
  return { ...app, request, models, directory,
    chat: (messages, extra = {}) => request("/v1/chat/completions", "POST", { model: "strategy", messages, tools, ...extra }),
    latest: () => app.store.state.runs[0] };
}

test("short technical requests need decisions while exact greetings and weather can skip", () => {
  for (const text of ["优化登录流程", "再看下怎么优化下", "修复超时", "分析天气服务的缓存代码", "审计合同", "plan a migration"])
    assert.equal(simpleTask(text), false, text);
  for (const text of ["hello", "你好！", "杭州天气", "What is the time?"])
    assert.equal(simpleTask(text), true, text);
  assert.equal(simpleTask("优化登录流程", "initial"), true);
});

test("decision evidence includes the task tail and notices do not displace the goal", () => {
  const task = "设计迁移方案。" + "要求".repeat(1500) + "最后必须验证回滚。";
  const messages = [{ role: "system", content: "Preserve permissions." }, { role: "user", content: task },
    { role: "user", content: "<system-reminder data-role=\"user-context\">Environment only</system-reminder>" }];
  assert.equal(currentTask(messages), task);
  const context = JSON.parse(decisionContext({ messages, tools }, { trigger: "new-task", candidates: [], fits: () => true }).serialized);
  assert.equal(context.task, task);
  assert.match(context.instructions, /Preserve permissions/);
  assert.equal(context.availableTools[0].description, "Run a checked step");
  const large = decisionContext({ messages: [{ role: "user", content: "begin" + "\\\"".repeat(100000) + "END_GOAL" }], tools },
    { trigger: "new-task", candidates: [], fits: () => true });
  assert(large.serialized.length <= 64000);
  assert.match(JSON.parse(large.serialized).task, /END_GOAL$/);
  assert.equal(large.metadata.taskTruncated, true);
  const largeId = decisionContext({ messages: [{ role: "tool", tool_call_id: "id".repeat(100000), content: "done" }], tools },
    { trigger: "untracked-continuation", candidates: [], fits: () => true });
  assert(largeId.serialized.length <= 64000);
});

test("supervised is the default and native planning honors the configured Sol and planning preference", async t => {
  let decisions = 0;
  const app = await fixture(t, (body, res, planning) => {
    if (planning) {
      decisions++;
      assert.equal(body.model, "openai/gpt-6.1-sol");
      assert.match(body.messages[0].content, /必须先验证回滚/);
      return reply(res, '{"executorIndex":0,"plan":"Check the rollback first."}');
    }
    assert.equal(body.model, "openai/gpt-5.6-luna--fast");
    assert.match(body.messages[0].content, /Check the rollback first/);
    reply(res, "done");
  }, { plannerPrompt: "必须先验证回滚" });
  assert.equal(app.store.state.strategy.decisionMode, "supervised");
  assert.equal((await app.chat([{ role: "user", content: "优化登录流程" }])).status, 200);
  assert.equal(decisions, 1);
  assert.deepEqual(app.latest().calls.map(c => c.role), ["planner", "executor"]);
  assert.equal(app.latest().decision.trigger, "new-task");
  assert.match(app.latest().summary, /已调用决策模型/);
});

test("normal tool rounds retain advice and protocol and Sol reviews after four rounds", async t => {
  let decisions = 0, executions = 0;
  let messages = [{ role: "system", content: "User controls tool permissions." }, { role: "user", content: "优化登录流程" }];
  const app = await fixture(t, (body, res, planning) => {
    if (planning) {
      decisions++;
      const context = JSON.parse(body.messages[1].content);
      if (decisions === 2) {
        assert.equal(context.trigger, "periodic-review");
        assert(context.recentMessages.some(m => m.role === "tool"));
        assert.equal(context.previousDecision.plan, "Keep the rollback check.");
      }
      return reply(res, '{"executorIndex":0,"plan":"Keep the rollback check."}');
    }
    assert.deepEqual(body.messages.slice(1), messages);
    assert.deepEqual(body.tools, tools);
    assert.equal(body.tool_choice, "required");
    assert.equal(body.parallel_tool_calls, false);
    assert.match(body.messages[0].content, /Keep the rollback check/);
    reply(res, null, [call("round-" + ++executions)]);
  });
  for (let round = 0; round <= 4; round++) {
    const result = await app.chat(messages, { tool_choice: "required", parallel_tool_calls: false });
    assert.equal(result.status, 200);
    if (round > 0 && round < 4) assert.equal(app.latest().decision.invoked, false);
    const assistant = result.body.choices[0].message;
    messages = [...messages, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "step succeeded" }];
  }
  assert.equal(decisions, 2);
  assert.equal(executions, 5);
  assert.equal(app.latest().decision.trigger, "periodic-review");
  assert.equal(app.latest().decision.roundsSinceDecision, 0);
});

test("tool failure triggers an immediate decision and Sol can take over with the original results", async t => {
  let decisions = 0, executions = 0;
  const app = await fixture(t, (body, res, planning) => {
    if (planning) {
      if (++decisions === 2) {
        const context = JSON.parse(body.messages[1].content);
        assert.equal(context.trigger, "tool-failure");
        assert(context.recentMessages.some(m => m.content.includes('"exit_code":1')));
        return reply(res, '{"usePlanner":true,"plan":"Inspect the failed verification."}');
      }
      return reply(res, '{"executorIndex":0,"plan":"Verify the login."}');
    }
    if (++executions === 1) return reply(res, null, [call("verify")]);
    assert.equal(body.model, "openai/gpt-6.1-sol");
    assert.equal(body.messages.at(-1).tool_call_id, "verify");
    reply(res, "Failure inspected.");
  });
  const messages = [{ role: "user", content: "修复登录异常" }];
  const first = await app.chat(messages);
  const result = await app.chat([...messages, first.body.choices[0].message,
    { role: "tool", tool_call_id: "verify", content: '{"exit_code":1,"stderr":"test failed"}' }]);
  assert.equal(result.status, 200);
  assert.equal(decisions, 2);
  assert.equal(app.latest().routeReason, "planner-self-execution");
  assert.equal(app.latest().decision.executorModel, "openai/gpt-6.1-sol");
});

test("OpenCodex's changing tool-catalog paragraph does not invalidate a normal continuation", async t => {
  const app = await fixture(t, (_body, res, planning) => planning
    ? reply(res, '{"executorIndex":0,"plan":"Use the synthetic result."}')
    : reply(res, null, [call("catalog-turn")]));
  const goal = { role: "user", content: "验证工具协议和结果" };
  const instructions = "Preserve user permissions.";
  const firstMessages = [{ role: "system", content: instructions + "\n\nTool contract: use the current tool catalog as ground truth. Valid tools: run_step." }, goal];
  const first = await app.chat(firstMessages);
  const next = [{ role: "system", content: instructions }, goal, first.body.choices[0].message,
    { role: "tool", tool_call_id: "catalog-turn", content: "synthetic data" }];
  assert.equal(taskFingerprint(firstMessages), taskFingerprint(next));
  assert.notEqual(taskFingerprint(next), taskFingerprint([{ role: "system", content: "New permissions." }, goal]));
  assert.equal((await app.chat(next)).status, 200);
  assert.equal(app.latest().decision.invoked, false);
  assert.equal(app.latest().routeReason, "tool-result-continuation");
});

test("argument formatting changes keep a tool batch identity while changed values do not", () => {
  const batch = argumentsText => [{ id: "wire-call", type: "function", function: { name: "run_step", arguments: argumentsText } }];
  assert.equal(toolSignature(batch('{"a":1,"b":{"c":2,"d":3}}')),
    toolSignature(batch('{ "b": {"d":3, "c":2}, "a":1 }')));
  assert.notEqual(toolSignature(batch('{"a":1}')), toolSignature(batch('{"a":2}')));
});

test("three identical tool batches trigger supervision before the regular interval", async t => {
  let executions = 0;
  const app = await fixture(t, (_body, res, planning) => planning
    ? reply(res, '{"executorIndex":0,"plan":"Check for progress."}')
    : reply(res, null, [call("repeat-" + ++executions, "same command")] ), { decisionReviewInterval: 12 });
  let messages = [{ role: "user", content: "分析构建异常" }];
  for (let round = 0; round <= 3; round++) {
    const result = await app.chat(messages);
    assert.equal(result.status, 200);
    const assistant = result.body.choices[0].message;
    messages = [...messages, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "still running" }];
  }
  assert.equal(app.latest().decision.trigger, "repeated-tools");
  assert.equal(app.latest().calls.filter(c => c.role === "planner").length, 1);
});

test("reused tool IDs from a different goal cannot inherit another task's decision", async t => {
  let decisions = 0;
  const app = await fixture(t, (_body, res, planning) => planning
    ? reply(res, JSON.stringify({ executorIndex: 0, plan: "Advice " + ++decisions }))
    : reply(res, null, [call("shared-id")]));
  const first = await app.chat([{ role: "user", content: "分析项目 A" }]);
  assert.equal((await app.chat([{ role: "user", content: "分析项目 B" }, first.body.choices[0].message,
    { role: "tool", tool_call_id: "shared-id", content: "done" }])).status, 200);
  assert.equal(app.latest().decision.trigger, "untracked-continuation");
  assert.equal(app.latest().decision.plan, "Advice 2");
});

test("a changed planning preference forces a checkpoint instead of using stale advice", async t => {
  const app = await fixture(t, (_body, res, planning) => planning
    ? reply(res, '{"executorIndex":0,"plan":"Check the current preference."}')
    : reply(res, null, [call("config-change")]));
  const messages = [{ role: "user", content: "优化构建流程" }];
  const first = await app.chat(messages);
  app.store.state.strategy.plannerPrompt = "重新评估方案";
  assert.equal((await app.chat([...messages, first.body.choices[0].message,
    { role: "tool", tool_call_id: "config-change", content: "done" }])).status, 200);
  assert.equal(app.latest().decision.trigger, "strategy-changed");
  assert.equal(app.latest().decision.invoked, true);
});

test("supervision respects Office preference but still invokes the configured planner", async t => {
  const seen = [];
  const app = await fixture(t, (body, res, planning) => {
    seen.push(body.model);
    if (planning) {
      const context = JSON.parse(body.messages[1].content);
      assert.equal(context.officePreference, "office-routine");
      const choice = context.candidates.find(c => c.model.startsWith("kimi-code/"));
      return reply(res, JSON.stringify({ executorIndex: choice.executorIndex }));
    }
    reply(res, "formatted");
  }, { officeRoutingEnabled: true });
  assert.equal((await app.chat([{ role: "user", content: "整理 Excel 工作表" }])).status, 200);
  assert.deepEqual(seen, ["openai/gpt-6.1-sol", "kimi-code/k3.1-pro-highspeed"]);
});

test("final review receives the actual tool evidence and original exact-output requirement", async t => {
  let executions = 0, reviews = 0;
  const proof = "VERIFIED_TOOL_PROOF";
  const app = await fixture(t, (body, res, planning) => {
    if (planning) return reply(res, '{"executorIndex":0,"plan":"Return the verified proof verbatim."}');
    if (body.messages[0].content.includes("核对并润色")) {
      reviews++;
      const data = JSON.parse(body.messages[1].content);
      assert.equal(data.answer, proof);
      assert.match(data.originalContext.task, /原样输出 proof/);
      assert(data.originalContext.recentMessages.some(m => m.role === "tool" && m.content.includes(proof)));
      assert.equal(body.tools, undefined);
      return reply(res, data.answer);
    }
    if (++executions === 1) return reply(res, null, [call("review-proof")]);
    reply(res, proof);
  });
  app.store.state.strategy.review = true;
  app.store.state.strategy.reviewerId = app.models[0].id;
  const messages = [{ role: "user", content: "读取合成工具结果，原样输出 proof 字段" }];
  const first = await app.chat(messages);
  const result = await app.chat([...messages, first.body.choices[0].message,
    { role: "tool", tool_call_id: "review-proof", content: JSON.stringify({ proof }) }]);
  assert.equal(result.status, 200);
  assert.equal(result.body.choices[0].message.content, proof);
  assert.equal(app.latest().decision.invoked, false);
  assert.deepEqual(app.latest().calls.map(c => c.role), ["executor", "reviewer"]);
  assert.equal(reviews, 1);
});

test("planner failure stops before execution with no replay or silent planner replacement", async t => {
  let sends = 0;
  const app = await fixture(t, (_body, res) => {
    sends++; res.writeHead(429); res.end("unavailable");
  });
  assert.equal((await app.chat([{ role: "user", content: "修复超时" }])).status, 502);
  assert.equal(sends, 1);
  assert.deepEqual(app.latest().calls.map(c => [c.role, c.status]), [["planner", "failed"]]);
  assert.equal(app.latest().decision.invoked, true);
  assert.notEqual(app.latest().decision.completed, true);
});

test("always mode includes greetings and legacy mode remains selectable", async t => {
  let decisions = 0;
  const app = await fixture(t, (_body, res, planning) => {
    if (planning) { decisions++; return reply(res, '{"executorIndex":0}'); }
    reply(res, "hello");
  }, { decisionMode: "always" });
  assert.equal((await app.chat([{ role: "user", content: "hello" }])).status, 200);
  assert.equal(decisions, 1);
  app.store.state.strategy.decisionMode = "initial";
  assert.equal((await app.chat([{ role: "user", content: "修复超时" }])).status, 200);
  assert.equal(decisions, 1);
});

test("existing stores gain supervision defaults without changing role selections", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-migration-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init();
  delete store.state.strategy.decisionMode;
  delete store.state.strategy.decisionReviewInterval;
  await store.save();
  const loaded = await new Store(directory).init();
  assert.equal(loaded.state.strategy.decisionMode, "supervised");
  assert.equal(loaded.state.strategy.decisionReviewInterval, 4);
  assert.equal(loaded.state.strategy.plannerId, store.state.strategy.plannerId);
  for (const extra of [{ decisionMode: "auto" }, { decisionReviewInterval: 0 }, { decisionReviewInterval: "4" }])
    assert.throws(() => validateStrategy({ ...loaded.state.strategy, ...extra }, loaded.state.models));
});
