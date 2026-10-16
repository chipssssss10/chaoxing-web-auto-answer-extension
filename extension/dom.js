(function (root) {
  if (root.CXDOM) return;
  const C = root.CXCore;
  const DEFAULT = {
    question: ".TiMu, .questionLi, .question-item, [data-question-id], [data-question], fieldset.question",
    stem: ".Zy_TItle, .mark_name, .question-title, .question-stem, [data-role='stem'], legend",
    option: ".Zy_ulTop > li, .mark_letter > li, .stem_answer > li, .question-options > li, .options > li, [data-option], [role='radio'], [role='checkbox']"
  };
  function visible(el) {
    if (!el?.isConnected || el.closest("[data-cx-helper]")) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && el.getClientRects().length > 0;
  }
  function text(el) {
    if (!el) return "";
    const copy = el.cloneNode(true);
    copy.querySelectorAll("script, style, input, select, textarea, [data-cx-helper], .sr-only").forEach(n => n.remove());
    return C.normalize(copy.textContent);
  }
  function queryAll(el, selector) {
    try { return [...el.querySelectorAll(selector)]; } catch { throw new Error(`CSS 选择器无效：${selector}`); }
  }
  function rows(container, custom) {
    let list = queryAll(container, custom || DEFAULT.option).filter(visible);
    if (!list.length && !custom) {
      list = queryAll(container, "input[type=radio], input[type=checkbox]").map(input => {
        const label = input.closest("label") || [...container.querySelectorAll("label")].find(l => l.htmlFor && l.htmlFor === input.id);
        return label || input.closest("li, [data-option], .option, .answerBg") || input.parentElement;
      }).filter(visible);
    }
    list = [...new Set(list)];
    return list.filter(el => !list.some(other => other !== el && el.contains(other)));
  }
  function selected(option) {
    if (option.input) return option.input.checked;
    return option.el.getAttribute("aria-checked") === "true" || option.el.dataset.selected === "true" ||
      option.el.matches(".selected, .active, .checked, .check_answer, .check_answer_dx") ||
      !!option.el.querySelector(".check_answer, .check_answer_dx, [aria-checked='true']");
  }
  function scan(selectors = {}) {
    let containers = queryAll(document, selectors.question || DEFAULT.question).filter(visible);
    containers = containers.filter(el => !containers.some(other => other !== el && el.contains(other)));
    if (!containers.length) return [];
    return containers.map((container, index) => {
      const stemEl = queryAll(container, selectors.stem || DEFAULT.stem).find(visible);
      const optionRows = rows(container, selectors.option);
      const stem = text(stemEl);
      const options = optionRows.map((el, i) => {
        const raw = text(el);
        const explicit = (el.dataset.option || el.querySelector("[data-option]")?.dataset.option || "").trim().toUpperCase();
        const prefix = raw.match(/^([A-Z])\s*[.．、:：)）\s]\s*/);
        const label = /^[A-Z]$/.test(explicit) ? explicit : prefix ? prefix[1] : String.fromCharCode(65 + i);
        const input = el.matches("input") ? el : el.querySelector("input[type=radio], input[type=checkbox]");
        return { label, text: C.normalize(prefix ? raw.slice(prefix[0].length) : raw), el, input };
      });
      const typeText = C.normalize((stemEl?.textContent || "") + " " + container.dataset.type + " " + (container.querySelector(".question-type, .mark_type")?.textContent || ""));
      const inputTypes = options.map(o => o.input?.type || o.el.getAttribute("role"));
      const type = /多选|multiple|checkbox/i.test(typeText) || inputTypes.includes("checkbox") ? "multiple" :
        /判断|judge/i.test(typeText) ? "judge" :
          /单选|single|radio/i.test(typeText) || inputTypes.includes("radio") ? "single" : "unknown";
      const identity = container.dataset.questionId || container.getAttribute("data-question") || container.id ||
        container.querySelector("input[type=hidden][name*='questionId']")?.value || "";
      const q = { type, stem, options: options.map(({label, text}) => ({label, text})) };
      const key = C.hash(JSON.stringify({ identity, ...q }));
      let issue = "";
      try { C.validateQuestion(q); } catch (e) { issue = e.message; }
      if ((stemEl?.querySelector("img, canvas, video, audio") || options.some(o => o.el.querySelector("img, canvas, video, audio")))) issue = "包含图片、音视频或画布；本版本只识别文本题，请手动作答。";
      if (options.some(o => !o.input && !o.el.matches("[role='radio'], [role='checkbox'], [data-option], li, .answerBg"))) issue = "无法确定选项的点击控件。";
      return { ...q, key, index, issue, container, optionNodes: options };
    });
  }
  function wire(question) {
    const { key, type, stem, options, issue, index } = question;
    return { key, type, stem, options, issue, index };
  }
  function button(kind, selectors = {}) {
    const selector = selectors[kind];
    if (selector) {
      const matches = queryAll(document, selector).filter(visible);
      if (matches.length > 1) throw new Error(`${kind} 选择器匹配到多个按钮，请缩小范围。`);
      return matches[0] || null;
    }
    const pattern = kind === "next" ? /^(?:下一题|下一页|下题|下一步)\s*[>›»→]?$/ : /^(?:提交|提交作业|提交答案|提交试卷|交卷|提交考试|完成答题)$/;
    const matches = queryAll(document, "button, a, input[type=button], input[type=submit], [role=button], .nextBtn, .submitBtn")
      .filter(visible).filter(el => pattern.test(C.normalize(el.innerText || el.value || el.textContent)));
    const innermost = matches.filter(el => !matches.some(other => other !== el && el.contains(other)));
    if (innermost.length > 1) throw new Error(`检测到多个${kind === "next" ? "下一题" : "提交"}按钮，请在设置中指定 CSS 选择器。`);
    return innermost[0] || null;
  }
  function disabled(el) {
    return !el || !!el.disabled || el.getAttribute("aria-disabled") === "true" || el.matches(".disabled, [disabled]");
  }
  function blocked() {
    return queryAll(document, "[role=dialog], .layui-layer, .modal, .captcha, [class*='captcha'], [id*='captcha']")
      .some(el => visible(el) && /验证码|验证身份|人机验证|登录已失效|重新登录/.test(text(el)));
  }
  function confirmSubmit() {
    const dialogs = queryAll(document, "[role=dialog], .layui-layer-dialog, .modal, .popDiv").filter(visible);
    for (const dialog of dialogs) {
      const content = text(dialog);
      if (!/交卷|提交(?:作业|答案|试卷|考试)?/.test(content)) continue;
      if (/未(?:作答|答)|漏答|未完成/.test(content)) throw new Error("提交对话框提示存在未完成题目，已暂停。");
      const matches = queryAll(dialog, "button, a, [role=button], input[type=button]").filter(visible)
        .filter(el => /^(?:确定|确认|确定提交|确认提交|确认交卷|提交|交卷)$/.test(C.normalize(el.innerText || el.value || el.textContent)));
      if (matches.length === 1) return matches[0];
    }
    return null;
  }
  function submitted() {
    return queryAll(document, "[role=status], .success, .submit-success, .result, h1, h2, h3")
      .some(el => visible(el) && /提交成功|交卷成功|已成功提交|作业已提交|试卷已提交|已交卷/.test(text(el)));
  }
  function scanGrading(selectors = {}) {
    const feedbackSelector = ".grading-result, .question-result, .mark_result, .mark_score, .result-mark, [data-role='grading'], .answer-feedback, .mark_answer, .correct-answer, .reference-answer, .right-answer, .user-answer, .my-answer, .marking_dui, .marking_cuo, .marking_bandui";
    const wrongMarker = ".question-wrong, .wrong-question, .answer-wrong, .marking_cuo, [data-correct='false'], [data-result='wrong'], [data-result='incorrect']";
    const correctMarker = ".question-correct, .answer-correct, .marking_dui, [data-correct='true'], [data-result='correct']";
    const partialMarker = ".question-partial, .answer-partial, .marking_bandui, [data-result='partial']";
    return scan(selectors).map(q => {
      const states = new Set(), evidence = [];
      const stemNodes = queryAll(q.container, selectors.stem || DEFAULT.stem);
      const outsideQuestionText = node => !stemNodes.some(s => s.contains(node)) && !q.optionNodes.some(o => o.el.contains(node));
      const feedbackNodes = queryAll(q.container, feedbackSelector).filter(visible).filter(outsideQuestionText);
      const feedback = feedbackNodes.filter(node => !feedbackNodes.some(other => other !== node && other.contains(node)));
      const feedbackText = C.normalize(feedback.map(node => text(node) + " " + (node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("alt") || "")).join(" ; "));
      function mark(selector, state) {
        const matches = [q.container, ...queryAll(q.container, selector)].filter(node => node.matches(selector) && visible(node) && (node === q.container || outsideQuestionText(node)));
        if (matches.length) { states.add(state); evidence.push(`页面批改标记：${state === "wrong" ? "错误" : state === "partial" ? "部分正确" : "正确"}`); }
      }
      if (selectors.wrong) mark(selectors.wrong, "wrong");
      mark(wrongMarker, "wrong"); mark(correctMarker, "correct"); mark(partialMarker, "partial");
      if (/(?:回答|作答|答题|答案|判定|批改)\s*[:：为]?\s*(?:错误|不正确)|答错|^(?:错误|不正确)$/.test(feedbackText)) states.add("wrong");
      if (/(?:回答|作答|答题|答案|判定|批改)\s*[:：为]?\s*正确(?!答案)|^(?:正确|答对)$/.test(feedbackText)) states.add("correct");
      if (/部分正确|未得满分|半对/.test(feedbackText)) states.add("partial");
      const score = feedbackText.match(/(?:得分|评分)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[/／]\s*(\d+(?:\.\d+)?)/);
      if (score && Number(score[2]) > 0 && Number(score[1]) <= Number(score[2])) states.add(Number(score[1]) === Number(score[2]) ? "correct" : Number(score[1]) === 0 ? "wrong" : "partial");
      const direct = selector => queryAll(q.container, selector).filter(visible).filter(outsideQuestionText).map(text).find(Boolean) || "";
      const correctText = direct(".correct-answer, .reference-answer, .right-answer, [data-role='correct-answer']") ||
        feedbackText.match(/(?:正确|参考|标准)答案\s*[:：]\s*(.+?)(?=(?:我的|你的|学生|作答)答案|(?:答案解析|解析|得分|评分|回答)|;|$)/)?.[1] || "";
      const userText = direct(".user-answer, .my-answer, [data-role='user-answer']") ||
        feedbackText.match(/(?:我的|你的|学生|作答)答案\s*[:：]\s*(.+?)(?=(?:正确|参考|标准)答案|(?:答案解析|解析|得分|评分|回答)|;|$)/)?.[1] || "";
      const answerText = value => C.normalize(value).replace(/^(?:(?:正确|参考|标准|我的|你的|学生|作答)答案)\s*[:：]?\s*/, "").trim();
      function answerLabels(value) {
        const clean = answerText(value);
        if (/^[A-Z](?:[\s,，、;；]*[A-Z])*$/.test(clean)) {
          const labels = [...new Set(clean.match(/[A-Z]/g))].sort();
          if (q.options.length && labels.some(label => !q.options.some(o => o.label === label))) return null;
          return labels;
        }
        const option = q.options.find(o => C.normalize(o.text) === clean);
        return option ? [option.label] : null;
      }
      const correct = answerLabels(correctText);
      const chosen = q.optionNodes.filter(selected).map(o => o.label).sort();
      const user = userText ? answerLabels(userText) : chosen.length ? chosen : null;
      if (correct?.length && user?.length) {
        const equal = JSON.stringify(correct) === JSON.stringify(user);
        if (!states.size) states.add(equal ? "correct" : "wrong");
        else if (states.has("correct") && !equal || !states.has("correct") && equal) states.add(equal ? "correct" : "wrong");
        evidence.push("根据页面正确答案与作答选项比较");
      }
      const status = states.has("correct") && (states.has("wrong") || states.has("partial")) ? "conflict" :
        states.has("partial") ? "partial" : states.has("wrong") ? "wrong" : states.has("correct") ? "correct" : "ungraded";
      return { key: q.key, index: q.index, stem: q.stem || `第 ${q.index + 1} 个题块`, status,
        userAnswer: answerText(userText) || chosen.join("、"), correctAnswer: answerText(correctText),
        evidence: C.normalize([feedbackText, ...evidence].filter(Boolean).join("；")).slice(0, 1800) };
    });
  }
  root.CXDOM = Object.freeze({ visible, text, scan, wire, selected, button, disabled, blocked, confirmSubmit, submitted, scanGrading });
})(globalThis);
