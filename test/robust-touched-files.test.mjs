/**
 * robust-touched-files.test.mjs —— 「最近访问文件」解析器的健壮性（2026-11-02，C92）
 *
 * `parseTouchedFileAction` 的输入是**工具 action 字符串**（可能被宿主截断、可能带引号/空格/括号），
 * 输出会进**模型可见**的摘要尾巴（`最近访问文件`）。它在 `hot-inject` 的注入路径上被调用，
 * 抛异常会让这一次注入降级（C90 能看见，但没必要让它发生）。
 *
 * 这里用「路径里带正则元字符 / 引号 / 空格 / 括号」的一组真实形状做健壮性验证：
 *   ① 永不抛；② 返回值必须是输入的子串（不许凭空造字符）；
 *   ③ 正常闭合形状必须精确解析；④ 截断形状必须给出可用的前缀。
 */

import { parseTouchedFileAction } from "../src/rooms/touched-files.mjs";

export const tests = {};

const CASES = [
  String.raw`read(file_path=D:\repo\a+b(c).mjs)`,
  String.raw`write(file_path="D:\my docs\x[1].md" content=hi)`,
  String.raw`edit(file_path=C:\x(y).z)`,
  String.raw`read(file_path=/tmp/a.b[c].txt)`,
  String.raw`write(file_path=D:\p\q r.md content=# 标题)`,
  String.raw`read(file_path=D:\repo\a.mjs`,
  String.raw`read(path=D:\repo\a.mjs)`,
  String.raw`read(file_path=D:\repo\a{1,2}.mjs)`,
  String.raw`read(file_path=D:\repo\$dollar^caret.mjs)`,
  String.raw`read(file_path=D:\repo\a|b.mjs)`,
  String.raw`read(file_path=)`,
  String.raw`read()`,
  "",
  "not a tool call at all",
];

tests["C92-1 任何形状都不抛，且返回值必是输入的子串（不许凭空造字符）"] = (t) => {
  for (const action of CASES) {
    let out;
    try {
      out = parseTouchedFileAction(action);
    } catch (error) {
      t.eq(false, true, `解析器抛了异常（输入 ${JSON.stringify(action)}）：${error.message}`);
      continue;
    }
    if (out === null) continue;
    t.eq(typeof out, "string", `返回值必须是字符串：${JSON.stringify(out)}`);
    t.eq(action.includes(out), true, `返回值必须是输入的子串：in=${JSON.stringify(action)} out=${JSON.stringify(out)}`);
  }
};

tests["C92-2 正则元字符路径必须精确解析（不能被当成模式的一部分）"] = (t) => {
  t.eq(parseTouchedFileAction(String.raw`read(file_path=D:\repo\a+b(c).mjs)`), String.raw`D:\repo\a+b(c).mjs`, "加号/括号必须原样保留");
  t.eq(parseTouchedFileAction(String.raw`read(file_path=/tmp/a.b[c].txt)`), "/tmp/a.b[c].txt", "方括号必须原样保留");
  t.eq(parseTouchedFileAction(String.raw`read(file_path=D:\repo\a{1,2}.mjs)`), String.raw`D:\repo\a{1,2}.mjs`, "花括号必须原样保留");
  t.eq(parseTouchedFileAction(String.raw`read(file_path=D:\repo\a|b.mjs)`), String.raw`D:\repo\a|b.mjs`, "竖线必须原样保留");
};

tests["C92-3 带引号/空格/截断/空值：给可用结果或不给，但绝不猜"] = (t) => {
  t.eq(parseTouchedFileAction(String.raw`write(file_path="D:\my docs\x[1].md" content=hi)`), String.raw`D:\my docs\x[1].md`, "带引号+空格的路径必须精确");
  t.eq(parseTouchedFileAction(String.raw`write(file_path=D:\p\q r.md content=# 标题)`), String.raw`D:\p\q r.md`, "空格路径必须在下一个 key 处截断");
  t.eq(parseTouchedFileAction(String.raw`read(file_path=D:\repo\a.mjs`), String.raw`D:\repo\a.mjs`, "截断形状必须给前缀");
  t.eq(parseTouchedFileAction(String.raw`read(file_path=)`), null, "空值不许编出路径");
  t.eq(parseTouchedFileAction("read()"), null, "没有路径键 ⇒ null");
  t.eq(parseTouchedFileAction(""), null, "空串 ⇒ null");
  t.eq(parseTouchedFileAction("not a tool call at all"), null, "非工具调用 ⇒ null");
};
