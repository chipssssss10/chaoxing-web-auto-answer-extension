import "./shared.js";
const C = globalThis.CXCore;
const $ = id => document.getElementById(id);
const fields = ["endpoint", "model", "apiKey", "minConfidence", "delayMs", "maxQuestions", "requestTimeoutMs"];
const selectorFields = ["question", "stem", "option", "next", "submit", "wrong"];
function report(message, error = false) { $("saveStatus").textContent = message; $("saveStatus").className = error ? "error" : "success"; }
function read() {
  const value = Object.fromEntries(fields.map(id => [id, $(id).value]));
  value.minConfidence = Number(value.minConfidence) / 100;
  value.jsonMode = $("jsonMode").checked; value.autoSubmit = $("autoSubmit").checked;
  value.selectors = Object.fromEntries(selectorFields.map(id => [id, $(id).value.trim()]));
  for (const [key, selector] of Object.entries(value.selectors)) {
    if (selector) { try { document.querySelector(selector); } catch { throw new Error(`${key} 的 CSS 选择器无效。`); } }
  }
  return C.settings(value, true);
}
async function send(type) {
  const result = await chrome.runtime.sendMessage({ type });
  if (!result?.ok) throw new Error(result?.error || "扩展操作失败。");
  return result.data;
}
$("settings").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const cfg = read();
    // Call permissions.request directly in this user gesture, before another await.
    const origin = new URL(cfg.endpoint).origin + "/*";
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("未授予 API 域名访问权限，设置未保存。");
    await chrome.storage.local.set({ settings: cfg });
    $("endpoint").value = cfg.endpoint;
    report("设置已保存。可测试接口，再回答题页扫描。修改设置后请停止并重新开始已有任务。");
  } catch(e) { report(e.message, true); }
});
$("test").addEventListener("click", async () => {
  $("test").disabled = true; report("正在用一道简单题测试已保存接口…");
  try {
    const result = await send("CX_TEST");
    report(result.passed ? `接口可用，测试答案正确；AI 自评 ${(result.confidence * 100).toFixed(0)}%。` : "接口连通，但简单测试题答错，请检查模型。", !result.passed);
  } catch(e) { report(e.message, true); }
  finally { $("test").disabled = false; }
});
$("clearKey").addEventListener("click", async () => {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, apiKey: "" } });
  $("apiKey").value = ""; report("已清除本地保存的密钥；正在运行的任务请另行停止。");
});
$("demo").addEventListener("click", () => chrome.tabs.create({ url: "http://127.0.0.1:8765/demo" }));
const cfg = C.settings((await chrome.storage.local.get("settings")).settings);
for (const id of fields) $(id).value = cfg[id];
$("minConfidence").value = Math.round(cfg.minConfidence * 10000) / 100;
for (const id of selectorFields) $(id).value = cfg.selectors[id];
$("jsonMode").checked = cfg.jsonMode; $("autoSubmit").checked = cfg.autoSubmit;
