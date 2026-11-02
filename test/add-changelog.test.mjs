/**
 * add-changelog.test.mjs —— 按编号插条目的工具（C403）
 *
 * 由来：手写锚点做替换，本会话静默失败过三次（标题差几个字 ⇒ replace no-op ⇒ 条目没写进去）。
 * 这里改为**按结构插入**（条目降序、紧跟索引表），并用测试钉住。
 */
import { insertEntry, maxNumber } from "../scripts/add-changelog.mjs";

export const tests = {};

const SAMPLE = ["# 变更", "", "| C2 | 二 |", "| C1 | 一 |", "", "### C2 · 二", "", "正文2", "", "### C1 · 一", "", "正文1", ""].join("\n");

tests["C403 插入位置：最新的在上（插在第一条条目之前）"] = (t) => {
  const out = insertEntry(SAMPLE, { c: 3, title: "三", body: "正文3" });
  const i3 = out.indexOf("### C3 · 三");
  const i2 = out.indexOf("### C2 · 二");
  t.ok(i3 >= 0, "必须插入了 C3");
  t.ok(i3 < i2, "C3 必须在 C2 之前（降序）");
  t.includes(out, "正文3", "正文要带上");
  // 原有内容不许丢
  t.includes(out, "### C1 · 一", "旧条目必须保留");
};

tests["C403 重复编号必须报错（不许悄悄插两条）"] = (t) => {
  let err = null;
  try {
    insertEntry(SAMPLE, { c: 2, title: "重复" });
  } catch (error) {
    err = error;
  }
  t.eq(err !== null, true, "重复编号必须抛错");
  t.includes(String(err?.message ?? ""), "已存在", "错误信息要说明已存在");
};

tests["C403 非法输入要让错误可读；maxNumber 取最大编号"] = (t) => {
  for (const bad of [{ c: 0, title: "x" }, { c: 1.5, title: "x" }, { c: 1, title: "  " }]) {
    let err = null;
    try {
      insertEntry(SAMPLE, bad);
    } catch (error) {
      err = error;
    }
    t.eq(err !== null, true, `应拒绝：${JSON.stringify(bad)}`);
  }
  t.eq(maxNumber(SAMPLE), 2, "maxNumber 取 2");
  t.eq(maxNumber("没有条目"), 0, "没有条目 ⇒ 0");
  // 文件结构变了（没有 ### C 条目）必须报错，而不是瞎插
  let err2 = null;
  try {
    insertEntry("# 空文件\n", { c: 1, title: "x" });
  } catch (error) {
    err2 = error;
  }
  t.eq(err2 !== null, true, "没有条目锚点时必须报错");
};
