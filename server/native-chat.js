import { randomUUID } from "node:crypto";
import { AppError, callModel } from "./provider.js";
import { totals, validateStrategy } from "./strategy.js";
import { LIMITS } from "./limits.js";

export const COMPACTION_MARKER =
  "You are performing a CONTEXT CHECKPOINT COMPACTION.";
const PARAMS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "stop",
  "response_format",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "reasoning_effort",
  "user",
];
export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content))
    return message.content.map((part) => part.text || "").join("\n");
  return "";
}
export function isCompactionRequest(body) {
  // Never search old history or infer compaction from task length. Only honor the client's explicit final instruction.
  const last = body.messages.at(-1);
  return (
    last?.role === "user" &&
    messageText(last).trimStart().startsWith(COMPACTION_MARKER)
  );
}
export function validateChatRequest(body) {
  const allowed = new Set([
    "model",
    "messages",
    "stream",
    "stream_options",
    "max_tokens",
    "max_completion_tokens",
    "n",
    ...PARAMS,
  ]);
  const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
  if (unsupported.length)
    throw new AppError(`不支持的请求参数：${unsupported.join(", ")}。`);
  if (body.model !== "strategy") throw new AppError("model 必须是 strategy。");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new AppError("stream 必须是 boolean。");
  if (body.n !== undefined && body.n !== 1)
    throw new AppError("当前仅支持 n=1。");
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw new AppError("messages 不能为空。");
  const pending = new Set();
  for (const message of body.messages) {
    if (
      !message ||
      !["system", "developer", "user", "assistant", "tool"].includes(
        message.role,
      )
    )
      throw new AppError("消息 role 无效。");
    const content = message.content;
    if (
      content !== null &&
      content !== undefined &&
      typeof content !== "string" &&
      !(
        Array.isArray(content) &&
        content.every(
          (part) => part?.type === "text" && typeof part.text === "string",
        )
      )
    )
      throw new AppError(
        "当前支持文本及函数工具；图片、音频等输入暂未适配。",
        422,
      );
    if (message.role !== "assistant" && content == null)
      throw new AppError("非 assistant 消息必须包含 content。");
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls))
        throw new AppError("tool_calls 只能用于 assistant 消息。");
      for (const call of message.tool_calls) {
        if (
          typeof call.id !== "string" ||
          !call.id ||
          call.type !== "function" ||
          typeof call.function?.name !== "string" ||
          typeof call.function.arguments !== "string"
        )
          throw new AppError("assistant 工具调用格式无效。");
        pending.add(call.id);
      }
    }
    if (message.role === "tool") {
      if (!pending.has(message.tool_call_id))
        throw new AppError("工具结果缺少匹配的 assistant tool_call_id。");
      pending.delete(message.tool_call_id);
    }
  }
  if (pending.size)
    throw new AppError(
      "尚有工具调用未提供结果，请由客户端完成工具执行后再请求。",
    );
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some(
        (tool) =>
          tool?.type !== "function" ||
          typeof tool.function?.name !== "string" ||
          !tool.function.name,
      ))
  )
    throw new AppError("tools 必须使用 Chat Completions function 格式。");
  if (
    body.tool_choice !== undefined &&
    !["auto", "none", "required"].includes(body.tool_choice) &&
    !(
      body.tool_choice?.type === "function" &&
      body.tools?.some(
        (tool) => tool.function.name === body.tool_choice.function?.name,
      )
    )
  )
    throw new AppError("tool_choice 无效或指定了未声明工具。");
  if (
    (body.tool_choice === "required" || typeof body.tool_choice === "object") &&
    !body.tools?.length
  )
    throw new AppError("必需工具调用必须声明 tools。");
  if (
    body.parallel_tool_calls !== undefined &&
    typeof body.parallel_tool_calls !== "boolean"
  )
    throw new AppError("parallel_tool_calls 必须是 boolean。");
  const cap = body.max_completion_tokens ?? body.max_tokens;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > 32768))
    throw new AppError("输出 token 限额必须为 1–32768。");
  for (const [key, low, high] of [
    ["temperature", 0, 2],
    ["top_p", 0, 1],
    ["presence_penalty", -2, 2],
    ["frequency_penalty", -2, 2],
  ]) {
    if (
      body[key] !== undefined &&
      (typeof body[key] !== "number" ||
        !Number.isFinite(body[key]) ||
        body[key] < low ||
        body[key] > high)
    )
      throw new AppError(`${key} 参数无效。`);
  }
  if (
    body.stream_options !== undefined &&
    (!body.stream ||
      !body.stream_options ||
      typeof body.stream_options !== "object" ||
      Object.keys(body.stream_options).some((key) => key !== "include_usage") ||
      typeof body.stream_options.include_usage !== "boolean")
  )
    throw new AppError("stream_options 仅支持 include_usage boolean。");
  if (Buffer.byteLength(JSON.stringify(body.messages)) > LIMITS.maxTaskBytes)
    throw new AppError("消息内容超过 16 MiB 文本传输限制。", 413);
  return body;
}

