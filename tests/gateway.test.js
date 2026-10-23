import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createApplication } from "../server/index.js";
import { Store } from "../server/store.js";
import { parsePlan, validateStrategy } from "../server/strategy.js";
import { validateModel } from "../server/provider.js";
import { LIMITS } from "../server/limits.js";

async function fixture(t, gatewayKey = "") {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-gateway-test-"));
  const app = await createApplication({ directory, gatewayKey });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await Promise.all([...app.engine.active.values()]);
    await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, method = "GET", body, headers = {}) => {
    const response = await fetch(url + route, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...app, directory, url, request };
}
async function provider(t, handler) {
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    await handler(JSON.parse(text), req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function completion(
  res,
  content,
  usage = { prompt_tokens: 20, completion_tokens: 10 },
) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage,
    }),
  );
}
async function addLive(app, baseUrl, extra = {}) {
  const result = await app.request("/api/models", "POST", {
    name: "真实测试模型",
    kind: "live",
    model: "test-model",
    baseUrl,
    apiKey: "private-test-key",
    inputPrice: 1,
    outputPrice: 2,
    ...extra,
  });
  assert.equal(result.status, 201);
  const model = result.body.models.at(-1);
  const strategy = {
    ...result.body.strategy,
    plannerId: model.id,
    executorIds: [model.id],
    reviewerId: model.id,
    review: true,
    maxSteps: 4,
    concurrency: 2,
  };
  assert.equal(
    (await app.request("/api/strategy", "PUT", strategy)).status,
    200,
  );
  return model;
}

