import { readFile, writeFile, mkdir, chmod, copyFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = path.join(root, ".local");
const secretPath = path.join(local, "gateway-api-key");
const ocxHome =
  process.env.OPENCODEX_HOME || path.join(homedir(), ".opencodex");
const providerName = "ai-smart-gateway";
const gatewayUrl = "http://127.0.0.1:4317";

export function routedModels(rows) {
  return [
    ...new Set(
      rows
        .map((row) => row.id)
        .filter(
          (id) =>
            typeof id === "string" &&
            id !== "strategy" &&
            !id.toLowerCase().startsWith(`${providerName}/`),
        )
        .map((id) => (id.includes("/") ? id : `openai/${id}`)),
    ),
  ];
}

async function request(base, route, key, method = "GET", body) {
  const response = await fetch(base + route, {
    method,
    signal: AbortSignal.timeout(180000),
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}

export async function prepare() {
  await mkdir(local, { recursive: true, mode: 0o700 });
  await chmod(local, 0o700);
  try {
    await readFile(secretPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(secretPath, randomBytes(32).toString("base64url"), {
      flag: "wx",
      mode: 0o644,
    });
  }
  // Parent is owner-only. Readable file mode allows Docker's non-root user to read its bind-mounted secret.
  await chmod(secretPath, 0o644);
}

export async function connect() {
  await prepare();
  const gatewayKey = (await readFile(secretPath, "utf8")).trim();
  const runtime = JSON.parse(
    await readFile(path.join(ocxHome, "runtime-port.json"), "utf8"),
  );
  const ocxUrl = `http://127.0.0.1:${runtime.port}`;
  const upstreamUrl = `http://host.docker.internal:${runtime.port}/v1`;
  const adminKey = (
    await readFile(path.join(ocxHome, "admin-api-token"), "utf8")
  ).trim();
  const before = JSON.parse(
    await readFile(path.join(ocxHome, "config.json"), "utf8"),
  );
  await request(ocxUrl, "/api/providers", adminKey);
  const existing = before.providers[providerName];
  if (existing && existing.baseUrl !== `${gatewayUrl}/v1`)
    throw new Error("同名 OpenCodex provider 指向其他地址，停止以免覆盖。");
  const backupFolder = path.join(ocxHome, "backups");
  await mkdir(backupFolder, { recursive: true, mode: 0o700 });
  const backup = path.join(
    backupFolder,
    `ai-smart-gateway-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await copyFile(path.join(ocxHome, "config.json"), backup);
  await chmod(backup, 0o600);
  const keyName = "ai-smart-gateway-upstream";
  let upstreamKey = before.apiKeys?.find(
    (entry) => entry.name === keyName,
  )?.key;
  if (!upstreamKey)
    upstreamKey = (
      await request(ocxUrl, "/api/keys", adminKey, "POST", { name: keyName })
    ).key;
  const models = routedModels(
    (await request(ocxUrl, "/v1/models", upstreamKey)).data || [],
  );
  const gatewayConfig = await request(gatewayUrl, "/api/config", gatewayKey);
  const bySlug = new Map(
    gatewayConfig.models.map((model) => [model.model, model]),
  );
  for (const slug of models) {
    const previous = bySlug.get(slug);
    // Do not rewrite user-edited model configurations on subsequent runs.
    if (previous) continue;
    const result = await request(
      gatewayUrl,
      "/api/models",
      gatewayKey,
      "POST",
      {
        name: `OpenCodex · ${slug}`,
        kind: "live",
        model: slug,
        baseUrl: upstreamUrl,
        apiKey: upstreamKey,
        maxTokens: 4096,
        temperature: null,
        timeoutMs: 180000,
        tokenParameter: "max_tokens",
        jsonMode: false,
        inputPrice: null,
        outputPrice: null,
      },
    );
    bySlug.set(
      slug,
      result.models.find((model) => model.model === slug),
    );
  }
  const choose = (choices) =>
    choices.map((slug) => bySlug.get(slug)).find(Boolean);
  const planner = choose([
    "openai/gpt-6.1-sol",
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
  ]);
  const executors = [
    choose([
      "zhipu-bigmodel-coding/glm-5.3-flash",
      "zhipu-bigmodel-coding/glm-5.3-flashx",
    ]),
    choose(["deepseek/deepseek-flash", "kimi-code/kimi-for-coding-highspeed"]),
  ].filter(Boolean);
  if (!planner || !executors.length)
    throw new Error("未发现预期的决策/执行模型，请在面板中手动选择。");
  if (gatewayConfig.strategy.plannerId.startsWith("demo-")) {
    await request(gatewayUrl, "/api/strategy", gatewayKey, "PUT", {
      ...gatewayConfig.strategy,
      plannerId: planner.id,
      executorIds: executors.map((model) => model.id),
      reviewerId: planner.id,
      review: false,
      maxSteps: 4,
      concurrency: 2,
    });
  }
  if (!existing) {
    await request(ocxUrl, "/api/providers", adminKey, "POST", {
      name: providerName,
      setDefault: false,
      provider: {
        adapter: "openai-chat",
        baseUrl: `${gatewayUrl}/v1`,
        apiKey: gatewayKey,
        authMode: "key",
        allowPrivateNetwork: true,
        models: ["strategy"],
        defaultModel: "strategy",
        selectedModels: ["strategy"],
        liveModels: true,
        contextWindow: 8192,
        defaultMaxOutputTokens: 4096,
        modelReasoningEfforts: { strategy: [] },
        noReasoningModels: ["strategy"],
        noVisionModels: ["strategy"],
        noTemperatureModels: ["strategy"],
        noTopPModels: ["strategy"],
        modelDisplayNames: { strategy: "AI智能网关·文本策略" },
        note: "本地策略编排：文本任务专用；不支持 tools、工具结果或多模态。内部上游必须为其他明确渠道模型，禁止回指自身。",
      },
    });
  }
  const after = JSON.parse(
    await readFile(path.join(ocxHome, "config.json"), "utf8"),
  );
  if (after.defaultProvider !== before.defaultProvider)
    throw new Error("默认渠道发生变化，请检查备份。");
  const visible = (await request(ocxUrl, "/v1/models", upstreamKey)).data?.some(
    (model) => model.id === `${providerName}/strategy`,
  );
  console.log(
    JSON.stringify({
      importedModels: models.length,
      planner: planner.model,
      executors: executors.map((model) => model.model),
      provider: providerName,
      visible,
      defaultsPreserved: true,
      backupCreated: true,
    }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.includes("--prepare")) {
      await prepare();
      console.log("Local Docker secret prepared; no credentials printed.");
    } else await connect();
  } catch (error) {
    console.error(`OpenCodex integration: ${error.message}`);
    process.exitCode = 1;
  }
}