let tokenizerPromise;
async function estimateInput(body) {
  const text = JSON.stringify({
    messages: body.messages,
    tools: body.tools || [],
    response_format: body.response_format,
  });
  const bytes = Buffer.byteLength(text);
  // A conservative byte upper bound is cheap for small requests. Large inputs use an explicit estimate, never silent truncation.
  if (bytes < 60000)
    return { tokens: bytes + 1024, method: "utf8-byte-upper-bound" };
  tokenizerPromise ||= Promise.all([
    import("js-tiktoken/lite"),
    import("js-tiktoken/ranks/o200k_base"),
  ]).then(([{ Tiktoken }, ranks]) => new Tiktoken(ranks.default));
  const tokenizer = await tokenizerPromise;
  return {
    tokens: tokenizer.encode(text, [], []).length + 1024,
    method: "o200k_base-estimate",
  };
}
function simpleTask(text) {
  return (
    text.length <= 240 &&
    (/天气|气温|几点|日期|时间|weather|temperature|time\b/i.test(text) ||
      text.length <= 40)
  );
}
function validateReturnedCalls(result, body) {
  const calls = result.message.tool_calls || [];
  const names = new Set((body.tools || []).map((tool) => tool.function.name));
  const ids = new Set();
  for (const call of calls) {
    if (
      !call.id ||
      ids.has(call.id) ||
      call.type !== "function" ||
      !names.has(call.function?.name) ||
      typeof call.function.arguments !== "string"
    )
      throw new AppError("上游返回了未声明或无效的工具调用。", 502);
    try {
      JSON.parse(call.function.arguments);
    } catch {
      throw new AppError("上游返回的工具 arguments 不是有效 JSON。", 502);
    }
    ids.add(call.id);
  }
  if (body.tool_choice === "none" && calls.length)
    throw new AppError("上游违反 tool_choice=none。", 502);
  if (body.parallel_tool_calls === false && calls.length > 1)
    throw new AppError("上游违反 parallel_tool_calls=false。", 502);
  if (body.tool_choice === "required" && !calls.length)
    throw new AppError("上游未遵守必需工具调用。", 502);
  if (
    body.tool_choice?.type === "function" &&
    (!calls.length ||
      calls.some(
        (call) => call.function.name !== body.tool_choice.function.name,
      ))
  )
    throw new AppError("上游没有调用指定工具。", 502);
  if (calls.length) result.finishReason = "tool_calls";
}

