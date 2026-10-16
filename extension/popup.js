import "./shared.js";
const C = globalThis.CXCore;
const $ = id => document.getElementById(id);
let tabId, frames = [], busy = false;
let lastReviewSignature = "";
async function send(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || "扩展连接失败。");
  return result.data;
}
function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }
function renderReview(run) {
  const summary = C.reviewSummary(run);
  const signature = JSON.stringify([run.token, run.status, run.completed.length, summary.items]);
  if (signature === lastReviewSignature) return;
  lastReviewSignature = signature;
  $("confidenceReview").hidden = !(run.status === "complete" || run.completed.length || summary.items.length);
  $("reviewStatus").textContent = !summary.items.length && ["running", "navigating", "submitting"].includes(run.status) ? "当前尚未记录到低自评率题目，任务结束后会汇总。" : summary.message;
  $("reviewList").replaceChildren();
  for (const item of summary.items) {
    const article = document.createElement("article");
    const title = document.createElement("p"); title.className = "stem"; title.textContent = `本次第 ${item.number} 题 · AI 自评 ${(item.confidence * 100).toFixed(0)}%`;
    const stem = document.createElement("p"); stem.textContent = item.stem;
    const answer = document.createElement("p"); answer.textContent = `AI 选项：${item.answers.join("、")}；${item.explanation}`;
    article.append(title, stem, answer); $("reviewList").append(article);
  }
}
function renderWrong(result) {
  if (!result) return;
  $("wrongReview").hidden = false;
  const questions = result.frames.flatMap(f => f.questions.map(q => ({ ...q, frameId: f.frameId })));
  const wrong = questions.filter(q => ["wrong", "partial"].includes(q.status));
  const conflicts = questions.filter(q => q.status === "conflict");
  const graded = questions.filter(q => ["wrong", "partial", "correct"].includes(q.status)).length;
  $("wrongStatus").textContent = !questions.length ? "未识别到题块，请在已批改的答题结果页扫描。" : !graded ? "未发现可识别的批改结果，暂时无法判断错题。" : wrong.length ? `识别到 ${wrong.length} 道错题或部分正确题。` : `本次扫描未发现明确错题（已识别 ${graded} / ${questions.length} 题的批改结果）。`;
  $("wrongScope").textContent = `上次扫描：${new Date(result.scannedAt).toLocaleTimeString()}；仅扫描时已加载的区域。${questions.length - graded - conflicts.length ? `有 ${questions.length - graded - conflicts.length} 题未识别到批改结果。` : ""}${conflicts.length ? `有 ${conflicts.length} 题标记冲突，请手动核对。` : ""}`;
  $("wrongList").replaceChildren();
  for (const q of [...wrong, ...conflicts]) {
    const article = document.createElement("article");
    const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = q.status === "conflict" ? "批改标记冲突" : q.status === "partial" ? "部分正确" : "错题";
    const stem = document.createElement("p"); stem.className = "stem"; stem.textContent = q.stem;
    const answers = document.createElement("p"); answers.textContent = `页面作答：${q.userAnswer || "未识别"}；页面正确答案：${q.correctAnswer || "未显示或未识别"}`;
    const evidence = document.createElement("details");
    const caption = document.createElement("summary"); caption.textContent = "识别依据";
    const reason = document.createElement("p"); reason.className = "muted"; reason.textContent = q.evidence; evidence.append(caption, reason);
    article.append(badge, stem, answers, evidence); $("wrongList").append(article);
  }
}
function render() {
  const frame = frames.find(f => String(f.frameId) === $("frame").value);
  $("preview").replaceChildren();
  for (const q of frame?.questions || []) {
    const article = document.createElement("article");
    const badge = document.createElement("span"); badge.className = "badge";
    badge.textContent = ({single:"单选",multiple:"多选",judge:"判断"})[q.type] || "未支持";
    const stem = document.createElement("p"); stem.className = "stem"; stem.textContent = q.stem || "未找到题干";
    const list = document.createElement("ol"); list.style.listStyleType = "none";
    for (const option of q.options) { const li = document.createElement("li"); li.textContent = `${option.label}. ${option.text}`; list.append(li); }
    article.append(badge, stem, list);
    if (q.issue) { const issue = document.createElement("p"); issue.className = "error"; issue.textContent = q.issue; article.append(issue); }
    $("preview").append(article);
  }
  $("single").disabled = busy || !frame;
  $("start").disabled = busy || !frame;
}
async function refresh() {
  if (!tabId || busy) return;
  const run = await send("CX_STATUS", { tabId });
  if (run) {
    renderReview(run);
    status(run.message, run.status === "paused");
    $("progress").textContent = `本次已确认选中 ${run.completed.length} 题 · ${({running:"运行中",navigating:"正在翻页",submitting:"正在提交",paused:"已暂停",stopped:"已停止",complete:"已完成"})[run.status] || run.status}`;
  }
}
$("scan").addEventListener("click", async () => {
  busy = true; $("scan").disabled = true; $("scanWrong").disabled = true; frames = []; render();
  try {
    status("正在读取题干和选项…");
    const cfg = await send("CX_CONFIG");
    $("submitHint").textContent = cfg.autoSubmit ? "自动提交已开启：到末页后会尝试交卷。请从第一题开始。" : "自动提交已关闭：选完后请检查并手动提交。";
    frames = await send("CX_PROBE", { tabId });
    $("frame").replaceChildren();
    for (const frame of frames) { const option = document.createElement("option"); option.value = frame.frameId; option.textContent = `区域 ${frame.frameId} · ${frame.questions.length} 题`; $("frame").append(option); }
    $("frame").disabled = !frames.length;
    status(frames.length ? `识别到 ${frames.length} 个答题区域，请核对下方内容。` : "未识别到题目。请进入实际答题页，或在设置中调整 CSS 选择器。", !frames.length);
  } catch (e) { status(e.message + " 如为浏览器内置页，请切换到答题网页。", true); }
  finally { busy = false; $("scan").disabled = false; $("scanWrong").disabled = false; render(); }
});
$("scanWrong").addEventListener("click", async () => {
  busy = true; $("scan").disabled = true; $("scanWrong").disabled = true; render();
  try { status("正在读取当前页的批改标记…"); renderWrong(await send("CX_SCAN_WRONG", { tabId })); status("错题扫描完成，请查看下方结果。"); }
  catch (e) { status(e.message, true); }
  finally { busy = false; $("scan").disabled = false; $("scanWrong").disabled = false; render(); }
});
$("frame").addEventListener("change", render);
for (const [id, mode] of [["single", "single"], ["start", "auto"]]) $(id).addEventListener("click", async () => {
  busy = true; render();
  try {
    await send("CX_START", { tabId, frameId: Number($("frame").value), mode });
    status("任务已启动。关闭此弹窗后仍会继续，页面右下角可停止。");
  } catch (e) { status(e.message, true); }
  finally { busy = false; render(); }
});
$("stop").addEventListener("click", async () => { try { await send("CX_STOP", { tabId }); status("任务已停止。"); } catch(e) { status(e.message, true); } });
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
try {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); tabId = tab?.id;
  if (!tabId) throw new Error("请先打开答题网页。");
  const cfg = await send("CX_CONFIG");
  $("submitHint").textContent = cfg.autoSubmit ? "自动提交已开启，请从第一题开始。" : "自动提交已关闭，选完后请手动检查并提交。";
  await refresh();
  renderWrong(await send("CX_WRONG_STATUS", { tabId }));
} catch (e) { status(e.message, true); }
setInterval(() => refresh().catch(() => {}), 1500);
