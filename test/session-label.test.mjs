/**
 * session-label.test.mjs —— 报告要说人话（C475）
 *
 * 用户原话：「你说的是你看到的编号，不是我这里看到的中文名」。
 * doctor 满屏 `session-b4664e8f…`，界面上写的却是「发布代码仓库并公开」。
 */
import { sessionLabel, loadWorkspaceTitles } from "../scripts/doctor.mjs";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

tests["C475 会话标签：有标题就用标题 + 短 id，没标题就退回 id"] = (t) => {
  const titles = { b4664e8f2db84f0aa1: "发布代码仓库并公开" };
  const hit = sessionLabel("session-b4664e8f2db84f0aa1", titles);
  t.includes(hit.label, "发布代码仓库并公开", "要用界面上的名字");
  t.includes(hit.label, "b4664e8f", "短 id 要留着（排查时仍能定位）");
  const miss = sessionLabel("session-zzzzzzzz-1", titles);
  t.eq(miss.label, "session-zzzzzzzz-1".slice(0, 20), "没标题就退回 id，不许显示空白");
  t.eq(miss.title, null, "title 为 null，调用方据此判断");
  // 带不带 session- 前缀都要能查
  t.eq(sessionLabel("b4664e8f2db84f0aa1", titles).title, "发布代码仓库并公开", "无前缀也能命中");
};

tests["C475 工作区标题表：读不到文件要返回空表（报告退回 id，不许因此失败）"] = (t) => {
  const empty = loadWorkspaceTitles(nodePath.join(HERE, ".nope-no-such-home"));
  t.eq(Object.keys(empty).length, 0, "没有文件 ⇒ 空表");
  // 造一个最小 workspace.json
  const home = nodePath.join(HERE, ".tmp-ws-titles");
  nodeFs.mkdirSync(nodePath.join(home, "storages"), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(home, "storages", "workspace.json"),
    JSON.stringify({ tables: { workspaces: { w1: { title: "反代", sessionIds: ["session-aaaa1111"] } } } }),
    "utf8",
  );
  const map = loadWorkspaceTitles(home);
  t.eq(map["aaaa1111"], "反代", "映射键是无前缀的会话 id");
  nodeFs.rmSync(home, { recursive: true, force: true });
};


tests["C484 「输出效率」的分母用记录里的 summaryTokens，而不是写死的 chars/3.5"] = async (t) => {
  const m = await import("../scripts/doctor.mjs");
  const pick = m.summaryTokenDenominator;
  t.eq(pick({ quality: { summaryTokens: 905 }, summaryChars: 2478 }), 905, "有记录就用记录（按字符类别加权的那个）");
  t.eq(pick({ summaryChars: 3500 }), 1000, "老记录没 summaryTokens ⇒ 兜底 chars/3.5");
  t.eq(pick({ summaryChars: 1 }), 1, "极小字符数也要 ≥1（不许除以 0）");
  t.eq(pick({}), null, "什么都没有 ⇒ null（调用方跳过，不编数字）");
  t.eq(pick({ quality: { summaryTokens: 0 }, summaryChars: 0 }), null, "0 不算数");
};
