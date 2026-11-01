/**
 * ledger-budget-persist.test.mjs —— 改了热清单预算统计就必须落盘（2026-11-02，C109）
 *
 * 为什么：`ledger-budget.json` 是 doctor / 交接检查唯一的数据来源。C51/C52/C56/C90/C91 这几轮
 * 往里加了很多字段（sections / overBySession / traceDropped / minimalRenders / renderErrors / skipReasons），
 * 每加一个都要**更新内存 + 落盘**；只更新内存的话，运行期统计是对的、磁盘上永远缺这一项，
 * 而 doctor 会安静地显示旧数 —— 和 C108 的「漏记」是同一类问题，只是发生在**持久化**这一步。
 *
 * 判据（静态读 `src/engine.mjs`）：
 *   凡是 `this.ledgerBudget.<字段> = …` 的赋值，其后 15 行内必须有 `#persistLedgerBudget()`；
 *   仅允许一种例外：**已声明节流**的地方（注释里写明「每 N 次落一次盘」）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ENGINE = nodePath.join(HERE, "..", "src", "engine.mjs");
const WINDOW = 15;

export const tests = {};

tests["C109-1 每个 ledgerBudget 字段赋值都必须在 15 行内落盘（或明确声明节流）"] = (t) => {
  const lines = nodeFs.readFileSync(ENGINE, "utf8").split(String.fromCharCode(10));
  const assignments = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/this\.ledgerBudget\.[A-Za-z_]+ = /.test(lines[i])) assignments.push(i + 1);
  }
  t.eq(assignments.length >= 2, true, `至少要找到 2 处赋值（renderErrors / skipReasons），实际 ${assignments.length}`);

  for (const lineNo of assignments) {
    const start = lineNo - 1;
    const window = lines.slice(start, start + WINDOW).join(String.fromCharCode(10));
    const persists = window.includes("#persistLedgerBudget()");
    const throttled = /节流|每\s*\d+\s*次落/.test(window);
    t.eq(persists || throttled, true, `第 ${lineNo} 行改了 ledgerBudget 却既没落盘也没声明节流 —— doctor 会一直显示旧数`);
  }
};

tests["C109-2 落盘方法本身必须存在且真的写到持久层"] = (t) => {
  const text = nodeFs.readFileSync(ENGINE, "utf8");
  t.includes(text, "#persistLedgerBudget()", "必须有 private 落盘方法");
  t.includes(text, "this.persist.persistBudget(this.ledgerBudget)", "落盘必须交给 persist.persistBudget（单一写入口）");
};

tests["C109-3 判据自身要被验证（合成片段：有落盘 ⇒ 通过，无落盘 ⇒ 必须报）"] = (t) => {
  // 用与 C109-1 相同的窗口判据，喂两段合成代码 —— 防止「判据永远为真」的假绿。
  const NL = String.fromCharCode(10);
  const scan = (snippet) => {
    const lines = snippet.split(NL);
    const offenders = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/this\.ledgerBudget\.[A-Za-z_]+ = /.test(lines[i])) continue;
      const window = lines.slice(i, i + WINDOW).join(NL);
      if (!window.includes("#persistLedgerBudget()") && !/节流|每\s*\d+\s*次落/.test(window)) offenders.push(i + 1);
    }
    return offenders;
  };
  t.eq(scan(["this.ledgerBudget.alpha = 1;", "this.#persistLedgerBudget();"].join(NL)).length, 0, "有落盘 ⇒ 不报");
  t.eq(scan(["this.ledgerBudget.beta = 2;", "// 忘了落盘"].join(NL)).length, 1, "无落盘 ⇒ 必须报");
  t.eq(scan(["this.ledgerBudget.gamma = 3;", "// 每 20 次落一次盘（节流）"].join(NL)).length, 0, "声明节流 ⇒ 不报");
};
