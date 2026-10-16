import test from "node:test";
import assert from "node:assert/strict";
import "../extension/shared.js";
const C = globalThis.CXCore;
const q = { type:"single", stem:"1 + 1 = ?", options:[{label:"A",text:"2"},{label:"B",text:"3"}] };
const result = (answers, confidence=0.9) => JSON.stringify({answers,confidence,explanation:"依据"});
test("validates AI output and handles fenced JSON",()=>{
 assert.deepEqual(C.parseAnswer("```json\n"+result(["A"])+"\n```",q).answers,["A"]);
 for(const bad of [result(["C"]),result(["A","B"]),result(["A","A"]),result([]),result(["A"],1.1),result(["A"],"0.9"),"答案是 A",result(["a"])]) assert.throws(()=>C.parseAnswer(bad,q));
});
test("multiple answers are sorted and validated",()=>{
 assert.deepEqual(C.parseAnswer(result(["B","A"]),{...q,type:"multiple"}).answers,["A","B"]);
});
test("only secure endpoints or loopback HTTP are accepted",()=>{
 assert.equal(C.endpointURL("https://api.example.com/v1").href,"https://api.example.com/v1/chat/completions");
 assert.equal(C.endpointURL("http://127.0.0.1:8765/v1/chat/completions").port,"8765");
 for (const url of ["http://remote.example/v1","javascript:alert(1)","https://user:pass@example.com/v1","https://example.com/v1?key=secret"]) assert.throws(()=>C.endpointURL(url));
});
test("public settings do not contain credentials or endpoint",()=>{
 const cfg=C.publicSettings({apiKey:"super-secret",endpoint:"https://api.example/v1",model:"chosen"});
 assert.equal("apiKey" in cfg,false);assert.equal("endpoint" in cfg,false);assert.equal("model" in cfg,false);
 assert.equal(cfg.autoSubmit,false);
});
test("scope allows question index changes but stops on different assignments",()=>{
 assert.equal(C.scope("https://x.chaoxing.com/work?workId=1&index=1"),C.scope("https://x.chaoxing.com/work?index=2&workId=1"));
 assert.notEqual(C.scope("https://x.chaoxing.com/work?workId=1"),C.scope("https://x.chaoxing.com/work?workId=2"));
});
test("request sends only question data with a strict answer contract",()=>{
 const body=C.requestBody({model:"custom",jsonMode:false},{...q,apiKey:"do-not-send",key:"internal"});
 assert.equal(body.model,"custom");assert.equal(body.stream,false);assert.equal(body.response_format,undefined);
 assert.equal(JSON.stringify(body).includes("do-not-send"),false);
 assert.equal(C.requestBody({model:"custom",jsonMode:true},q).response_format.type,"json_object");
 assert.throws(()=>C.validateQuestion({...q,options:[{label:"A",text:"x"},{label:"A",text:"y"}]}));
});
test("rejects invalid timing and question limits",()=>{
 assert.throws(()=>C.settings({maxQuestions:0}));assert.throws(()=>C.settings({requestTimeoutMs:90000}));assert.throws(()=>C.settings({minConfidence:NaN}));
 assert.throws(()=>C.settings({},true));
});
test("confidence summaries explicitly report none and preserve review details",()=>{
 assert.equal(C.reviewSummary({completed:[{}]}).message,"没有 AI 自评率过低的题目。");
 const item={number:2,stem:"题干",answers:["B"],confidence:0.4};
 const summary=C.reviewSummary({lowConfidence:[item]});
 assert.match(summary.message,/1 道/);assert.deepEqual(summary.items,[item]);
});