export class NativeChatEngine {
  constructor(store, active) {
    this.store = store;
    this.active = active;
  }
  create(body, signal) {
    if (this.active.size >= 4)
      throw new AppError("最多同时运行 4 个任务，请稍后重试。", 429);
    const config = structuredClone({
      models: this.store.state.models,
      strategy: this.store.state.strategy,
    });
    validateStrategy(config.strategy, config.models);
    const requiredIds = [
      config.strategy.plannerId,
      ...config.strategy.executorIds,
      ...(config.strategy.review ? [config.strategy.reviewerId] : []),
    ];
    if (
      requiredIds.some(
        (id) => config.models.find((model) => model.id === id).kind !== "live",
      )
    )
      throw new AppError("原生模型入口需要将所有参与角色配置为真实模型。");
    const lastUser = [...body.messages]
      .reverse()
      .find((message) => message.role === "user");
    const run = {
      id: randomUUID(),
      task: messageText(lastUser).slice(0, 1600) || "工具结果续接",
      demo: false,
      mode: "native-agent",
      status: "running",
      stage: "routing",
      createdAt: new Date().toISOString(),
      steps: [],
      calls: [],
      result: "",
      totals: { input: null, output: null, cost: null, calls: 0 },
      configuration: {
        planner: config.models.find(
          (model) => model.id === config.strategy.plannerId,
        ).name,
        executors: config.strategy.executorIds.map(
          (id) => config.models.find((model) => model.id === id).name,
        ),
      },
    };
    this.store.state.runs.unshift(run);
    const retained = this.store.state.runs
      .filter((row) => !["queued", "running"].includes(row.status))
      .slice(0, 100);
    this.store.state.runs = this.store.state.runs.filter(
      (row) =>
        ["queued", "running"].includes(row.status) || retained.includes(row),
    );
    const job = this.execute(run, body, config, signal).finally(() =>
      this.active.delete(run.id),
    );
    this.active.set(run.id, job);
    return { run, job };
  }
  async invoke(run, model, messages, parameters, role, signal, cap) {
    if (model.kind !== "live") throw new AppError("真实请求需要配置真实模型。");
    const result = await callModel(model, messages, {
      native: true,
      parameters,
      signal,
      apiKey: this.store.decrypt(model.encryptedKey),
      maxTokens: cap === undefined ? undefined : Math.min(cap, model.maxTokens),
    });
    run.calls.push({
      role,
      modelId: model.id,
      modelName: model.name,
      usage: result.usage,
      cost: result.cost,
      latencyMs: result.latencyMs,
    });
    run.totals = totals(run.calls);
    await this.store.save();
    return result;
  }
  async execute(run, body, config, signal) {
    const started = performance.now();
    const byId = (id) => config.models.find((model) => model.id === id);
    const planner = byId(config.strategy.plannerId);
    const executors = config.strategy.executorIds.map(byId);
    const cap = body.max_completion_tokens ?? body.max_tokens;
    try {
      await this.store.save();
      const estimate = await estimateInput(body);
      run.inputEstimate = estimate;
      const fits = (model) =>
        estimate.tokens + Math.min(cap ?? model.maxTokens, model.maxTokens) <=
        Math.min(model.contextWindow ?? 128000, LIMITS.contextWindowTokens);
      const compact = isCompactionRequest(body);
      const last = body.messages.at(-1);
      const continuation = last.role === "tool";
      const incomingIds = new Set(
        body.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.tool_call_id),
      );
      const previous = continuation
        ? this.store.state.runs.find(
            (row) =>
              row.id !== run.id &&
              row.outputToolCallIds?.some((id) => incomingIds.has(id)),
          )
        : null;
      let model = compact
        ? planner
        : (previous && byId(previous.executionModelId)) || executors[0];
      let reason = compact
        ? "client-requested-compaction"
        : continuation
          ? "tool-result-continuation"
          : simpleTask(run.task)
            ? "simple-task-direct"
            : "planned-task";
      if (!fits(model)) {
        if (!fits(planner))
          throw new AppError(
            "消息及输出预留超出所配置模型窗口。网关没有删除或压缩历史；请检查上游容量或由客户端显式压缩。",
            413,
          );
        model = planner;
        reason = "large-context-escalation";
      }
      let plan = "";
      if (
        !compact &&
        !continuation &&
        !simpleTask(run.task) &&
        reason !== "large-context-escalation"
      ) {
        const routing = await this.invoke(
          run,
          planner,
          [
            {
              role: "system",
              content: `你是模型路由规划器。只输出 JSON {"executorIndex":0,"plan":"简短执行建议"}，不输出思维链。执行池：${executors.map((candidate, index) => `${index}: ${candidate.name}`).join("；")}。不要实际执行工具，不要压缩或总结对话。`,
            },
            {
              role: "user",
              content: JSON.stringify({
                task: run.task,
                availableTools: (body.tools || []).map(
                  (tool) => tool.function.name,
                ),
                messageCount: body.messages.length,
              }),
            },
          ],
          planner.jsonMode ? { response_format: { type: "json_object" } } : {},
          "planner",
          signal,
          4096,
        );
        let decision;
        try {
          decision = JSON.parse(
            routing.content
              .trim()
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/\s*```$/, ""),
          );
        } catch {
          throw new AppError("路由模型未返回有效决策，未擅自重试。", 502);
        }
        if (
          !Number.isInteger(decision.executorIndex) ||
          !executors[decision.executorIndex]
        )
          throw new AppError("决策模型选择了无效执行模型。", 502);
        model = executors[decision.executorIndex];
        if (!fits(model)) {
          model = planner;
          reason = "large-context-escalation";
        }
        plan =
          typeof decision.plan === "string" ? decision.plan.slice(0, 2000) : "";
      }
      run.mode = compact ? "client-compaction" : "native-agent";
      run.routeReason = reason;
      run.executionModelId = model.id;
      run.summary = compact
        ? "客户端显式请求压缩：决策模型直接处理，无子任务拆解。"
        : `${reason} · 原始消息与工具协议保持不变。`;
      run.stage = compact ? "compacting" : "executing";
      await this.store.save();
      const parameters = Object.fromEntries(
        PARAMS.filter((key) => body[key] !== undefined).map((key) => [
          key,
          body[key],
        ]),
      );
      const messages = plan
        ? [
            {
              role: "system",
              content: `内部执行建议（不改变原始系统约束、工具定义、权限或用户要求）：${plan}`,
            },
            ...body.messages,
          ]
        : body.messages;
      let result = await this.invoke(
        run,
        model,
        messages,
        parameters,
        compact ? "compaction" : "executor",
        signal,
        cap,
      );
      validateReturnedCalls(result, body);
      if (
        !compact &&
        config.strategy.review &&
        !result.message.tool_calls?.length &&
        result.finishReason === "stop" &&
        !body.response_format
      ) {
        result = await this.invoke(
          run,
          byId(config.strategy.reviewerId),
          [
            {
              role: "system",
              content:
                "核对并润色已有回答，输出可直接交付的内容。不编造工具执行结果，不输出思维链。",
            },
            {
              role: "user",
              content: JSON.stringify({
                task: run.task,
                answer: result.content,
              }),
            },
          ],
          {},
          "reviewer",
          signal,
          cap,
        );
      }
      run.outputToolCallIds = (result.message.tool_calls || []).map(
        (call) => call.id,
      );
      run.result =
        result.content ||
        (run.outputToolCallIds.length
          ? `请求客户端执行 ${run.outputToolCallIds.length} 个工具调用。`
          : result.message.refusal || "");
      run.status = "completed";
      run.stage = "done";
      return { message: result.message, finishReason: result.finishReason };
    } catch (error) {
      run.status = "failed";
      run.error = signal?.aborted
        ? "客户端已取消请求。"
        : error instanceof AppError
          ? error.message
          : "网关内部执行失败。";
      return null;
    } finally {
      run.durationMs = Math.round(performance.now() - started);
      run.finishedAt = new Date().toISOString();
      await this.store.save();
    }
  }
}
