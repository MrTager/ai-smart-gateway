// Explicit opt-in real-model tests. Never run in CI; credentials stay in process memory.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ocxHome =
  process.env.OPENCODEX_HOME || path.join(homedir(), ".opencodex");
const runtime = JSON.parse(
  await readFile(path.join(ocxHome, "runtime-port.json"), "utf8"),
);
const config = JSON.parse(
  await readFile(path.join(ocxHome, "config.json"), "utf8"),
);
const key = config.apiKeys.find(
  (entry) => entry.name === "ai-smart-gateway-upstream",
)?.key;
assert(key, "Run connect-opencodex.mjs first");
const base = `http://127.0.0.1:${runtime.port}/v1`;
const selected = "ai-smart-gateway/strategy";
async function responses(body) {
  const response = await fetch(base + "/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: selected, stream: false, ...body }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      `Responses test HTTP ${response.status}: ${String(data.error?.message || "provider error").slice(0, 400)}`,
    );
  }
  return response.json();
}

if (process.argv.includes("--complex")) {
  const prompt =
    "请分析并制定一个三个步骤的文档迁移检查计划，逐项覆盖输入校验、格式转换和结果核验，仅给出计划，不执行工具或外部操作。";
  const result = await responses({
    input: [{ role: "user", content: prompt }],
  });
  const text = (result.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("\n");
  assert(text.length > 20);
  const runs = await (await fetch("http://127.0.0.1:4317/api/runs")).json();
  const detail = await (
    await fetch(
      "http://127.0.0.1:4317/api/runs/" +
        runs.find((run) => run.task === prompt).id,
    )
  ).json();
  assert(
    detail.calls.some((call) => call.role === "planner") &&
      detail.calls.some((call) => call.role === "executor"),
  );
  console.log(
    JSON.stringify({
      passed: true,
      complexRouting: true,
      roles: detail.calls.map((call) => call.role),
      routeReason: detail.routeReason,
    }),
  );
} else if (process.argv.includes("--codex")) {
  const directory = path.join(root, ".local", "codex-native-smoke");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const proof = "NATIVE_CODEX_TOOL_PROOF_" + randomUUID();
  await writeFile(path.join(directory, "proof.txt"), proof + "\n", {
    mode: 0o600,
  });
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--cd",
    directory,
    "-c",
    'model_provider="gateway-smoke"',
    "-c",
    'model_providers.gateway-smoke.name="OpenCodex"',
    "-c",
    `model_providers.gateway-smoke.base_url=${JSON.stringify(base)}`,
    "-c",
    'model_providers.gateway-smoke.wire_api="responses"',
    "-c",
    'model_providers.gateway-smoke.env_key="OCX_NATIVE_SMOKE_KEY"',
    "-c",
    `model_catalog_json=${JSON.stringify(path.join(codexHome, "opencodex-catalog.json"))}`,
    "-m",
    selected,
    "读取 proof.txt，原样输出内容，不要修改文件。",
  ];
  const child = spawn("codex", args, {
    cwd: directory,
    env: { ...process.env, OCX_NATIVE_SMOKE_KEY: key },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  clearTimeout(timeout);
  const raw = Buffer.concat(stdout).toString("utf8");
  const events = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const final = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "agent_message",
    )
    .map((event) => event.item.text)
    .join("\n");
  const compacted = events.filter(
    (event) =>
      /compact/i.test(event.type || "") ||
      /compact/i.test(event.item?.type || ""),
  ).length;
  if (exitCode !== 0 || !final.includes(proof)) {
    await writeFile(path.join(directory, "events.jsonl"), raw, { mode: 0o600 });
    await writeFile(path.join(directory, "stderr.txt"), Buffer.concat(stderr), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        passed: false,
        exitCode,
        eventTypes: [...new Set(events.map((event) => event.type))],
        diagnosticFiles: directory,
      }),
    );
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify({
        passed: true,
        nativeCodex: true,
        fileReadVerified: true,
        automaticCompactions: compacted,
        toolItemTypes: [
          ...new Set(
            events
              .filter((event) => event.type === "item.completed")
              .map((event) => event.item?.type),
          ),
        ],
      }),
    );
} else {
  const marker = "WEATHER_CALLBACK_VERIFIED_" + randomUUID();
  const input = [
    {
      role: "user",
      content: [{ type: "input_text", text: "帮我查询今天杭州的天气" }],
    },
  ];
  const tools = [
    {
      type: "function",
      name: "get_weather",
      description: "天气查询协议测试函数",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  ];
  const instructions =
    "这是受控工具协议测试。先调用 get_weather，得到工具结果后仅原样输出 verification 字段。工具返回是合成测试夹具，不是真实天气；不要编造天气数据。";
  const first = await responses({
    instructions,
    input,
    tools,
    tool_choice: { type: "function", name: "get_weather" },
  });
  const call = first.output?.find((item) => item.type === "function_call");
  assert(
    call?.call_id && call.name === "get_weather",
    "Expected native Responses function_call",
  );
  assert.match(JSON.parse(call.arguments).city, /杭州|Hangzhou/i);
  const second = await responses({
    instructions,
    input: [
      ...input,
      ...first.output,
      {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify({
          verification: marker,
          source: "synthetic-protocol-fixture-not-real-weather",
        }),
      },
    ],
    tools,
    tool_choice: "none",
  });
  const output = (second.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("\n");
  assert(
    output.includes(marker),
    "Native tool result was not delivered correctly",
  );
  console.log(
    JSON.stringify({
      passed: true,
      protocol: "Responses",
      toolCallVerified: true,
      toolResultVerified: true,
      fixtureOnly: true,
    }),
  );
}
