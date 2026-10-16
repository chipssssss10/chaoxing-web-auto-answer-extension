import "./shared.js";
const C = globalThis.CXCore;
const secured = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const pending = new Map();
const mutations = new Map();
// Serialize short state changes, while leaving long AI calls outside the queue so Stop stays responsive.
function serial(tabId, action) {
  const previous = mutations.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  mutations.set(tabId, next);
  const clean = () => { if (mutations.get(tabId) === next) mutations.delete(tabId); };
  next.then(clean, clean);
  return next;
}
const keyFor = (tabId) => `run:${tabId}`;
const wrongKey = tabId => `wrongScan:${tabId}`;
const getRun = async (tabId) => (await chrome.storage.session.get(keyFor(tabId)))[keyFor(tabId)];
const putRun = async (run) => chrome.storage.session.set({ [keyFor(run.tabId)]: { ...run, updatedAt: Date.now() } });
async function config(required = false) {
  await secured;
  return C.settings((await chrome.storage.local.get("settings")).settings, required);
}
function trustedUI(sender) { return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL("")); }
function requireUI(sender) { if (!trustedUI(sender)) throw new Error("此操作只允许扩展设置页或弹窗调用。"); }
async function current(sender, token) {
  const run = await getRun(sender.tab?.id);
  if (!run || run.token !== token || run.frameId !== sender.frameId || !["running", "navigating", "submitting"].includes(run.status)) throw new Error("任务已停止或已更换，请重新开始。");
  if (Date.now() - run.updatedAt > 10 * 60 * 1000) throw new Error("任务长时间无响应，请重新开始。");
  if (C.scope(sender.url) !== run.scope) throw new Error("答题页面或作业身份已变化，已停止。");
  return run;
}
async function signal(run, message) {
  try { return await chrome.tabs.sendMessage(run.tabId, message, { frameId: run.frameId }); } catch { return null; }
}
async function stop(tabId, status = "stopped", message = "已停止。") {
  pending.get(tabId)?.controller.abort();
  pending.delete(tabId);
  const run = await getRun(tabId);
  if (!run) return null;
  run.status = status; run.message = message;
  // Notify the page before waiting for storage so popup Stop is also responsive.
  await signal(run, { type: "CX_HALT", token: run.token, message, dismiss: status === "stopped" });
  await putRun(run);
  return run;
}
async function callAI(settings, question, controller) {
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, settings.requestTimeoutMs);
  try {
    const response = await fetch(settings.endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(C.requestBody(settings, question)), signal: controller.signal,
      credentials: "omit", redirect: "error", cache: "no-store"
    });
    // Do not surface arbitrary provider error bodies; they may echo the request or credentials.
    if (!response.ok) throw new Error(({401: "API 密钥无效或已失效。", 403: "API 无访问权限。", 404: "API 地址或模型不存在。", 429: "接口限流或额度不足，请稍后重试。"})[response.status] || `AI 服务返回 HTTP ${response.status}。`);
    let data;
    try { data = await response.json(); } catch { throw new Error("AI 接口未返回合法 JSON 响应。"); }
    if (data.choices?.[0]?.finish_reason === "length") throw new Error("AI 输出被截断，请调整模型或接口配置。");
    return C.parseAnswer(data.choices?.[0]?.message?.content, question);
  } catch (e) {
    if (controller.signal.aborted) {
      const error = new Error(timedOut ?
        `AI 接口请求超时（已等待 ${settings.requestTimeoutMs / 1000} 秒），本次请求已取消，任务已暂停。请检查网络、调整设置中的接口超时或更换模型，然后重新开始。` : "请求已取消。");
      error.code = timedOut ? "API_TIMEOUT" : "CANCELLED"; throw error;
    }
    if (e instanceof TypeError) throw new Error("无法连接 AI 接口，请检查网络、API 地址及站点授权。");
    throw e;
  } finally { clearTimeout(timeout); }
}
async function dispatch(message, sender) {
  switch (message?.type) {
    case "CX_CONFIG": return C.publicSettings(await config());
    case "CX_OPEN_OPTIONS": await chrome.runtime.openOptionsPage(); return true;
    case "CX_TEST": {
      requireUI(sender);
      const cfg = await config(true);
      const answer = await callAI(cfg, { type: "single", stem: "1 + 1 等于几？", options: [{label:"A", text:"2"}, {label:"B", text:"3"}] }, new AbortController());
      return { ...answer, passed: answer.answers.join("") === "A" };
    }
    case "CX_PROBE": {
      requireUI(sender);
      const cfg = await config();
      await chrome.scripting.executeScript({ target: { tabId: message.tabId, allFrames: true }, files: ["shared.js", "dom.js", "content.js"] });
      const frames = await chrome.scripting.executeScript({ target: { tabId: message.tabId, allFrames: true }, args: [cfg.selectors], func: selectors => ({ href: location.href, questions: globalThis.CXDOM.scan(selectors).map(globalThis.CXDOM.wire) }) });
      return frames.filter(f => f.result?.questions.length).map(f => ({ frameId: f.frameId, ...f.result }));
    }
    case "CX_SCAN_WRONG": {
      requireUI(sender);
      const cfg = await config();
      await chrome.scripting.executeScript({ target: { tabId: message.tabId, allFrames: true }, files: ["shared.js", "dom.js", "content.js"] });
      const frames = await chrome.scripting.executeScript({ target: { tabId: message.tabId, allFrames: true }, args: [cfg.selectors], func: selectors => ({ href: location.href, questions: globalThis.CXDOM.scanGrading(selectors) }) });
      const result = { scannedAt: Date.now(), frames: frames.filter(f => f.result?.questions.length).map(f => ({ frameId: f.frameId, ...f.result })) };
      await chrome.storage.session.set({ [wrongKey(message.tabId)]: result }); return result;
    }
    case "CX_WRONG_STATUS": {
      requireUI(sender); return (await chrome.storage.session.get(wrongKey(message.tabId)))[wrongKey(message.tabId)] || null;
    }
    case "CX_STATUS": {
      if (trustedUI(sender)) return (await getRun(message.tabId)) || null;
      return current(sender, message.token);
    }
    case "CX_START": {
      requireUI(sender);
      const cfg = await config(true);
      const previous = await getRun(message.tabId);
      if (previous && ["running", "navigating", "submitting"].includes(previous.status)) throw new Error("已有任务运行，请先停止再开始。");
      const inspection = await chrome.tabs.sendMessage(message.tabId, { type: "CX_INSPECT", selectors: cfg.selectors }, { frameId: message.frameId });
      if (!inspection?.questions?.length) throw new Error("没有识别到题目，请先扫描页面。");
      const run = { token: crypto.randomUUID(), tabId: message.tabId, frameId: message.frameId,
        scope: C.scope(inspection.href), status: "running", mode: message.mode === "single" ? "single" : "auto",
        completed: [], lowConfidence: [], settings: C.publicSettings(cfg), message: "正在识别题目…", startedAt: Date.now(), updatedAt: Date.now() };
      await putRun(run);
      const result = await signal(run, { type: "CX_BEGIN", run });
      if (!result?.accepted) { await stop(run.tabId, "paused", "页面未接受任务，请刷新页面后重试。"); throw new Error("页面未接受任务，请刷新页面后重试。"); }
      return run;
    }
    case "CX_HELLO": {
      if (!sender.tab) return null;
      const run = await getRun(sender.tab.id);
      if (!run || run.frameId !== sender.frameId) return null;
      if (run.status === "submitting") {
        await stop(run.tabId, "stopped", "提交后页面已跳转，请在页面确认最终结果。");
        return { reviewOnly: true, run: await getRun(run.tabId) };
      }
      if (run.status !== "navigating") return null;
      if (Date.now() - run.updatedAt > 60000 || C.scope(sender.url) !== run.scope) {
        await stop(run.tabId, "paused", "翻页超过时限或作业身份变化，请检查后重新开始。"); return null;
      }
      run.status = "running"; run.message = "翻页完成，继续识别…"; await putRun(run);
      return run;
    }
    case "CX_STOP": {
      if (trustedUI(sender)) return stop(message.tabId);
      const run = await getRun(sender.tab?.id);
      // Allow dismissing the panel after completion/timeout as well as during an active task.
      if (!run || run.token !== message.token || run.frameId !== sender.frameId || C.scope(sender.url) !== run.scope) throw new Error("任务已更换，请重新打开扩展查看。");
      return stop(sender.tab.id);
    }
    case "CX_ANSWER": {
      const question = C.validateQuestion(message.question);
      const controller = new AbortController();
      const request = { controller, token: message.token };
      let run = await serial(sender.tab?.id, async () => {
        const currentRun = await current(sender, message.token);
        if (currentRun.completed.length >= currentRun.settings.maxQuestions) throw new Error("已达到本次题数上限，已暂停。");
        if (pending.has(currentRun.tabId)) throw new Error("上一道题仍在请求中。");
        currentRun.status = "running"; currentRun.message = `AI 正在解答第 ${currentRun.completed.length + 1} 题…`;
        await putRun(currentRun); pending.set(currentRun.tabId, request); return currentRun;
      });
      try {
        const answer = await callAI(await config(true), question, controller);
        return await serial(run.tabId, async () => {
          run = await current(sender, message.token);
          const lowConfidence = answer.confidence < run.settings.minConfidence;
          if (lowConfidence) {
            run.lowConfidence ||= [];
            if (!run.lowConfidence.some(item => item.key === message.question.key)) run.lowConfidence.push({
              key: message.question.key, number: run.completed.length + 1, stem: question.stem.slice(0, 1200),
              answers: answer.answers, confidence: answer.confidence, explanation: answer.explanation.slice(0, 600)
            });
            await putRun(run);
          }
          return { ...answer, lowConfidence };
        });
      } finally { if (pending.get(run.tabId) === request) pending.delete(run.tabId); }
    }
    case "CX_RECORD": {
      const run = await current(sender, message.token);
      if (!run.completed.some(item => item.key === message.key)) run.completed.push({ key: message.key, answers: message.answers, confidence: message.confidence, stem: String(message.stem).slice(0, 180), explanation: String(message.explanation).slice(0, 600) });
      run.message = `已确认选中 ${run.completed.length} 题。`; await putRun(run); return run;
    }
    case "CX_PHASE": {
      const run = await current(sender, message.token);
      if (!["running", "navigating", "submitting"].includes(message.phase)) throw new Error("无效任务状态。");
      if (message.phase === "submitting" && (!run.settings.autoSubmit || run.mode !== "auto" || !run.completed.length)) throw new Error("自动提交未启用。");
      run.status = message.phase; run.message = String(message.message || "").slice(0, 1000); await putRun(run); return true;
    }
    case "CX_END": {
      const run = await current(sender, message.token);
      if (!message.success && pending.get(run.tabId)?.token === run.token) pending.get(run.tabId).controller.abort();
      run.status = message.success ? "complete" : "paused"; run.message = String(message.message).slice(0, 3000);
      run.errorCode = message.code || null; await putRun(run); return run;
    }
    default: throw new Error("未知扩展命令。");
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message?.type?.startsWith("CX_")) return false;
  const needsSerial = ["CX_START", "CX_STOP", "CX_RECORD", "CX_PHASE", "CX_END", "CX_HELLO"].includes(message.type);
  const tabId = trustedUI(sender) ? message.tabId : sender.tab?.id;
  const result = needsSerial ? serial(tabId, () => dispatch(message, sender)) : dispatch(message, sender);
  result.then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error.message || "扩展操作失败。", code: error.code }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { pending.get(tabId)?.controller.abort(); pending.delete(tabId); chrome.storage.session.remove([keyFor(tabId), wrongKey(tabId)]); });
