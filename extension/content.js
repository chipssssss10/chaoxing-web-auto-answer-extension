(function (root) {
  if (root.CXHelper) return;
  const D = root.CXDOM;
  const helper = root.CXHelper = { selectors: {}, token: null, busy: false, halted: false, task: null };
  let panel, messageNode, detailNode, noticeNode, reviewNode, noticeTimer;
  async function send(type, data = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...data });
    if (!result?.ok) {
      const error = new Error(result?.error || "扩展连接已断开，请刷新页面。");
      error.code = result?.code; throw error;
    }
    return result.data;
  }
  const stoppedError = () => new DOMException("任务已停止。", "AbortError");
  function taskSignal(token) {
    const task = helper.task;
    if (!task || task.token !== token || task.controller.signal.aborted) throw stoppedError();
    return task.controller.signal;
  }
  async function taskSend(type, data, token) {
    const signal = taskSignal(token);
    // Stop releases the local runner immediately, even if the background reply is delayed.
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(stoppedError()); };
      signal.addEventListener("abort", abort, { once: true });
      send(type, data).then(value => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(stoppedError()); else resolve(value);
      }, error => { signal.removeEventListener("abort", abort); reject(error); });
    });
  }
  function sleep(ms, token) {
    const signal = taskSignal(token);
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(stoppedError()); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  function halt(token) {
    if (token !== helper.token) return;
    helper.halted = true;
    helper.task?.controller.abort();
    helper.busy = false;
    clearTimeout(noticeTimer);
    panel?.remove(); panel = null;
  }
  function show(message, detail = "", error = false) {
    if (helper.halted) return;
    if (!panel?.isConnected) {
      panel = document.createElement("div"); panel.dataset.cxHelper = "true";
      panel.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647";
      const shadow = panel.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = ":host{all:initial}section{font:14px/1.6 system-ui,sans-serif;width:310px;background:#142a31;color:#eef8f8;border:1px solid #437d7b;border-radius:16px;padding:18px;box-shadow:0 12px 40px #0003}header{display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:10px}small{color:#a8c8c6}p{margin:8px 0;overflow-wrap:anywhere}details{max-height:170px;overflow:auto;color:#b8d6d4;font-size:12px}button{cursor:pointer;border:1px solid #6a9695;background:transparent;color:#fff;padding:4px 12px;border-radius:8px}";
      style.textContent += "section{max-height:75vh;overflow:auto}.notice{background:#604817;border:1px solid #b79343;color:#fff1ce;border-radius:8px;padding:9px;margin:8px 0;font-size:12px}.review{border-top:1px solid #43716f;margin:10px 0;padding-top:10px;max-height:240px}.review p{margin:6px 0}.review ol{padding-left:20px}.review li{margin:10px 0;overflow-wrap:anywhere;white-space:pre-line}[hidden]{display:none!important}";
      const section = document.createElement("section");
      const header = document.createElement("header"); header.textContent = "学习通 AI 助手";
      const stop = document.createElement("button"); stop.textContent = "停止";
      stop.addEventListener("click", () => {
        const token = helper.token;
        halt(token);
        send("CX_STOP", { token }).catch(() => {});
      });
      header.append(stop); messageNode = document.createElement("p");
      detailNode = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "识别 / 答案依据";
      const pre = document.createElement("p"); detailNode.append(summary, pre);
      noticeNode = document.createElement("div"); noticeNode.className = "notice"; noticeNode.setAttribute("role", "status"); noticeNode.hidden = true;
      reviewNode = document.createElement("details"); reviewNode.className = "review"; reviewNode.hidden = true;
      const note = document.createElement("small"); note.textContent = "AI 答案需要核验 · 可随时停止";
      section.append(header, messageNode, noticeNode, detailNode, reviewNode, note); shadow.append(style, section); document.documentElement.append(panel);
    }
    messageNode.textContent = message;
    messageNode.setAttribute("role", error ? "alert" : "status");
    detailNode.lastElementChild.textContent = detail;
    detailNode.open = error;
  }
  function warnLowConfidence(question, answer, run) {
    if (helper.halted) return;
    clearTimeout(noticeTimer);
    noticeNode.textContent = `本次第 ${run.completed.length + 1} 题 AI 自评率较低（${(answer.confidence * 100).toFixed(0)}%，低于 ${(run.settings.minConfidence * 100).toFixed(0)}%），已记录，继续作答。`;
    noticeNode.title = question.stem; noticeNode.hidden = false;
    noticeTimer = setTimeout(() => { noticeNode.hidden = true; }, 3000);
  }
  function showCompletion(run, message, detail = "") {
    show(message, detail);
    if (helper.halted) return;
    const summary = root.CXCore.reviewSummary(run);
    const heading = document.createElement("summary"); heading.textContent = "AI 自评率汇总";
    const info = document.createElement("p"); info.textContent = summary.message;
    const list = document.createElement("ol");
    for (const item of summary.items) {
      const row = document.createElement("li");
      row.textContent = `本次第 ${item.number} 题 · AI 自评 ${(item.confidence * 100).toFixed(0)}% · AI 选项 ${item.answers.join("、")}\n${item.stem}`;
      list.append(row);
    }
    reviewNode.replaceChildren(heading, info, list); reviewNode.hidden = false; reviewNode.open = true;
  }
  function localCheck(token) {
    if (helper.halted || helper.token !== token) throw new Error("任务已停止。");
    taskSignal(token);
    if (D.blocked()) throw new Error("页面要求验证或重新登录，请手动处理后重新开始。");
  }
  async function active(token) {
    localCheck(token);
    await taskSend("CX_STATUS", { token }, token);
    localCheck(token);
  }
  function fresh(original, selectors) {
    const q = D.scan(selectors).find(item => item.key === original.key);
    if (!q || q.issue) throw new Error("题目在请求期间发生变化或已无法识别，已暂停。");
    return q;
  }
  async function choose(question, answer, run) {
    const desired = new Set(answer.answers);
    // Re-read before every click; frameworks may replace an entire question after a change event.
    let q = fresh(question, run.settings.selectors);
    for (const label of q.options.map(o => o.label)) {
      await active(run.token);
      q = fresh(question, run.settings.selectors);
      const option = q.optionNodes.find(o => o.label === label);
      const selected = D.selected(option), wanted = desired.has(label);
      if (selected === wanted) continue;
      if (!wanted && q.type !== "multiple") continue; // Selecting a radio clears its group.
      if (option.input?.disabled || D.disabled(option.el)) throw new Error("选项不可点击，已暂停。");
      option.el.scrollIntoView({ block: "nearest", behavior: "instant" });
      (option.input || option.el).click();
      await sleep(180, run.token);
    }
    q = fresh(question, run.settings.selectors);
    const actual = q.optionNodes.filter(D.selected).map(o => o.label).sort();
    if (JSON.stringify(actual) !== JSON.stringify(answer.answers.slice().sort())) throw new Error(`无法确认答案已选中（期望 ${answer.answers.join("、")}，页面显示 ${actual.join("、") || "无"}）。请检查选项适配。`);
  }
  async function submit(run) {
    await active(run.token);
    const button = D.button("submit", run.settings.selectors);
    if (D.disabled(button)) throw new Error("未找到可用的提交按钮，请手动提交或配置提交选择器。");
    await taskSend("CX_PHASE", { token: run.token, phase: "submitting", message: "题目已选中，正在提交…" }, run.token);
    localCheck(run.token); button.click();
    let confirmed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250, run.token); localCheck(run.token);
      if (D.submitted()) {
        run = await taskSend("CX_END", { token: run.token, success: true, message: "页面显示提交成功。" }, run.token);
        showCompletion(run, "页面显示提交成功。", `本次已确认选中 ${run.completed.length} 题。`); return;
      }
      if (!confirmed) {
        const confirm = D.confirmSubmit();
        if (confirm && !D.disabled(confirm)) { await active(run.token); confirm.click(); confirmed = true; }
      }
    }
    throw new Error("已点击提交，但未识别到成功结果，请在页面手动确认。原生浏览器确认框需要手动处理。");
  }
  async function drive(run) {
    const task = { token: run.token, controller: new AbortController() };
    helper.task = task;
    helper.busy = true; helper.token = run.token; helper.halted = false; helper.selectors = run.settings.selectors;
    clearTimeout(noticeTimer);
    if (noticeNode) noticeNode.hidden = true;
    if (reviewNode) reviewNode.hidden = true;
    try {
      show("正在识别题目…");
      let questions = [];
      for (let i = 0; i < 32; i++) {
        localCheck(run.token); questions = D.scan(helper.selectors);
        if (questions.length) break;
        await sleep(250, run.token);
      }
      if (!questions.length) throw new Error("未识别到题目，请检查页面或 CSS 选择器。");
      while (true) {
        await active(run.token);
        questions = D.scan(helper.selectors);
        if (!questions.length) throw new Error("页面题目消失，已暂停。");
        if (new Set(questions.map(q => q.key)).size !== questions.length) throw new Error("存在无法区分的重复题目，请为题目容器保留唯一 ID。");
        const done = new Set(run.completed.map(item => item.key));
        // Do not silently skip unsupported questions and later submit an incomplete paper.
        const invalid = questions.find(q => q.issue);
        if (invalid) throw new Error(`第 ${invalid.index + 1} 个题块：${invalid.issue}`);
        const question = questions.find(q => !done.has(q.key));
        if (question) {
          if (run.completed.length >= run.settings.maxQuestions) throw new Error("已达到本次题数上限；检查后可重新开始。");
          show(`AI 正在解答第 ${run.completed.length + 1} 题…`, question.stem);
          const answer = await taskSend("CX_ANSWER", { token: run.token, question: D.wire(question) }, run.token);
          await active(run.token);
          show(`参考答案 ${answer.answers.join("、")} · AI 自评 ${(answer.confidence * 100).toFixed(0)}%`, answer.explanation);
          if (answer.lowConfidence) warnLowConfidence(question, answer, run);
          await choose(question, answer, run);
          run = await taskSend("CX_RECORD", { token: run.token, key: question.key, stem: question.stem, answers: answer.answers, confidence: answer.confidence, explanation: answer.explanation }, run.token);
          if (run.mode === "single") {
            run = await taskSend("CX_END", { token: run.token, success: true, message: "本题已选中，停留当前页。" }, run.token);
            showCompletion(run, "本题已选中，停留当前页。", answer.explanation); return;
          }
          await sleep(run.settings.delayMs, run.token);
          continue;
        }
        // Verify all previously processed answers visible on this page before moving on.
        for (const q of questions) {
          const expected = run.completed.find(item => item.key === q.key)?.answers;
          const actual = q.optionNodes.filter(D.selected).map(o => o.label).sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected?.slice().sort())) throw new Error("已答题目的选中状态发生变化，已暂停。");
        }
        const next = D.button("next", helper.selectors);
        if (next && !D.disabled(next)) {
          await active(run.token);
          await taskSend("CX_PHASE", { token: run.token, phase: "navigating", message: "已确认当前页，正在进入下一题…" }, run.token);
          localCheck(run.token); next.click();
          let changed = false;
          for (let i = 0; i < 48; i++) {
            await sleep(250, run.token); localCheck(run.token);
            const newQuestions = D.scan(helper.selectors);
            if (newQuestions.length && newQuestions.some(q => !done.has(q.key))) { changed = true; break; }
          }
          if (!changed) throw new Error("点击下一题后 12 秒内没有识别到新题，已暂停。");
          await taskSend("CX_PHASE", { token: run.token, phase: "running", message: "下一题已加载。" }, run.token);
          continue;
        }
        if (!run.settings.autoSubmit) {
          run = await taskSend("CX_END", { token: run.token, success: true, message: "已选完识别到的题目，请检查并手动提交。" }, run.token);
          showCompletion(run, "已选完识别到的题目，请检查并手动提交。", `本次已确认选中 ${run.completed.length} 题。`); return;
        }
        if (next) throw new Error("下一题按钮处于禁用状态，无法确认是否已到最后一题，已暂停提交。");
        await submit(run); return;
      }
    } catch (e) {
      // A late response from a stopped task must never recreate its panel or affect a new task.
      if (helper.task !== task || task.controller.signal.aborted || helper.halted) return;
      show(e.code === "API_TIMEOUT" ? "AI 接口请求超时，已暂停" : "已暂停", e.message, true);
      await taskSend("CX_END", { token: run.token, success: false, message: e.message, code: e.code }, run.token).catch(() => {});
    } finally { if (helper.task === task) helper.busy = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === "CX_HALT") {
      if (message.dismiss !== false) halt(message.token);
      else if (message.token === helper.token && !helper.halted) {
        helper.task?.controller.abort(); helper.busy = false;
        show("已暂停", message.message, true);
      }
      reply({ accepted: true }); return false;
    }
    if (message?.type === "CX_INSPECT") {
      try { helper.selectors = message.selectors; reply({ href: location.href, questions: D.scan(helper.selectors).map(D.wire) }); }
      catch (e) { reply({ error: e.message }); }
      return false;
    }
    if (message?.type === "CX_BEGIN") {
      if (helper.busy) { reply({ accepted: false }); return false; }
      reply({ accepted: true }); void drive(message.run); return false;
    }
    return false;
  });
  void send("CX_CONFIG").then(cfg => { helper.selectors = cfg.selectors; return send("CX_HELLO"); }).then(result => {
    if (result?.reviewOnly) {
      helper.token = result.run.token;
      showCompletion(result.run, result.run.message, `本次已确认选中 ${result.run.completed.length} 题。`);
    } else if (result && !helper.busy) void drive(result);
  }).catch(() => {});
})(globalThis);
