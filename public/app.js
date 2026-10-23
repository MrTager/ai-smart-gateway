const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const state = {
  config: null,
  runs: [],
  selected: null,
  detail: null,
  page: "overview",
  task: "",
  demo: true,
};
const titles = {
  overview: "总览",
  models: "模型配置",
  strategy: "策略编排",
  runs: "执行记录",
};
let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4200);
}
async function api(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message || "请求失败，请检查本地服务。");
  return data;
}
const modelById = (id) => state.config.models.find((model) => model.id === id);
const number = (value) =>
  value == null ? "—" : Number(value).toLocaleString("zh-CN");
const time = (date) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const duration = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);
function pill(text, color = "") {
  return `<span class="pill ${color}">${esc(text)}</span>`;
}
function statusPill(status) {
  const names = {
    queued: ["排队中", "amber"],
    running: ["执行中", "blue"],
    completed: ["已完成", "green"],
    failed: ["失败", "red"],
    pending: ["待执行", ""],
  };
  const [text, color] = names[status] || [status, ""];
  return pill(text, color);
}
function roleName(id) {
  const s = state.config.strategy;
  if (s.plannerId === id && s.executorIds.includes(id)) return "决策 / 执行";
  if (s.plannerId === id) return "决策模型";
  if (s.executorIds.includes(id)) return "执行模型";
  if (s.review && s.reviewerId === id) return "复核模型";
  return "未分配角色";
}
function heading(eyebrow, title, description, actions = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div><div class="button-row">${actions}</div></div>`;
}
function stats() {
  const completed = state.runs.filter((run) => run.status === "completed");
  const real = state.runs.filter((run) => !run.demo);
  const tokens = real.reduce(
    (sum, run) => sum + (run.totals?.input ?? 0) + (run.totals?.output ?? 0),
    0,
  );
  const costRuns = real.filter((run) => run.totals?.cost != null);
  const cost = costRuns.length
    ? "$" + costRuns.reduce((sum, run) => sum + run.totals.cost, 0).toFixed(4)
    : "—";
  const items = [
    [
      "已配置模型",
      state.config.models.length,
      "个",
      `${state.config.models.filter((m) => m.kind === "live").length} 个真实连接 · ${state.config.models.filter((m) => m.kind === "demo").length} 个演示模型`,
      "◇",
    ],
    [
      "已完成任务",
      completed.length,
      "次",
      `演示 ${completed.filter((run) => run.demo).length} 次 · 真实 ${completed.filter((run) => !run.demo).length} 次`,
      "↗",
    ],
    [
      "真实 Token 用量",
      number(tokens),
      "",
      "仅累计服务商已报告用量，不含演示",
      "⌁",
    ],
    ["已知调用费用", cost, "", "USD · 用户单价估算，未知费用不计入", "＄"],
  ];
  return `<div class="stats-grid">${items.map(([label, value, unit, caption, icon]) => `<article class="stat-card"><div class="stat-top">${label}<span class="stat-icon">${icon}</span></div><div class="stat-number">${value}<small>${unit}</small></div><div class="stat-caption">${caption}</div></article>`).join("")}</div>`;
}
function flow() {
  const s = state.config.strategy;
  return `<section class="panel"><div class="panel-header"><div class="panel-title"><span class="tiny-icon">⑂</span>当前策略<small>让规划与执行各司其职</small></div>${pill("策略模式", "green")}</div><div class="flow-area"><div class="flow-start">↗</div><div class="flow-connector"></div><div class="flow-card accent"><div class="flow-label">01 / PLANNER<span>✳</span></div><div class="flow-name">${esc(modelById(s.plannerId)?.name || "未配置")}</div><div class="flow-caption">理解任务 · 分解执行计划</div></div><div class="flow-connector"></div><div class="flow-card"><div class="flow-label">02 / EXECUTORS<span>↗</span></div><div class="flow-name">${s.executorIds.length} 个执行模型</div><div class="flow-caption">按依赖调度 · 最多 ${s.concurrency} 路并行</div></div><div class="flow-connector"></div><div class="flow-card ${s.review ? "" : "disabled"}"><div class="flow-label">03 / REVIEW<span>✓</span></div><div class="flow-name">${s.review ? esc(modelById(s.reviewerId)?.name) : "按需复核"}</div><div class="flow-caption">${s.review ? "整合结果 · 核对交付" : "当前关闭 · 减少额外调用"}</div></div></div><div class="flow-bottom"><span><span class="connection-dot"></span>最大 ${s.maxSteps} 个子任务<span>·</span>执行模型仅接收必要指令与依赖结果</span><a href="#strategy">编辑策略 ↗</a></div></section>`;
}
function table(runs) {
  if (!runs.length)
    return '<div class="empty"><div class="empty-mark">◷</div>还没有执行记录，从一次演示任务开始吧。</div>';
  return `<div class="table-wrap"><table><thead><tr><th>任务名称</th><th>运行环境</th><th>状态</th><th>Token</th><th>耗时</th><th>创建时间</th><th></th></tr></thead><tbody>${runs.map((run) => `<tr><td><div class="task-name">${esc(run.task)}</div></td><td>${pill(run.demo ? "演示" : "真实调用", run.demo ? "amber" : "green")}</td><td>${statusPill(run.status)}</td><td class="mono">${run.totals?.input == null ? "—" : number(run.totals.input + run.totals.output)}${run.demo ? " *" : ""}</td><td class="mono">${duration(run.durationMs)}</td><td class="mono">${time(run.createdAt)}</td><td><button class="text-link" data-action="view-run" data-id="${esc(run.id)}">查看 ↗</button></td></tr>`).join("")}</tbody></table></div>`;
}
function overview() {
  return (
    heading(
      "GATEWAY OVERVIEW",
      "用合适的模型，完成每一步。",
      "深度模型负责决策，快速模型负责执行。让协作更清晰，让消耗可衡量。",
      '<button class="button secondary" data-action="add-model">＋ 添加模型</button><a class="button primary" href="#strategy">配置策略 <span>↗</span></a>',
    ) +
    `<div id="stats-area">${stats()}</div>${flow()}<div class="two-col"><section class="panel"><div class="panel-header"><div class="panel-title"><span class="tiny-icon">✳</span>开始一个任务</div>${pill("TEXT WORKFLOW")}</div><div class="panel-body"><form id="task-form"><label class="task-label" for="task-input">你希望模型协作完成什么？</label><textarea id="task-input" class="task-input" name="task" maxlength="24000" required placeholder="例如：为一个文档转换工具制定产品发布计划，包含目标用户、核心卖点和首周推广步骤。">${esc(state.task)}</textarea><div class="task-toolbar"><label class="switch-label"><input type="checkbox" name="demo" ${state.demo ? "checked" : ""}>演示运行 · 不调用真实 API</label><button class="button primary" type="submit">运行任务 <span>↗</span></button></div><p class="helper">演示展示编排流程，内容为固定示例，Token 为模拟估值。取消勾选后将使用配置的真实模型并产生费用。</p></form></div></section><section class="panel"><div class="panel-header"><div class="panel-title"><span class="tiny-icon">◇</span>模型池</div><a class="text-link" href="#models">管理模型 ↗</a></div><div class="panel-body">${state.config.models
      .slice(0, 3)
      .map(
        (model, i) =>
          `<div class="model-mini"><span class="model-symbol ${i === 0 ? "green" : i === 2 ? "orange" : ""}">${i === 0 ? "✳" : "◇"}</span><div><div class="mini-name">${esc(model.name)}</div><div class="mini-model">${esc(model.model)}</div></div>${pill(roleName(model.id), i === 0 ? "green" : "blue")}</div>`,
      )
      .join(
        "",
      )}</div></section></div><section class="panel"><div class="panel-header"><div class="panel-title"><span class="tiny-icon">◷</span>最近执行<small>完整记录每次模型协作</small></div><a class="text-link" href="#runs">全部记录 ↗</a></div><div id="recent-table">${table(state.runs.slice(0, 4))}</div></section>`
  );
}
function modelsPage() {
  return (
    heading(
      "MODEL CONNECTIONS",
      "模型配置",
      "连接你信任的模型，让决策与执行拥有各自合适的能力。",
      '<button class="button primary" data-action="add-model">＋ 添加模型</button>',
    ) +
    '<div class="notice">⌑ 密钥仅在本机加密保存，面板不会读取明文。支持 OpenAI 兼容的 Chat Completions 接口；模型 ID、价格及能力请按服务商实际情况填写。</div>' +
    `<div class="model-grid">${state.config.models.map((model, i) => `<article class="model-card"><div class="model-card-head"><span class="model-symbol ${i % 2 ? "" : "green"}">${i % 2 ? "◇" : "✳"}</span>${pill(model.kind === "demo" ? "演示模型" : "真实连接", model.kind === "demo" ? "amber" : "green")}</div><h3>${esc(model.name)}</h3><div class="mini-model">${esc(model.model)}</div><div class="endpoint">${esc(model.baseUrl || "本地模拟 · 不发生外部调用")}</div><div class="model-meta"><div><span>分配角色</span><strong>${esc(roleName(model.id))}</strong></div><div><span>密钥状态</span><strong>${model.kind === "demo" ? "无需密钥" : model.hasKey ? "已加密保存" : "未设置"}</strong></div><div><span>输出上限</span><strong class="mono">${number(model.maxTokens)} tokens</strong></div><div><span>调用超时</span><strong class="mono">${model.timeoutMs / 1000} s</strong></div></div><div class="model-actions"><button class="button ghost" data-action="test-model" data-id="${esc(model.id)}">⌁ 测试连接</button><div><button class="button ghost" data-action="edit-model" data-id="${esc(model.id)}">配置</button><button class="button ghost danger" data-action="delete-model" data-id="${esc(model.id)}" aria-label="删除 ${esc(model.name)}">×</button></div></div></article>`).join("")}</div><p class="helper">测试真实连接会发送一次简短请求，可能产生少量费用。已有策略正在使用的模型不能直接删除。</p>`
  );
}
function options(selected, empty = false) {
  return (
    (empty ? '<option value="">选择复核模型</option>' : "") +
    state.config.models
      .map(
        (model) =>
          `<option value="${esc(model.id)}" ${model.id === selected ? "selected" : ""}>${esc(model.name)}${model.kind === "demo" ? "（演示）" : ""}</option>`,
      )
      .join("")
  );
}
function strategyPage() {
  const s = state.config.strategy;
  return (
    heading(
      "STRATEGY ORCHESTRATION",
      "策略编排",
      "一次规划，多路执行。你决定谁来思考，谁来行动。",
      pill("策略模式", "green"),
    ) +
    flow() +
    `<div class="strategy-grid"><section class="panel"><div class="panel-header"><div class="panel-title">角色与调度设置</div>${pill("可配置")}</div><div class="panel-body"><form id="strategy-form"><div class="form-grid"><label class="span-2">决策模型<select name="plannerId" required>${options(s.plannerId)}</select><small>分析任务，生成结构化步骤、模型分工与依赖关系。</small></label><div class="span-2"><label>执行模型池</label>${state.config.models.map((model) => `<label class="executor-option"><input type="checkbox" name="executorIds" value="${esc(model.id)}" ${s.executorIds.includes(model.id) ? "checked" : ""}>${esc(model.name)}<small>${esc(model.model)}</small></label>`).join("")}</div><label>最多子任务<input name="maxSteps" type="number" min="1" max="8" value="${s.maxSteps}" required></label><label>并行执行数<input name="concurrency" type="number" min="1" max="4" value="${s.concurrency}" required></label><label class="span-2">复核模型<select name="reviewerId">${options(s.reviewerId, true)}</select></label></div><label class="checkbox-line"><input type="checkbox" name="review" ${s.review ? "checked" : ""}>执行完毕后使用复核模型整合结果（增加一次调用）</label><label>附加规划偏好<textarea name="plannerPrompt" rows="3" maxlength="4000">${esc(s.plannerPrompt)}</textarea></label><div class="dialog-actions"><button type="submit" class="button primary">保存策略 <span>✓</span></button></div></form></div></section><div><section class="panel strategy-explanation"><h3>模型如何协作？</h3><div class="explanation-step" data-step="1"><strong>先规划，再执行</strong><p>决策模型只输出结构化计划，不重复完成整个任务。执行模型只接收当前指令与直接依赖的结果。</p></div><div class="explanation-step" data-step="2"><strong>有依赖的顺序执行</strong><p>独立步骤最多按并行数同时执行；依赖步骤等待前置任务完成，循环和无效依赖会被拒绝。</p></div><div class="explanation-step" data-step="3"><strong>复核按需开启</strong><p>默认直接交付最终步骤的输出。开启复核后，额外调用所选模型整合、审查所有步骤。</p></div></section><div class="notice">不是每个任务都需要多模型。规划、交接和复核都有成本；请用同一任务比较结果质量、总耗时和实际费用。当前不提供未经测量的“节省率”。</div></div></div>`
  );
}
function runsList() {
  if (!state.runs.length) return '<div class="empty">还没有任务记录</div>';
  return state.runs
    .map(
      (run) =>
        `<div class="run-item ${run.id === state.selected ? "selected" : ""}" role="button" tabindex="0" data-action="view-run" data-id="${esc(run.id)}">${statusPill(run.status)}<div class="run-item-title">${esc(run.task)}</div><div class="run-item-meta"><span>${time(run.createdAt)}</span><span>${run.demo ? "演示" : "真实"} · ${duration(run.durationMs)}</span></div></div>`,
    )
    .join("");
}
function runDetail() {
  const run = state.detail;
  if (!run)
    return '<div class="empty"><div class="empty-mark">↖</div>选择一条任务，查看完整执行过程。</div>';
  const stage = {
    planning: "决策模型正在制定计划",
    executing: "执行模型正在完成子任务",
    reviewing: "正在复核与整合结果",
    done: "所有步骤已完成",
  };
  return `<div class="panel-header"><div class="panel-title">任务详情 ${pill(run.demo ? "演示 · 模拟数据" : "真实 API 调用", run.demo ? "amber" : "green")}</div>${statusPill(run.status)}</div><div class="run-detail"><p class="run-task">${esc(run.task)}</p>${run.status === "running" ? `<div class="live-indicator"><span class="connection-dot pulse"></span>${stage[run.stage] || "正在执行"}</div>` : ""}<div class="run-metrics"><span>调用 ${run.totals.calls} 次</span><span>${run.demo ? "模拟" : "已报告"} Token ${run.totals.input == null ? "未知" : number(run.totals.input + run.totals.output)}</span><span>耗时 ${duration(run.durationMs)}</span><span>费用 ${run.totals.cost == null ? "未知 / 不适用" : "$" + run.totals.cost.toFixed(6)}</span></div>${run.summary ? `<p class="helper">${esc(run.summary)}</p>` : ""}${run.steps.map((step) => `<div class="run-step"><div class="run-step-head"><span>${esc(step.id)} · ${esc(step.title)}</span>${statusPill(step.status)}</div><p>${esc(modelById(step.modelId)?.name || "历史模型")} · ${step.dependsOn.length ? "依赖 " + esc(step.dependsOn.join(", ")) : "独立步骤"}</p><p>${esc(step.instruction)}</p><details><summary class="text-link">查看步骤输出</summary><pre class="run-output">${esc(step.output || "等待输出…")}</pre></details></div>`).join("")}${run.error ? `<div class="notice error-text">${esc(run.error)}</div>` : ""}${run.result ? `<div class="panel-title">最终交付内容</div><pre class="run-output">${esc(run.result)}</pre><button class="button secondary" data-action="copy-result">复制结果</button>` : ""}${run.calls.length ? `<details><summary class="helper">查看调用用量明细</summary><div class="call-list">${run.calls.map((call) => `${esc(call.role)} / ${esc(call.modelName)} · 输入 ${number(call.usage.input)} / 输出 ${number(call.usage.output)} · ${duration(call.latencyMs)} · ${esc(call.usage.source)}`).join("<br>")}</div></details>` : ""}</div>`;
}
function runsPage() {
  return (
    heading(
      "EXECUTION HISTORY",
      "执行记录",
      "从规划到交付，每一次调用都有迹可循。",
      '<a class="button primary" href="#overview">＋ 新建任务</a>',
    ) +
    `<div class="run-layout"><section class="panel"><div class="panel-header"><div class="panel-title">最近任务</div>${pill("最近 100 条")}</div><div class="run-list" id="runs-list">${runsList()}</div></section><section class="panel" id="run-detail">${runDetail()}</section></div>`
  );
}
function render() {
  if (!state.config) return;
  const page = location.hash.slice(1);
  state.page = titles[page] ? page : "overview";
  document
    .querySelectorAll("nav a")
    .forEach((anchor) =>
      anchor.classList.toggle("active", anchor.dataset.page === state.page),
    );
  $("#breadcrumb").textContent = titles[state.page];
  $("#model-count").textContent = state.config.models.length;
  $("#content").innerHTML = {
    overview,
    models: modelsPage,
    strategy: strategyPage,
    runs: runsPage,
  }[state.page]();
}
async function refreshRuns() {
  state.runs = await api("/api/runs");
  if (state.selected) state.detail = await api(`/api/runs/${state.selected}`);
  if (state.page === "runs") {
    $("#runs-list").innerHTML = runsList();
    $("#run-detail").innerHTML = runDetail();
  }
  if (state.page === "overview") {
    $("#stats-area").innerHTML = stats();
    $("#recent-table").innerHTML = table(state.runs.slice(0, 4));
  }
}
function showModel(model = {}) {
  const form = $("#model-form");
  form.reset();
  $("#model-error").textContent = "";
  $("#model-dialog-title").textContent = model.id ? "配置模型" : "添加模型";
  for (const key of [
    "id",
    "name",
    "model",
    "baseUrl",
    "kind",
    "maxTokens",
    "tokenParameter",
    "inputPrice",
    "outputPrice",
  ]) {
    if (model[key] !== undefined) form.elements[key].value = model[key] ?? "";
  }
  if (model.temperature !== undefined)
    form.elements.temperature.value = model.temperature ?? "";
  if (model.timeoutMs)
    form.elements.timeoutSeconds.value = model.timeoutMs / 1000;
  form.elements.jsonMode.checked = Boolean(model.jsonMode);
  form.elements.apiKey.placeholder = model.hasKey
    ? "已保存 · 留空保持不变"
    : "输入 API Key（本地模型可留空）";
  $("#model-dialog").showModal();
}
document.addEventListener("input", (event) => {
  if (event.target.id === "task-input") state.task = event.target.value;
});
document.addEventListener("change", (event) => {
  if (event.target.name === "demo") state.demo = event.target.checked;
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  try {
    if (action === "add-model") showModel();
    if (action === "edit-model") showModel(modelById(id));
    if (action === "close-modal") $("#model-dialog").close();
    if (action === "test-model") {
      if (
        modelById(id)?.kind === "live" &&
        !confirm("将发送一次真实模型请求，可能产生少量费用。继续？")
      )
        return;
      target.disabled = true;
      try {
        const result = await api(`/api/models/${id}/test`, "POST");
        toast(`${result.message} · ${result.latencyMs} ms`);
      } finally {
        target.disabled = false;
      }
    }
    if (action === "delete-model" && confirm("确认删除这个模型配置？")) {
      state.config = await api(`/api/models/${id}`, "DELETE");
      render();
      toast("模型已删除");
    }
    if (action === "view-run") {
      state.selected = id;
      state.detail = await api(`/api/runs/${id}`);
      if (location.hash !== "#runs") location.hash = "runs";
      else render();
    }
    if (action === "copy-result") {
      await navigator.clipboard.writeText(state.detail.result);
      toast("已复制结果");
    }
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("keydown", (event) => {
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches(".run-item")
  ) {
    event.preventDefault();
    event.target.click();
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  // A named input 'id' shadows HTMLFormElement.id; never use that property here.
  const formId = form.getAttribute("id");
  if (!["model-form", "strategy-form", "task-form"].includes(formId)) return;
  event.preventDefault();
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  const data = new FormData(form);
  try {
    if (formId === "model-form") {
      const body = Object.fromEntries(data);
      body.maxTokens = Number(body.maxTokens);
      body.timeoutMs = Number(body.timeoutSeconds) * 1000;
      body.temperature =
        body.temperature === "" ? null : Number(body.temperature);
      body.jsonMode = data.has("jsonMode");
      body.clearKey = data.has("clearKey");
      state.config = await api(
        body.id ? `/api/models/${body.id}` : "/api/models",
        body.id ? "PUT" : "POST",
        body,
      );
      $("#model-dialog").close();
      form.elements.apiKey.value = "";
      render();
      toast("模型配置已保存");
    }
    if (formId === "strategy-form") {
      const body = {
        ...Object.fromEntries(data),
        executorIds: data.getAll("executorIds"),
        review: data.has("review"),
        maxSteps: Number(data.get("maxSteps")),
        concurrency: Number(data.get("concurrency")),
      };
      state.config = await api("/api/strategy", "PUT", body);
      render();
      toast("策略已保存");
    }
    if (formId === "task-form") {
      const run = await api("/api/runs", "POST", {
        task: data.get("task"),
        demo: data.has("demo"),
      });
      state.selected = run.id;
      await refreshRuns();
      location.hash = "runs";
    }
  } catch (error) {
    if (formId === "model-form") $("#model-error").textContent = error.message;
    else toast(error.message);
  } finally {
    submit.disabled = false;
  }
});
window.addEventListener("hashchange", render);
$("#content").innerHTML = '<div class="loading">正在连接本地网关…</div>';
try {
  state.config = await api("/api/config");
  state.runs = await api("/api/runs");
  render();
} catch (error) {
  $("#content").innerHTML =
    `<div class="notice error-text">${esc(error.message)}</div>`;
}
setInterval(() => {
  if (state.config && !document.hidden) refreshRuns().catch(() => {});
}, 1800);
