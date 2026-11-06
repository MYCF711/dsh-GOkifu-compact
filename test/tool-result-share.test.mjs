/**
 * tool-result-share.test.mjs —— 工具结果到底占多少、清掉会不会伤死路（C481）
 *
 * 候选 K-2（"把 pruneSession 提前到每步"）一直没做，因为它从没被量过。
 */
import { measureToolResultShare, isRememberedByGraph, summarizeOverlap } from "../scripts/tool-result-share.mjs";

export const tests = {};

const toolResult = (text) => ({ type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text }] } } });
const userMsg = (text) => ({ type: "user/message", data: { message: { role: "user", content: [{ type: "text", text }] } } });
const asstMsg = (text) => ({ type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text }] } } });

tests["C481 字数统计：工具结果与文本消息分开算"] = (t) => {
  const s = measureToolResultShare([userMsg("abc"), toolResult("0123456789"), asstMsg("de")]);
  t.eq(s.toolChars, 10, "工具结果 10 字符");
  t.eq(s.textChars, 5, "文本 3+2");
  t.eq(s.toolResults, 1, "一次工具结果");
  t.eq(s.textMessages, 2, "两条消息");
  // 坏数据不许 NaN
  const bad = measureToolResultShare([null, {}, { type: "tool/result" }]);
  t.eq(Number.isNaN(bad.toolChars), false, "缺失内容记 0");
};

tests["C481 已被图记住：错误片段出现在失败边的 errorSnippet 里"] = (t) => {
  const body = "Error: EACCES: permission denied, open 'prod.yml'\n   at open (fs.js:1)";
  const edges = [{ result: "failure", errorSnippet: "Error: EACCES: permission denied, open 'prod.yml'" }];
  t.eq(isRememberedByGraph(body, edges), true, "片段在正文里 ⇒ 已记住");
  t.eq(isRememberedByGraph(body, [{ result: "failure", errorSnippet: "completely different" }]), false, "对不上 ⇒ 没记住");
  t.eq(isRememberedByGraph(body, []), false, "没有边 ⇒ 没记住");
  t.eq(isRememberedByGraph("", edges), false, "空文本 ⇒ 不算");
  // 太短的片段不当依据（避免 "Error" 这种到处都有的词）
  t.eq(isRememberedByGraph(body, [{ errorSnippet: "Error" }]), false, "片段太短 ⇒ 不作为依据");
};

tests["K-32 空白归一化：CRLF / 连续空格不能算「没记住」"] = (t) => {
  const messyBody = "Error:\r\n  EACCES: permission denied,\r\n    open 'prod.yml'";
  const cleanSnippet = "Error: EACCES: permission denied, open 'prod.yml'";
  // 旧判据直接 body.includes(snippet.slice(0,60))，这里会假阴性。
  t.eq(isRememberedByGraph(messyBody, [{ result: "failure", errorSnippet: cleanSnippet }]), true, "空白差异仍算记住");
  t.eq(isRememberedByGraph(messyBody, [{ result: "failure", errorSnippet: cleanSnippet.replace("prod.yml", "other.yml") }]), false, "真实内容不同仍不算");
  t.eq(isRememberedByGraph("   \r\n ", [{ errorSnippet: cleanSnippet }]), false, "纯空白文本 => 没记住");
  t.eq(isRememberedByGraph(messyBody, [{ errorSnippet: "Error" }]), false, "归一化后太短仍不作为依据");
};

tests["C481 汇总：可清上限 = 工具结果 − 已被记住的那部分"] = (t) => {
  const rememberable = "Error: EACCES: permission denied, open 'prod.yml'";
  const s = summarizeOverlap(
    [userMsg("g"), toolResult("x".repeat(100)), toolResult(rememberable.repeat(2))],
    [{ errorSnippet: rememberable }],
  );
  t.eq(s.toolChars, 100 + rememberable.length * 2, "工具结果总字数");
  t.eq(s.rememberedChars, rememberable.length * 2, "被记住的就是那一整条");
  t.eq(s.prunableChars, 100, "剩下 100 字符才是可清上限");
  t.eq(Math.round((s.prunableShare ?? 0) * 100), Math.round((100 / s.toolChars) * 100), "占比要对得上");
  // 没有任何工具结果时不许出 NaN / Infinity
  const empty = summarizeOverlap([userMsg("a")], []);
  t.eq(empty.toolShare, 0, "没有工具结果 ⇒ 占比 0");
  t.eq(empty.prunableShare, null, "分母为 0 ⇒ null（调用方显示 —）");
};
