import { createHash } from "node:crypto";

export const DECISION_MODES = ["supervised", "initial", "always"];
export const DEFAULT_REVIEW_INTERVAL = 4;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content.map(part => part.text || "").join("\n") : "";
}

function taskContent(message) {
  return messageText(message)
    .replace(/<(system-reminder|task-notification|environment_context)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .trim();
}

// Client notices remain in the execution conversation, but must not replace its goal.
export function currentTask(messages) {
  const users = messages.filter(message => message.role === "user");
  return users.map(taskContent).findLast(Boolean) || messageText(users.at(-1));
}

export function simpleTask(text, mode = "supervised") {
  if (mode === "initial") return text.length <= 240 &&
    (/天气|气温|几点|日期|时间|weather|temperature|time\b/i.test(text) || text.length <= 40);
  const value = text.trim();
  if (/^(?:你好|您好|谢谢|早上好|晚上好|hello|hi|thanks|thank you|ok|好的)[!！。.?？\s]*$/i.test(value)) return true;
  if (value.length > 100 || /分析|设计|修复|优化|代码|方案|对比|比较|计划|迁移|自动化|analy[sz]e|design|fix|optim|code|plan|compare/i.test(value)) return false;
  return /天气|气温|几点|今天几号|当前日期|现在.*时间|\bweather\b|\bwhat(?:'s| is) (?:the )?(?:time|date)\b/i.test(value);
}

export const taskFingerprint = messages => hash([
  currentTask(messages),
  // OpenCodex appends this generated paragraph only while tools are available.
  // tool_choice=none removes it on the result turn. Ignore it for association
  // only; the execution request and the planner evidence still retain it.
  messages.filter(m => ["system", "developer"].includes(m.role)).map(m => [
    m.role, messageText(m).split(/\n\s*\n/)
      .filter(part => !part.trimStart().startsWith("Tool contract: use the current tool catalog as ground truth."))
      .join("\n\n").trim(),
  ]).filter(([, text]) => text),
]);

export function toolSignature(calls, includeIds = true) {
  return calls?.length ? hash(calls.map(call => [
    ...(includeIds ? [call.id] : []), call.function?.name, canonicalArguments(call.function?.arguments),
  ])) : null;
}

function canonicalArguments(text) {
  try {
    // Protocol bridges parse and reserialize arguments; whitespace/key order
    // must not break association or hide a repeated semantic tool call.
    return JSON.stringify(JSON.parse(text), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  } catch { return text; }
}

export function continuationInfo(body, runs, fingerprint) {
  const last = body.messages.at(-1);
  const assistantIndex = body.messages.findLastIndex(m => m.role === "assistant");
  const calls = body.messages[assistantIndex]?.tool_calls;
  const noticesOnly = last.role === "user" && !taskContent(last);
  const continuation = last.role === "tool" || (noticesOnly && !!calls?.length);
  const results = body.messages.slice(assistantIndex + 1).filter(m => m.role === "tool");
  const ids = new Set(results.map(m => m.tool_call_id));
  const signature = toolSignature(calls);
  const previous = continuation && signature && calls.length === ids.size
    ? runs.find(row => row.status === "completed" && row.taskFingerprint === fingerprint &&
      row.outputToolSignature === signature && row.outputToolCallIds?.every(id => ids.has(id)))
    : null;
  return { continuation, previous, results };
}

function failedResult(message) {
  const text = messageText(message);
  if (text.length < 65536) {
    try {
      const result = JSON.parse(text);
      if (result && typeof result === "object" && !Array.isArray(result) &&
          (result.is_error === true || result.isError === true || result.success === false ||
           ["failed", "error", "failure"].includes(result.status) ||
           (result.error && result.error !== false) ||
           (typeof result.exit_code === "number" && result.exit_code !== 0))) return true;
    } catch { /* Plain tool output is common. */ }
  }
  return /(?:^|\n)\s*(?:Error:|Traceback \(|FAILED\b|Process exited with code [1-9]|(?:exit[_ -]?code|exit status)\s*[:=]?\s*[1-9])|<status>failed<\/status>/i.test(text);
}

export function decisionTrigger({ body, previous, continuation, mode, interval, configKey, office }) {
  if (!continuation) {
    if (mode === "initial" && office) return null;
    return mode !== "always" && simpleTask(currentTask(body.messages), mode) ? null : "new-task";
  }
  if (mode === "initial") return null;
  if (!previous?.decision) return "untracked-continuation";
  if (previous.decision.configKey !== configKey) return "strategy-changed";
  const lastAssistant = body.messages.findLastIndex(m => m.role === "assistant");
  if (body.messages.slice(lastAssistant + 1).some(failedResult)) return "tool-failure";
  if (mode === "always") return "every-round";
  const rounds = previous.decision.roundsSinceDecision + 1;
  const batches = body.messages.filter(m => m.role === "assistant" && m.tool_calls?.length).slice(-3);
  if (rounds >= 2 && batches.length === 3 &&
      new Set(batches.map(m => toolSignature(m.tool_calls, false))).size === 1) return "repeated-tools";
  if (rounds >= interval && !simpleTask(currentTask(body.messages))) return "periodic-review";
  return null;
}

export const decisionConfigKey = strategy => hash([
  strategy.plannerId, strategy.executorIds, strategy.plannerPrompt,
  strategy.decisionMode, strategy.decisionReviewInterval, strategy.officeRoutingEnabled,
]);

export function decisionSummary(decision, reason) {
  const labels = {
    "new-task": "新任务", "tool-failure": "工具执行失败", "repeated-tools": "重复工具循环",
    "periodic-review": "到达检查间隔", "every-round": "每轮决策", "strategy-changed": "策略配置变化",
    "untracked-continuation": "恢复未跟踪的工具会话", "tool-result-continuation": "正常工具续接",
    "office-tool-continuation": "Office 工具续接", "simple-task-direct": "简单问答直达",
    "office-preferred-direct": "Office 快速通道", "office-no-preferred-escalation": "Office 无可用快速模型",
    "office-sensitive-escalation": "重要 Office 任务由决策模型直接执行",
    "large-context-escalation": "大上下文由决策模型直接执行",
    "client-compaction": "客户端显式压缩",
  };
  const trigger = labels[decision.trigger] || decision.trigger;
  const action = decision.invoked ? `已调用决策模型 ${decision.plannerModel}（${trigger}）` :
    `本轮跳过额外决策（${trigger}）`;
  return `${action}；执行模型 ${decision.executorModel}。${reason === "planner-self-execution" ? "决策模型选择亲自接管。" : ""}${decision.plan ? "沿用当前执行建议。" : ""}`;
}

function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  return text.slice(0, head) + "\n[中间内容省略，原文仍完整传给执行模型]\n" + text.slice(-(limit - head));
}

// Bounded evidence for routing, never a replacement for the executor's original input.
export function decisionContext(body, { trigger, previous, candidates, fits, office }) {
  const task = currentTask(body.messages);
  const instructions = body.messages.filter(m => ["system", "developer"].includes(m.role))
    .map(m => `${m.role}: ${messageText(m)}`).join("\n\n");
  const evidence = body.messages.filter(m => !["system", "developer"].includes(m.role)).slice(-8);
  let scale = 1;
  while (true) {
    const clip = (text, n) => excerpt(text, Math.max(32, Math.floor(n * scale)));
    const context = {
      task: clip(task, 16000), taskCharacters: task.length, taskTruncated: task.length > 16000 * scale,
      instructions: clip(instructions, 6000), instructionsCharacters: instructions.length,
      trigger, officePreference: office || null, messageCount: body.messages.length,
      previousDecision: previous?.decision ? {
        plan: clip(previous.decision.plan || "", 2000),
        executorModelId: previous.executionModelId,
        roundsSinceDecision: previous.decision.roundsSinceDecision,
      } : null,
      recentMessages: evidence.map(m => ({
        role: m.role, content: clip(messageText(m), 1800), originalCharacters: messageText(m).length,
        ...(m.role === "tool" ? { tool_call_id: clip(m.tool_call_id, 160) } : {}),
        ...(m.tool_calls?.length ? { toolCalls: m.tool_calls.slice(0, 8).map(call => ({
          name: clip(call.function.name, 120), arguments: clip(call.function.arguments, 400),
        })) } : {}),
      })),
      availableTools: (body.tools || []).slice(0, 80).map(tool => ({
        name: clip(tool.function.name, 120), description: clip(tool.function.description || "", 180),
      })),
      totalTools: body.tools?.length || 0,
      candidates: candidates.map((m, index) => ({
        executorIndex: index, model: clip(m.model, 150), name: clip(m.name, 150),
        eligible: fits(m), contextWindow: m.contextWindow,
      })),
    };
    const serialized = JSON.stringify(context);
    if (serialized.length <= 64000) return { serialized, metadata: {
      characters: serialized.length, taskCharacters: task.length, taskTruncated: context.taskTruncated,
      recentMessages: evidence.length, contextIsExcerpt: true,
    } };
    scale /= 2;
  }
}
