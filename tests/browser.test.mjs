import { createRequire } from "node:module";
import { cp, readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createDemoServer } from "../tools/demo-server.mjs";
const require = createRequire(import.meta.url);
let playwright;
if (process.env.PLAYWRIGHT_MODULE) playwright = require(process.env.PLAYWRIGHT_MODULE);
else {
  try { playwright = require("playwright"); }
  catch { playwright = require(path.join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright")); }
}
const { chromium } = playwright;
const temp = await mkdtemp(path.join(tmpdir(), "cx-helper-test-"));
const ext = path.join(temp, "extension");
const output = fileURLToPath(new URL("../.test-output", import.meta.url));
const server = createDemoServer();
let context;
try {
  await cp(fileURLToPath(new URL("../extension", import.meta.url)), ext, { recursive: true });
  // Grant localhost only in the temporary test extension, without a native permission dialog.
  const manifest = JSON.parse(await readFile(path.join(ext,"manifest.json"),"utf8"));
  manifest.host_permissions.push("http://127.0.0.1/*");
  await writeFile(path.join(ext,"manifest.json"),JSON.stringify(manifest));
  await new Promise(resolve => server.listen(8765,"127.0.0.1",resolve));
  context = await chromium.launchPersistentContext(path.join(temp,"profile"), {
    channel: process.env.BROWSER_CHANNEL || "msedge", headless: true,
    args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]
  });
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker",{timeout:15000});
  const id = new URL(worker.url()).hostname;
  const ui = await context.newPage(); await ui.goto(`chrome-extension://${id}/options.html`);
  const page = await context.newPage();
  const cfg = {endpoint:"http://127.0.0.1:8765/v1/chat/completions",model:"demo",apiKey:"demo-key",delayMs:300,minConfidence:0.85,maxQuestions:20,requestTimeoutMs:10000,autoSubmit:false};
  async function configure(extra={}) { await ui.evaluate(value=>chrome.storage.local.set({settings:value}),{...cfg,...extra}); }
  async function command(type, data={}) {
    const result=await ui.evaluate(message=>chrome.runtime.sendMessage(message),{type,...data});
    assert.equal(result.ok,true,result.error); return result.data;
  }
  async function tabId() {
    return ui.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.startsWith("http://127.0.0.1:8765/demo"))?.id);
  }
  async function state() { return command("CX_STATUS",{tabId:await tabId()}); }
  async function waitDone() {
    for(let i=0;i<200;i++) { const run=await state(); if(run && ["complete","paused","stopped"].includes(run.status)) return run; await new Promise(resolve=>setTimeout(resolve,100)); }
    throw new Error("Task did not stop: "+JSON.stringify(await state()));
  }
  async function start(mode="auto") {
    const tab=await tabId();const frames=await command("CX_PROBE",{tabId:tab});
    assert.equal(frames.length,1); await command("CX_START",{tabId:tab,frameId:frames[0].frameId,mode});return frames;
  }
  async function clickPanelStop() {
    const panel = page.locator("[data-cx-helper]");
    const box = await panel.boundingBox(); assert.ok(box, "Status panel must be visible");
    // Use a real mouse click: the Stop button is inside a closed shadow root.
    await page.mouse.click(box.x + box.width - 43, box.y + 32);
    assert.equal(await panel.count(), 0, "Stop must remove the panel in its click handler");
  }
  async function waitCount(count) {
    for (let i=0;i<60;i++) { const run=await state(); if(run?.completed.length===count) return; await new Promise(resolve=>setTimeout(resolve,50)); }
    throw new Error("Expected answered count: "+count);
  }
  async function accessibleText() {
    const session=await context.newCDPSession(page);
    try { return (await session.send("Accessibility.getFullAXTree")).nodes.filter(n=>!n.ignored).map(n=>n.name?.value||"").join("\n"); }
    finally { await session.detach(); }
  }
  async function openPopup() {
    const popup=await context.newPage();await page.bringToFront();await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.locator("#submitHint").filter({hasText:"自动提交"}).waitFor();return popup;
  }
  await configure();
  await ui.reload(); await ui.locator("#save").click();
  await ui.locator("#saveStatus").filter({hasText:"设置已保存"}).waitFor();
  assert.equal(await ui.locator("#minConfidence").inputValue(),"85");
  assert.equal(await ui.evaluate(async()=>(await chrome.storage.local.get("settings")).settings.minConfidence),0.85);
  await ui.locator("#test").click();await ui.locator("#saveStatus").filter({hasText:"接口可用"}).waitFor();
  console.log("PASS settings save, granted API origin, connectivity check");
  await page.goto("http://127.0.0.1:8765/demo?mode=spa");
  let frames=await start();assert.equal(frames[0].questions[0].options[0].text,"2");
  let run=await waitDone();assert.equal(run.status,"complete",run.message);assert.equal(run.completed.length,3);assert.equal(await page.evaluate(()=>!!window.demoSubmitted),false);
  assert.equal(await page.locator('input[value=B]').isChecked(),true);
  assert.equal(run.lowConfidence.length,0);assert.match(await accessibleText(),/没有 AI 自评率过低的题目/);
  console.log("PASS sequential questions, correction of multiple choices, pause before submission");

  await configure({autoSubmit:true});await page.goto("http://127.0.0.1:8765/demo?mode=all");
  await start();run=await waitDone();assert.equal(run.status,"complete",run.message);assert.equal(run.completed.length,3);
  assert.match(await page.locator("#result").innerText(),/3 \/ 3/);
  console.log("PASS whole-page questions, submission dialog, verified success");

  await configure({model:"demo-low"});await page.goto("http://127.0.0.1:8765/demo?mode=reload");
  await start();run=await waitDone();assert.equal(run.status,"complete",run.message);assert.equal(run.completed.length,3);assert.match(page.url(),/index=2/);
  assert.equal(run.lowConfidence.length,3);assert.match(await accessibleText(),/3 道题 AI 自评率较低/);
  console.log("PASS continuation across full-page navigation preserves all low-confidence questions");

  await configure();await page.goto("http://127.0.0.1:8765/demo?mode=all");await start("single");
  run=await waitDone();assert.equal(run.completed.length,1);assert.equal(await page.evaluate(()=>!!window.demoSubmitted),false);
  console.log("PASS one-question mode");

  await configure({model:"demo-low"});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();
  run=await waitDone();assert.equal(run.status,"complete",run.message);assert.equal(run.completed.length,3);assert.equal(run.lowConfidence.length,3);
  assert.deepEqual(run.lowConfidence.map(item=>item.number),[1,2,3]);assert.equal(run.lowConfidence[0].confidence,0.4);
  await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,"low-confidence.png"),fullPage:true});
  let reviewPopup=await openPopup();assert.equal(await reviewPopup.locator("#reviewList article").count(),3);assert.match(await reviewPopup.locator("#reviewStatus").innerText(),/3 道/);await reviewPopup.close();
  console.log("PASS low-confidence answers continue and persist detailed summaries in the popup");

  await configure({model:"demo-low",delayMs:4000});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();await waitCount(1);
  assert.match(await accessibleText(),/AI 自评率较低（40%/);
  await new Promise(resolve=>setTimeout(resolve,3100));assert.doesNotMatch(await accessibleText(),/已记录，继续作答/);
  await command("CX_STOP",{tabId:await tabId()});assert.equal(await page.locator("[data-cx-helper]").count(),0);
  console.log("PASS low-confidence notice disappears after three seconds without blocking or restoring after Stop");

  await configure({minConfidence:0.99});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start("single");run=await waitDone();assert.equal(run.lowConfidence.length,0);
  await configure({model:"demo-low",minConfidence:0});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start("single");run=await waitDone();assert.equal(run.lowConfidence.length,0);
  assert.match(await accessibleText(),/没有 AI 自评率过低的题目/);
  console.log("PASS equal confidence does not warn and zero threshold disables warnings");

  await configure({model:"demo-low",autoSubmit:true});await page.goto("http://127.0.0.1:8765/demo?mode=all&submitReload=1");await start();run=await waitDone();
  assert.equal(run.completed.length,3);assert.equal(run.lowConfidence.length,3);
  await page.waitForURL(/afterSubmit=1/);
  for(let i=0;i<50;i++){if((await accessibleText()).includes("3 道题 AI 自评率较低"))break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.match(await accessibleText(),/3 道题 AI 自评率较低/);
  console.log("PASS confidence summary reappears after submission navigates to the result page");

  await configure({autoSubmit:true});await page.goto("http://127.0.0.1:8765/demo?mode=unsupported");await start();
  run=await waitDone();assert.equal(run.status,"paused");assert.equal(run.completed.length,0);assert.equal(await page.evaluate(()=>!!window.demoSubmitted),false);
  console.log("PASS unsupported question prevents automatic submission");

  await configure({model:"demo-slow"});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();
  await new Promise(resolve=>setTimeout(resolve,300));await command("CX_STOP",{tabId:await tabId()});
  await new Promise(resolve=>setTimeout(resolve,2000));run=await state();assert.equal(run.status,"stopped");assert.equal(await page.locator("input:checked").count(),0);
  assert.equal(await page.locator("[data-cx-helper]").count(),0);
  console.log("PASS stop during in-flight AI request prevents late selection");

  await configure({model:"demo-slow"});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();
  await new Promise(resolve=>setTimeout(resolve,250));await clickPanelStop();
  run=await waitDone();assert.equal(run.status,"stopped");
  await new Promise(resolve=>setTimeout(resolve,2000));
  assert.equal(await page.locator("input:checked").count(),0);assert.equal(await page.locator("[data-cx-helper]").count(),0);
  console.log("PASS page-panel Stop removes itself immediately and late replies never restore it");

  await configure({delayMs:10000});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();await waitCount(1);
  await clickPanelStop();run=await waitDone();assert.equal(run.status,"stopped");
  await configure();await start("single");run=await waitDone();assert.equal(run.status,"complete",run.message);assert.equal(run.completed.length,1);
  assert.match(await page.locator("#position").innerText(),/第 1/);
  await clickPanelStop();run=await waitDone();assert.equal(run.status,"stopped");
  console.log("PASS Stop cancels a 10-second wait, allows immediate restart, and dismisses a completed panel");

  await configure({delayMs:300});await page.goto("http://127.0.0.1:8765/demo?mode=spa");
  await page.locator("#nextQuestion").evaluate(button=>{button.onclick=()=>{};});
  await start();
  for(let i=0;i<60;i++){if((await state())?.status==="navigating")break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal((await state()).status,"navigating");await clickPanelStop();run=await waitDone();assert.equal(run.status,"stopped");
  await configure();await start("single");run=await waitDone();assert.equal(run.status,"complete",run.message);
  console.log("PASS Stop cancels waiting for next question and leaves the page usable");

  await configure({autoSubmit:true});await page.goto("http://127.0.0.1:8765/demo?mode=all");
  // Model a dialog whose confirm button becomes available after it is shown.
  await page.locator("#confirmSubmit").evaluate(button=>{button.disabled=true;});await start();
  await page.locator("#confirm").waitFor({state:"visible"});assert.equal(await page.evaluate(()=>!!window.demoSubmitted),false);
  await clickPanelStop();run=await waitDone();assert.equal(run.status,"stopped");
  await page.locator("#confirmSubmit").evaluate(button=>{button.disabled=false;});
  await new Promise(resolve=>setTimeout(resolve,700));assert.equal(await page.evaluate(()=>!!window.demoSubmitted),false);
  assert.equal(await page.locator("[data-cx-helper]").count(),0);
  console.log("PASS Stop during submission dialog prevents automatic confirmation");

  await configure({model:"demo-timeout",requestTimeoutMs:3000});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();
  run=await waitDone();assert.equal(run.status,"paused");assert.equal(run.errorCode,"API_TIMEOUT");assert.match(run.message,/已等待 3 秒/);assert.match(run.message,/重新开始/);
  assert.equal(await page.locator("input:checked").count(),0);assert.equal(await page.locator("[data-cx-helper]").count(),1);
  const cdp=await context.newCDPSession(page);
  const accessible=(await cdp.send("Accessibility.getFullAXTree")).nodes.filter(n=>!n.ignored).map(n=>n.name?.value||"").join("\n");
  assert.match(accessible,/AI 接口请求超时，已暂停/);assert.match(accessible,/已等待 3 秒/);
  await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,"timeout.png"),fullPage:true});await cdp.detach();
  await clickPanelStop();run=await waitDone();assert.equal(run.status,"stopped");
  await new Promise(resolve=>setTimeout(resolve,1800));assert.equal(await page.locator("[data-cx-helper]").count(),0);
  console.log("PASS API timeout displays expanded reason and actual duration, then can be dismissed");

  await ui.reload();await ui.locator("#test").click();
  await ui.locator("#saveStatus").filter({hasText:"已等待 3 秒"}).waitFor();
  assert.equal(await ui.locator("#test").isEnabled(),true);
  console.log("PASS API connectivity test reports timeout and releases its button");

  await configure({model:"demo-slow"});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();
  await new Promise(resolve=>setTimeout(resolve,300));await page.locator(".question-title").evaluate(el=>el.textContent="页面在请求途中换了一道题（单选题）");
  run=await waitDone();assert.equal(run.status,"paused");assert.match(run.message,/变化/);assert.equal(await page.locator("input:checked").count(),0);
  console.log("PASS changed question rejects a stale AI answer");

  await configure({apiKey:"invalid-test-key"});await page.goto("http://127.0.0.1:8765/demo?mode=spa");await start();
  run=await waitDone();assert.equal(run.status,"paused");assert.match(run.message,/密钥/);assert.equal(run.message.includes("invalid-test-key"),false);
  console.log("PASS invalid API credentials pause without leaking key in error");

  await configure();await page.goto("http://127.0.0.1:8765/demo?mode=spa");
  await page.locator(".question-title").evaluate(el=>{const img=document.createElement("img");img.alt="图片题";el.append(img);});await start();
  run=await waitDone();assert.equal(run.status,"paused");assert.match(run.message,/图片/);
  console.log("PASS image questions pause before requesting an answer");

  await configure();await page.goto("http://127.0.0.1:8765/demo?mode=all");
  // Secrets are available only to trusted extension contexts, not content scripts.
  const access = await worker.evaluate(async()=>{
    const [tab]=await chrome.tabs.query({url:"http://127.0.0.1/*"});
    const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{try{await chrome.storage.local.get("settings");return "exposed";}catch{return "blocked";}}});return r.result;
  });
  assert.equal(access,"blocked");console.log("PASS content scripts cannot read saved API credentials");

  await configure({apiKey:""});await page.goto("http://127.0.0.1:8765/demo?mode=review");
  const beforeRequests=server.aiRequests;
  const originalAnswers=await page.locator("input:checked").evaluateAll(inputs=>inputs.map(i=>[i.name,i.value]));
  let grading=await command("CX_SCAN_WRONG",{tabId:await tabId()});
  assert.deepEqual(grading.frames[0].questions.map(q=>q.status),["correct","partial","wrong"]);
  assert.match(grading.frames[0].questions[1].correctAnswer,/A、C/);
  assert.equal(server.aiRequests,beforeRequests);assert.deepEqual(await page.locator("input:checked").evaluateAll(inputs=>inputs.map(i=>[i.name,i.value])),originalAnswers);
  reviewPopup=await openPopup();await reviewPopup.locator("#scanWrong").click();await reviewPopup.locator("#wrongStatus").filter({hasText:"2 道"}).waitFor();
  assert.equal(await reviewPopup.locator("#wrongList article").count(),2);await reviewPopup.close();
  reviewPopup=await openPopup();assert.equal(await reviewPopup.locator("#wrongList article").count(),2);await reviewPopup.close();
  console.log("PASS Scan wrong answers works without API key, preserves answers, and restores its report on reopen");

  await page.goto("http://127.0.0.1:8765/demo?mode=review-correct");
  reviewPopup=await openPopup();await reviewPopup.locator("#scanWrong").click();await reviewPopup.locator("#wrongStatus").filter({hasText:"未发现明确错题"}).waitFor();assert.equal(await reviewPopup.locator("#wrongList article").count(),0);await reviewPopup.close();
  console.log("PASS fully graded correct paper explicitly reports no marked wrong answers");

  await page.goto("http://127.0.0.1:8765/demo?mode=all");
  await page.locator(".question-title").first().evaluate(el=>{el.append(document.createTextNode("题干提到：回答错误"));const marker=document.createElement("span");marker.className="question-wrong";marker.textContent="回答错误";el.append(marker);});
  await page.locator("label").first().evaluate(el=>{const marker=document.createElement("span");marker.className="answer-wrong";marker.textContent="回答错误";el.append(marker);});
  await page.locator(".question-item").first().evaluate(el=>{const marker=document.createElement("span");marker.className="question-wrong";marker.hidden=true;el.append(marker);});
  grading=await command("CX_SCAN_WRONG",{tabId:await tabId()});assert.ok(grading.frames[0].questions.every(q=>q.status==="ungraded"));
  reviewPopup=await openPopup();await reviewPopup.locator("#scanWrong").click();await reviewPopup.locator("#wrongStatus").filter({hasText:"暂时无法判断"}).waitFor();await reviewPopup.close();
  console.log("PASS ungraded paper, hidden markers, and words in questions/options are not treated as wrong answers");

  await page.goto("http://127.0.0.1:8765/demo?mode=all");await page.locator('input[name="q1"][value="A"]').check();
  await page.locator(".question-item").first().evaluate(el=>{const feedback=document.createElement("p");feedback.className="correct-answer";feedback.textContent="正确答案：B";el.append(feedback);});
  grading=await command("CX_SCAN_WRONG",{tabId:await tabId()});assert.equal(grading.frames[0].questions[0].status,"wrong");
  console.log("PASS compares displayed correct answer against selected choice when a verdict is absent");

  await configure({selectors:{wrong:".custom-error"}});await page.goto("http://127.0.0.1:8765/demo?mode=all");
  await page.locator(".question-item").first().evaluate(el=>{const marker=document.createElement("span");marker.className="custom-error";marker.textContent="批改标记";el.append(marker);});
  grading=await command("CX_SCAN_WRONG",{tabId:await tabId()});assert.equal(grading.frames[0].questions[0].status,"wrong");
  await configure();await page.goto("http://127.0.0.1:8765/demo?mode=review-correct");await page.locator(".question-item").first().evaluate(el=>{el.dataset.result="wrong";});
  grading=await command("CX_SCAN_WRONG",{tabId:await tabId()});assert.equal(grading.frames[0].questions[0].status,"conflict");
  console.log("PASS custom grading selector and conflicting marks are reported separately");

  await mkdir(output,{recursive:true});await ui.reload();await ui.screenshot({path:path.join(output,"settings.png"),fullPage:true});
  await page.goto("http://127.0.0.1:8765/demo?mode=review");
  const popup=await openPopup();await popup.locator("#scanWrong").click();await popup.locator("#wrongStatus").filter({hasText:"2 道"}).waitFor();
  await popup.screenshot({path:path.join(output,"popup.png"),fullPage:true});
  console.log("Browser checks completed; screenshots saved to .test-output/");
} finally {
  await context?.close();await new Promise(resolve=>server.close(resolve));
  const absolute=path.resolve(temp), parent=path.resolve(tmpdir());
  if(path.dirname(absolute)===parent && path.basename(absolute).startsWith("cx-helper-test-")) await rm(absolute,{recursive:true,force:true});
}
