import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { AppError, validateModel, callModel } from "./provider.js";
import { Engine, validateStrategy } from "./strategy.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const limit = 128 * 1024;
async function jsonBody(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new AppError("请求必须使用 application/json。", 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new AppError("请求超过 128 KB 限制。", 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new AppError("请求 JSON 格式无效。");
  }
}
function send(response, code, data) {
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}
function safeToken(actual, expected) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createApplication({
  directory = path.join(root, ".data"),
  gatewayKey = process.env.GATEWAY_API_KEY || "",
} = {}) {
  const store = await new Store(directory).init();
  const engine = new Engine(store);
  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = request.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
        throw new AppError("仅允许本机地址访问。", 403);
      if (request.headers.origin && request.headers.origin !== `http://${host}`)
        throw new AppError("拒绝跨站请求。", 403);
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new AppError("拒绝跨站请求。", 403);
      const url = new URL(request.url, `http://${host}`);
      const route = url.pathname;
      const method = request.method;
      if (route === "/api/health" && method === "GET")
        return send(response, 200, { status: "ok", localOnly: true });
      if (route === "/api/config" && method === "GET")
        return send(response, 200, store.publicConfig());
      if (route === "/api/models" && method === "POST") {
        if (store.state.models.length >= 100)
          throw new AppError("最多保存 100 个模型。");
        const body = await jsonBody(request);
        const model = validateModel(body);
        model.id = randomUUID();
        model.encryptedKey = store.encrypt(
          typeof body.apiKey === "string" ? body.apiKey.trim() : "",
        );
        store.state.models.push(model);
        await store.save();
        return send(response, 201, store.publicConfig());
      }
      const modelRoute = route.match(/^\/api\/models\/([^/]+)(\/test)?$/);
      if (modelRoute) {
        const index = store.state.models.findIndex(
          (model) => model.id === modelRoute[1],
        );
        if (index < 0) throw new AppError("模型不存在。", 404);
        const previous = store.state.models[index];
        if (modelRoute[2] && method === "POST") {
          const result =
            previous.kind === "demo"
              ? {
                  latencyMs: 0,
                  usage: { source: "simulated" },
                  content: "演示模型已就绪，未发生外部调用。",
                }
              : await callModel(
                  previous,
                  [{ role: "user", content: "Reply with OK." }],
                  {
                    apiKey: store.decrypt(previous.encryptedKey),
                    maxTokens: 128,
                  },
                );
          return send(response, 200, {
            ok: true,
            latencyMs: result.latencyMs,
            usage: result.usage,
            message: previous.kind === "demo" ? result.content : "连接成功",
          });
        }
        if (!modelRoute[2] && method === "PUT") {
          const body = await jsonBody(request);
          const model = validateModel(body, previous);
          model.encryptedKey =
            body.clearKey || previous.baseUrl !== model.baseUrl
              ? ""
              : previous.encryptedKey;
          if (typeof body.apiKey === "string" && body.apiKey.trim())
            model.encryptedKey = store.encrypt(body.apiKey.trim());
          store.state.models[index] = model;
          await store.save();
          return send(response, 200, store.publicConfig());
        }
        if (!modelRoute[2] && method === "DELETE") {
          const strategy = store.state.strategy;
          if (
            [
              strategy.plannerId,
              ...strategy.executorIds,
              strategy.reviewerId,
            ].includes(previous.id)
          )
            throw new AppError(
              "该模型正在策略中使用，请先在策略编排中解除关联。",
            );
          store.state.models.splice(index, 1);
          await store.save();
          return send(response, 200, store.publicConfig());
        }
      }
      if (route === "/api/strategy" && method === "PUT") {
        store.state.strategy = validateStrategy(
          await jsonBody(request),
          store.state.models,
        );
        await store.save();
        return send(response, 200, store.publicConfig());
      }
      if (route === "/api/runs" && method === "GET")
        return send(
          response,
          200,
          store.state.runs.map(({ result, steps, calls, ...run }) => ({
            ...run,
            stepCount: steps.length,
          })),
        );
      if (route === "/api/runs" && method === "POST") {
        const body = await jsonBody(request);
        const run = engine.create(body.task, body.demo !== false);
        return send(response, 202, { id: run.id });
      }
      if (route.startsWith("/api/runs/") && method === "GET") {
        const run = store.state.runs.find(
          (item) => item.id === route.slice("/api/runs/".length),
        );
        if (!run) throw new AppError("执行记录不存在。", 404);
        return send(response, 200, run);
      }
      if (route === "/v1/models" && method === "GET") {
        if (
          gatewayKey &&
          !safeToken(request.headers.authorization, `Bearer ${gatewayKey}`)
        )
          throw new AppError("网关密钥无效。", 401);
        return send(response, 200, {
          object: "list",
          data: [
            { id: "strategy", object: "model", owned_by: "ai-smart-gateway" },
          ],
        });
      }
      if (route === "/v1/chat/completions" && method === "POST") {
        if (request.headers["x-ai-gateway-hop"])
          throw new AppError("检测到网关循环调用。", 508);
        if (
          gatewayKey &&
          !safeToken(request.headers.authorization, `Bearer ${gatewayKey}`)
        )
          throw new AppError("网关密钥无效。", 401);
        const body = await jsonBody(request);
        if (
          body.model !== "strategy" ||
          (body.stream !== undefined && typeof body.stream !== "boolean") ||
          Object.keys(body).some(
            (key) =>
              ![
                "model",
                "messages",
                "stream",
                "stream_options",
                "max_tokens",
                "max_completion_tokens",
                "temperature",
              ].includes(key),
          )
        )
          throw new AppError(
            "当前策略网关仅支持文本请求，不支持 tools、工具结果或其他生成参数。",
          );
        const cap = body.max_completion_tokens ?? body.max_tokens;
        if (
          cap !== undefined &&
          (!Number.isInteger(cap) || cap < 1 || cap > 32768)
        )
          throw new AppError(
            "输出 token 限额必须为 1–32768。每个内部调用受此上限及模型配置共同约束。",
          );
        if (
          body.temperature !== undefined &&
          (typeof body.temperature !== "number" ||
            body.temperature < 0 ||
            body.temperature > 2)
        )
          throw new AppError("temperature 必须为 0–2。");
        if (
          body.stream_options !== undefined &&
          (!body.stream ||
            body.stream_options?.include_usage !== true ||
            Object.keys(body.stream_options).length !== 1)
        )
          throw new AppError("stream_options 仅支持 include_usage=true。");
        if (
          !Array.isArray(body.messages) ||
          !body.messages.length ||
          body.messages.some(
            (message) =>
              !["system", "user", "assistant"].includes(message.role) ||
              typeof message.content !== "string",
          )
        )
          throw new AppError(
            "messages 仅支持 system/user/assistant 的纯文本内容。",
          );
        const task = body.messages
          .map((message) => `[${message.role}]\n${message.content}`)
          .join("\n\n");
        const run = engine.create(task, false, {
          maxTokens: cap,
          temperature: body.temperature,
        });
        let heartbeat;
        if (body.stream) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          response.write(": strategy-planning\n\n");
          heartbeat = setInterval(() => {
            if (!response.destroyed) response.write(": strategy-working\n\n");
          }, 10000);
          response.once("close", () => clearInterval(heartbeat));
        }
        await engine.active.get(run.id);
        clearInterval(heartbeat);
        if (run.status !== "completed") {
          if (body.stream) {
            response.write(
              `data: ${JSON.stringify({ error: { message: run.error, type: "gateway_error" } })}\n\n`,
            );
            return response.end("data: [DONE]\n\n");
          }
          throw new AppError(run.error, 502);
        }
        const usage =
          run.totals.input === null
            ? null
            : {
                prompt_tokens: run.totals.input,
                completion_tokens: run.totals.output,
                total_tokens: run.totals.input + run.totals.output,
              };
        const completion = {
          id: `chatcmpl-${run.id}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "strategy",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: run.result },
              finish_reason: "stop",
            },
          ],
          usage,
          gateway_trace_id: run.id,
        };
        if (body.stream) {
          const { id, created, model } = completion;
          const chunk = (delta, finish_reason = null, extra = {}) =>
            response.write(
              `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`,
            );
          chunk({ role: "assistant", content: "" });
          const characters = Array.from(run.result);
          for (let offset = 0; offset < characters.length; offset += 128)
            chunk({ content: characters.slice(offset, offset + 128).join("") });
          chunk({}, "stop");
          if (body.stream_options?.include_usage)
            response.write(
              `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`,
            );
          return response.end("data: [DONE]\n\n");
        }
        return send(response, 200, completion);
      }
      if (method === "GET" && ["/", "/app.js", "/styles.css"].includes(route)) {
        const file = route === "/" ? "index.html" : route.slice(1);
        const content = await readFile(path.join(root, "public", file));
        response.writeHead(200, {
          "Content-Type": file.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : file.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        return response.end(content);
      }
      throw new AppError("接口不存在。", 404);
    } catch (error) {
      if (response.headersSent) return response.end();
      send(response, error instanceof AppError ? error.status : 500, {
        error: {
          message: error instanceof AppError ? error.message : "服务内部错误。",
          type: "gateway_error",
        },
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, store, engine };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const host = process.env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host))
    throw new Error("HOST must be 127.0.0.1 or 0.0.0.0");
  const gatewayKey = process.env.GATEWAY_API_KEY_FILE
    ? (await readFile(process.env.GATEWAY_API_KEY_FILE, "utf8")).trim()
    : process.env.GATEWAY_API_KEY || "";
  if (host === "0.0.0.0" && !gatewayKey)
    throw new Error(
      "Container/public bind requires a gateway key; publish Docker ports only on 127.0.0.1",
    );
  const { server } = await createApplication({ gatewayKey });
  server.listen(port, host, () =>
    console.log(`AI智能网关 · http://127.0.0.1:${port} · 仅本机访问`),
  );
}