test("plan validation rejects malformed JSON, forward/cyclic dependencies and overflow", () => {
  assert.throws(() => parsePlan("not JSON", 4), /JSON/);
  assert.throws(() => parsePlan(JSON.stringify({ steps: [] }), 4));
  assert.throws(() =>
    parsePlan(
      JSON.stringify({
        steps: [{ title: "x", instruction: "y", dependsOn: ["step-1"] }],
      }),
      4,
    ),
  );
  assert.throws(() =>
    parsePlan(
      JSON.stringify({
        steps: [
          { title: "x", instruction: "y" },
          { title: "b", instruction: "c" },
        ],
      }),
      1,
    ),
  );
  assert.equal(
    parsePlan('```json\n{"steps":[{"title":"a","instruction":"b"}]}\n```', 4)
      .steps[0].id,
    "step-1",
  );
});
test("configuration validation rejects unsafe URL, invalid numbers and missing role", () => {
  const body = { name: "a", model: "b", baseUrl: "http://example.com/v1" };
  assert.throws(() => validateModel(body), /HTTPS/);
  assert.throws(() =>
    validateModel({ ...body, baseUrl: "https://user:secret@example.com/v1" }),
  );
  assert.throws(() =>
    validateModel({
      ...body,
      baseUrl: "https://example.com/v1",
      maxTokens: -1,
    }),
  );
  assert.throws(() =>
    validateStrategy({ plannerId: "missing", executorIds: [] }, []),
  );
});
test("API keys are encrypted on disk, redacted in responses and survive restart", async (t) => {
  const app = await fixture(t);
  const result = await app.request("/api/models", "POST", {
    name: "模型",
    model: "custom",
    baseUrl: "https://example.com/v1",
    apiKey: "SECRET_123",
  });
  assert.equal(result.status, 201);
  assert(!JSON.stringify(result.body).includes("SECRET_123"));
  assert(!JSON.stringify(result.body).includes("encryptedKey"));
  assert.equal(result.body.models.at(-1).hasKey, true);
  const disk = await readFile(path.join(app.directory, "state.json"), "utf8");
  assert(!disk.includes("SECRET_123"));
  const restarted = await new Store(app.directory).init();
  assert.equal(
    restarted.decrypt(restarted.state.models.at(-1).encryptedKey),
    "SECRET_123",
  );
  const updated = await app.request(
    `/api/models/${result.body.models.at(-1).id}`,
    "PUT",
    {
      ...result.body.models.at(-1),
      baseUrl: "https://another.example/v1",
      apiKey: "",
    },
  );
  assert.equal(updated.body.models.at(-1).hasKey, false);
});
test("demo workflow runs without credentials and marks every usage as simulated", async (t) => {
  const app = await fixture(t);
  const result = await app.request("/api/runs", "POST", {
    task: "制作发布计划",
    demo: true,
  });
  assert.equal(result.status, 202);
  await app.engine.active.get(result.body.id);
  const { body: run } = await app.request(`/api/runs/${result.body.id}`);
  assert.equal(run.status, "completed");
  assert.equal(run.calls.length, 4);
  assert(run.calls.every((call) => call.usage.source === "simulated"));
  assert.equal(run.totals.cost, null);
  assert.match(run.result, /固定演示文本/);
  assert.equal(
    (await app.request("/api/runs", "POST", { task: "真实运行", demo: false }))
      .status,
    400,
  );
});
test("real workflow supports parallel steps, dependency handoff, reviewer and reported usage", async (t) => {
  const app = await fixture(t);
  let active = 0;
  let parallel = 0;
  let count = 0;
  let sawDependency = false;
  const baseUrl = await provider(t, async (body, req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-test-key");
    assert.equal(req.url, "/v1/chat/completions");
    assert(body.max_completion_tokens);
    assert(!("temperature" in body));
    count++;
    if (body.messages[0].content.includes("任务规划器"))
      return completion(
        res,
        JSON.stringify({
          summary: "测试计划",
          steps: [
            { title: "A", instruction: "first", dependsOn: [] },
            { title: "B", instruction: "second", dependsOn: [] },
            {
              title: "C",
              instruction: "join",
              dependsOn: ["step-1", "step-2"],
            },
          ],
        }),
      );
    if (body.messages[0].content.includes("交付复核者"))
      return completion(res, "最终复核输出");
    const task = JSON.parse(body.messages[1].content);
    if (task.instruction === "join") {
      assert.equal(task.dependencies.length, 2);
      assert(task.dependencies.every((dep) => dep.output.includes("执行结果")));
      sawDependency = true;
    }
    active++;
    parallel = Math.max(parallel, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active--;
    completion(res, "执行结果 " + task.instruction);
  });
  await addLive(app, baseUrl, {
    temperature: null,
    tokenParameter: "max_completion_tokens",
  });
  const run = app.engine.create("完成并行任务", false);
  await app.engine.active.get(run.id);
  assert.equal(run.status, "completed");
  assert.equal(parallel, 2);
  assert(sawDependency);
  assert.equal(count, 5);
  assert.equal(run.result, "最终复核输出");
  assert.equal(run.totals.input, 100);
  assert.equal(run.totals.output, 50);
  assert(Math.abs(run.totals.cost - 0.0002) < 1e-9);
});
test("upstream failure is recorded without secret echo or demo fallback", async (t) => {
  const app = await fixture(t);
  const baseUrl = await provider(t, (_body, _req, res) => {
    res.writeHead(401);
    res.end("private-test-key");
  });
  await addLive(app, baseUrl);
  const run = app.engine.create("失败任务", false);
  await app.engine.active.get(run.id);
  assert.equal(run.status, "failed");
  assert.match(run.error, /401/);
  assert.equal(run.result, "");
  assert(!JSON.stringify(run).includes("private-test-key"));
  assert.equal(run.calls.length, 0);
});
test("missing usage stays unknown instead of becoming zero", async (t) => {
  const app = await fixture(t);
  const baseUrl = await provider(t, (body, _req, res) =>
    completion(
      res,
      body.messages[0].content.includes("任务规划器")
        ? '{"steps":[{"title":"A","instruction":"do it"}]}'
        : "done",
      null,
    ),
  );
  await addLive(app, baseUrl);
  const run = app.engine.create("未知用量", false);
  await app.engine.active.get(run.id);
  assert.equal(run.status, "completed");
  assert.equal(run.totals.input, null);
  assert.equal(run.totals.cost, null);
});
test("local security rejects cross-origin access and protects gateway bearer endpoint", async (t) => {
  const app = await fixture(t, "gateway-password");
  assert.equal(
    (
      await app.request("/api/config", "GET", null, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal((await app.request("/v1/models")).status, 401);
  assert.equal(
    (
      await app.request("/v1/models", "GET", null, {
        Authorization: "Bearer gateway-password",
      })
    ).status,
    200,
  );
  const stream = await app.request(
    "/v1/chat/completions",
    "POST",
    {
      model: "strategy",
      stream: true,
      messages: [{ role: "user", content: "a" }],
    },
    { Authorization: "Bearer gateway-password" },
  );
  assert.equal(stream.status, 400);
});
test("OpenAI-shaped gateway returns final result and total multi-call usage", async (t) => {
  const app = await fixture(t);
  const baseUrl = await provider(t, (body, _req, res) =>
    completion(
      res,
      body.messages[0].content.includes("任务规划器")
        ? '{"steps":[{"title":"A","instruction":"work"}]}'
        : "delivered",
    ),
  );
  await addLive(app, baseUrl);
  const { status, body } = await app.request("/v1/chat/completions", "POST", {
    model: "strategy",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(status, 200);
  assert.equal(body.object, "chat.completion");
  assert.match(body.choices[0].message.content, /delivered/);
  assert.equal(body.usage.total_tokens, 90);
  assert(body.gateway_trace_id);
});
test("referenced model cannot be deleted and unknown API is 404", async (t) => {
  const app = await fixture(t);
  assert.equal(
    (await app.request("/api/models/demo-planner", "DELETE")).status,
    400,
  );
  assert.equal((await app.request("/api/missing")).status, 404);
});

test("invalid planner output fails before execution and never retries automatically", async (t) => {
  const app = await fixture(t);
  let count = 0;
  const baseUrl = await provider(t, (_body, _req, res) => {
    count++;
    completion(res, "I will not return JSON");
  });
  await addLive(app, baseUrl);
  const run = app.engine.create("invalid plan", false);
  await app.engine.active.get(run.id);
  assert.equal(run.status, "failed");
  assert.equal(run.steps.length, 0);
  assert.equal(count, 1);
  assert.equal(run.totals.input, 20);
});

test("restart marks interrupted jobs as failed without re-execution", async (t) => {
  const app = await fixture(t);
  app.store.state.runs.push({ id: "interrupted", status: "running" });
  await app.store.save();
  const restarted = await new Store(app.directory).init();
  const interrupted = restarted.state.runs.find(
    (run) => run.id === "interrupted",
  );
  assert.equal(interrupted.status, "failed");
  assert(interrupted.finishedAt);
});

test("gateway rejects unsupported parameters instead of silently ignoring them", async (t) => {
  const app = await fixture(t);
  for (const extra of [{ top_p: 0.5 }, { max_tokens: 0 }, { tools: [] }]) {
    const result = await app.request("/v1/chat/completions", "POST", {
      model: "strategy",
      messages: [{ role: "user", content: "hello" }],
      ...extra,
    });
    assert.equal(result.status, 400);
  }
  assert.equal(app.store.state.runs.length, 0);
});

test("SSE gateway returns final text, usage, DONE and honors per-call cap", async (t) => {
  const app = await fixture(t);
  const baseUrl = await provider(t, (body, _req, res) => {
    assert.equal(body.max_tokens, 128);
    completion(
      res,
      body.messages[0].content.includes("任务规划器")
        ? '{"steps":[{"title":"A","instruction":"work"}]}'
        : "streamed result 😀",
    );
  });
  await addLive(app, baseUrl);
  const response = await fetch(app.url + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "strategy",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 128,
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /event-stream/);
  const content = await response.text();
  assert(content.includes("data: [DONE]"));
  const events = content
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
  assert(events.some((event) => event.usage?.total_tokens === 90));
  assert.equal(
    events
      .flatMap((event) => event.choices)
      .map((choice) => choice.delta.content || "")
      .join(""),
    "streamed result 😀",
  );
});

test("recursive gateway header is rejected before any model is called", async (t) => {
  const app = await fixture(t);
  const response = await app.request(
    "/v1/chat/completions",
    "POST",
    { model: "strategy", messages: [{ role: "user", content: "x" }] },
    { "X-AI-Gateway-Hop": "1" },
  );
  assert.equal(response.status, 508);
  assert.equal(app.store.state.runs.length, 0);
});

test("large multi-megabyte input reaches planner intact without flooding history previews", async (t) => {
  const app = await fixture(t);
  const text =
    "BEGIN-LONG-SOURCE\n" + "token ".repeat(1_000_000) + "\nEND-LONG-SOURCE";
  let plannerSawSource = false;
  const baseUrl = await provider(t, (body, _req, res) => {
    if (body.messages[0].content.includes("任务规划器")) {
      assert.equal(body.messages[1].content, "[user]\n" + text);
      plannerSawSource = true;
      completion(
        res,
        '{"steps":[{"title":"A","instruction":"Return checked"}]}',
      );
    } else completion(res, "checked");
  });
  await addLive(app, baseUrl);
  const config = await app.request("/api/config");
  await app.request("/api/strategy", "PUT", {
    ...config.body.strategy,
    review: false,
  });
  const response = await app.request("/v1/chat/completions", "POST", {
    model: "strategy",
    messages: [{ role: "user", content: text }],
  });
  assert.equal(response.status, 200);
  assert(plannerSawSource);
  const history = await app.request("/api/runs");
  assert(history.body[0].task.length <= 360);
  assert(history.body[0].taskCharacters > 6_000_000);
  const preview = await app.request(
    `/api/runs/${history.body[0].id}?preview=1`,
  );
  assert.equal(preview.body.task.length, 1200);
  assert.equal(preview.body.taskTruncated, true);
  const full = await app.request(`/api/runs/${history.body[0].id}`);
  assert.equal(full.body.task, "[user]\n" + text);
});

test("task transport guard rejects huge Unicode input by bytes, not by token claims", async (t) => {
  const app = await fixture(t);
  const text = "中".repeat(Math.floor(LIMITS.maxTaskBytes / 3) + 1);
  assert.throws(() => app.engine.create(text, true), /16 MiB/);
  assert.equal(app.store.state.runs.length, 0);
});
