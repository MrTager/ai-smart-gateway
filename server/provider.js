export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validateModel(body, previous = {}) {
  const text = (value, maximum = 200) =>
    typeof value === "string" ? value.trim().slice(0, maximum) : "";
  const kind = body.kind === "demo" ? "demo" : "live";
  const name = text(body.name);
  const model = text(body.model);
  const baseUrl = text(body.baseUrl, 1000).replace(/\/+$/, "");
  if (!name || !model) throw new AppError("名称和模型 ID 不能为空。");
  if (kind === "live") {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new AppError("请输入有效的 API Base URL。");
    }
    const local = [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "host.docker.internal",
    ].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && !local)
    ) {
      throw new AppError(
        "远程模型必须使用 HTTPS；本机模型可使用 HTTP。URL 不可包含凭据、查询或片段。",
      );
    }
  }
  if (
    model === "strategy" ||
    model.toLowerCase().startsWith("ai-smart-gateway/")
  ) {
    throw new AppError("禁止将网关自己的策略模型设为上游，避免循环调用。");
  }
  function number(key, fallback, min, max, integer = false) {
    const value =
      body[key] === undefined ? (previous[key] ?? fallback) : Number(body[key]);
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    )
      throw new AppError(`${key} 参数超出范围。`);
    return value;
  }
  function price(key) {
    if (body[key] === "" || body[key] === null || body[key] === undefined)
      return null;
    return number(key, 0, 0, 100000);
  }
  return {
    id: previous.id,
    name,
    model,
    kind,
    baseUrl,
    maxTokens: number("maxTokens", 2048, 64, 32768, true),
    timeoutMs: number("timeoutMs", 60000, 1000, 300000, true),
    temperature:
      body.temperature === null ? null : number("temperature", 0.3, 0, 2),
    jsonMode: body.jsonMode === true,
    tokenParameter:
      body.tokenParameter === "max_completion_tokens"
        ? "max_completion_tokens"
        : "max_tokens",
    inputPrice: price("inputPrice"),
    outputPrice: price("outputPrice"),
    contextWindow: number("contextWindow", 128000, 4096, 2000000, true),
  };
}

export async function callModel(
  model,
  messages,
  {
    apiKey = "",
    json = false,
    maxTokens,
    native = false,
    parameters = {},
    signal,
  } = {},
) {
  if (model.kind === "demo")
    throw new AppError("演示模型不能用于真实调用，请先配置真实模型。");
  const body = {
    model: model.model,
    messages,
    [model.tokenParameter]: maxTokens ?? model.maxTokens,
  };
  if (model.temperature !== null) body.temperature = model.temperature;
  if (json && model.jsonMode) body.response_format = { type: "json_object" };
  Object.assign(body, parameters);
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(model.timeoutMs)])
        : AbortSignal.timeout(model.timeoutMs),
      headers: {
        "Content-Type": "application/json",
        "X-AI-Gateway-Hop": "1",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AppError("模型连接失败或超时；请检查地址、网络及超时配置。", 502);
  }
  // Never reflect upstream error bodies: some providers echo credentials/request data.
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      `模型服务返回 HTTP ${response.status}，请检查配置或配额。`,
      502,
    );
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new AppError("模型响应超过 2 MB 限制。", 502);
    }
    chunks.push(value);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("模型服务返回了无效 JSON。", 502);
  }
  const message = data.choices?.[0]?.message;
  const content = message?.content;
  const finishReason = data.choices?.[0]?.finish_reason || "stop";
  const hasToolCalls =
    Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  if (
    !message ||
    (typeof content !== "string" && content !== null && content !== undefined)
  )
    throw new AppError("模型返回了无效的 assistant 消息。", 502);
  if (
    (!native ||
      (!hasToolCalls && !message.refusal && finishReason !== "length")) &&
    (typeof content !== "string" || !content.trim())
  )
    throw new AppError("模型未返回可用文本；可能拒绝请求或输出额度不足。", 502);
  if (!native && finishReason === "length")
    throw new AppError("模型输出被截断，请提高该模型的输出额度后重试。", 502);
  const prompt = data.usage?.prompt_tokens;
  const completion = data.usage?.completion_tokens;
  const reported =
    Number.isFinite(prompt) &&
    prompt >= 0 &&
    Number.isFinite(completion) &&
    completion >= 0;
  const usage = reported
    ? { input: prompt, output: completion, source: "provider" }
    : { input: null, output: null, source: "unavailable" };
  const cost =
    reported && model.inputPrice !== null && model.outputPrice !== null
      ? (prompt * model.inputPrice + completion * model.outputPrice) / 1e6
      : null;
  return {
    content: content || "",
    message: { ...message, role: "assistant", content: content ?? null },
    finishReason,
    usage,
    cost,
    latencyMs: Math.round(performance.now() - started),
  };
}
