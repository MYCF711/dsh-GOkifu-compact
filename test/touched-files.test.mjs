/**
 * touched-files.test.mjs —— C4「折叠摘要里的最近访问文件」回归（2026-11-01）
 *
 * 为什么要有：`extractTouchedFiles` 是**机械抽取**（零模型调用），它的价值全在
 * 「解析对不对、顺序对不对、区间有没有越界」。任何一条错了，摘要里就会出现
 * 「没访问过的文件」或「旧访问盖掉新访问」—— 模型会按错误的文件去判断，比不写更糟。
 *
 * 覆盖：正常解析 / 引号与空格 / 盘符 / 被截断的 action / 非文件类工具不解析 /
 *       去重（留最近）/ 按 evidence.end 倒序 / limit / range 交集过滤 / 空集 / 渲染格式。
 */

import { extractTouchedFiles, formatTouchedFiles, parseTouchedFileAction } from "../src/rooms/touched-files.mjs";

export const tests = {};

/** 只造 extractTouchedFiles 需要的形状：`{ edges: { e1: { action, evidence } } }`。 */
function graphOf(edges) {
  const dict = {};
  edges.forEach((edge, index) => {
    dict[`e${index + 1}`] = { id: `e${index + 1}`, from: "n0", to: "n1", result: "success", ...edge };
  });
  return { nodes: {}, edges: dict };
}

tests["C4-1 正常解析：read/edit/write 的 file_path 都能取出来（去掉闭合括号）"] = (t) => {
  t.eq(parseTouchedFileAction("read(file_path=/tmp/a.md)"), "/tmp/a.md", "read");
  t.eq(parseTouchedFileAction("edit(file_path=D:\\repo\\src\\a.mjs)"), "D:\\repo\\src\\a.mjs", "Windows 盘符路径");
  t.eq(parseTouchedFileAction("write(file_path=/tmp/b.txt)"), "/tmp/b.txt", "write");
  t.eq(parseTouchedFileAction("apply_patch(path=src/a.mjs)"), "src/a.mjs", "apply_patch 用 path 键");
  t.eq(parseTouchedFileAction("multi_edit(file_path=src/b.mjs)"), "src/b.mjs", "multi_edit");
};

tests["C4-2 带空格 / 引号 / 第二个参数的值里带空格：路径必须完整"] = (t) => {
  t.eq(parseTouchedFileAction("read(file_path=D:\\my docs\\a.md)"), "D:\\my docs\\a.md", "路径里可以有空格");
  t.eq(parseTouchedFileAction('read(file_path="D:\\my docs\\a.md")'), "D:\\my docs\\a.md", "成对双引号要剥掉");
  t.eq(parseTouchedFileAction("edit(path='/tmp/x y/z.mjs')"), "/tmp/x y/z.mjs", "成对单引号要剥掉");
  t.eq(
    parseTouchedFileAction("write(file_path=D:\\repo\\a.md content=# 标题 还有空格)"),
    "D:\\repo\\a.md",
    "第二个参数 `content=` 带空格时不能把内容并进路径",
  );
};

tests["C4-3 被截断的 action（没有闭合括号 / 路径到 240 截断）不崩，给出可用的前缀"] = (t) => {
  const cut = `read(file_path=/tmp/${"x".repeat(400)}`;
  const parsed = parseTouchedFileAction(cut);
  t.eq(typeof parsed, "string", "截断的 action 仍要给出字符串（不许抛）");
  t.eq(parsed.length, 240, "路径上限 240 字符");
  t.includes(parsed, "/tmp/", "前缀必须保留");
  // 图的 action 在 kifu-model 里本来就 slice 到 240，可能恰好断在值中间
  t.eq(parseTouchedFileAction("read(file_path=/tmp/half"), "/tmp/half", "值后面没有括号也要能取");
};

tests["C4-4 不解析非文件类工具（尤其 bash 里的路径）"] = (t) => {
  t.eq(parseTouchedFileAction("bash(command=cat a.txt)"), null, "bash 不解析");
  t.eq(parseTouchedFileAction('bash(command=cd /tmp && node test.mjs)'), null, "命令里的路径不能进清单");
  t.eq(parseTouchedFileAction("web_fetch(url=https://x/y)"), null, "非文件类工具不解析");
  t.eq(parseTouchedFileAction("read(dir=/tmp)"), null, "没有 file_path/path 参数 ⇒ null");
  t.eq(parseTouchedFileAction(""), null, "空 action");
  t.eq(parseTouchedFileAction(null), null, "null action");
};

tests["C4-5 去重：同一个文件多次访问只留最近的一次（seq 取最新）"] = (t) => {
  const g = graphOf([
    { action: "read(file_path=/a.md)", evidence: { start: 10, end: 12 } },
    { action: "edit(file_path=/a.md)", evidence: { start: 30, end: 31 } },
    { action: "write(file_path=/b.md)", evidence: { start: 20, end: 21 } },
  ]);
  const rows = extractTouchedFiles(g);
  t.eq(rows.length, 2, "两个不同文件 ⇒ 两行");
  t.eq(rows[0], { path: "/a.md", seqStart: 30, seqEnd: 31 }, "重复路径保留最近一次访问（不是最早）");
  t.eq(rows[1], { path: "/b.md", seqStart: 20, seqEnd: 21 }, "其余按时间倒序");
};

tests["C4-6 排序与上限：evidence.end 倒序，limit 默认 5、可配置"] = (t) => {
  const g = graphOf(
    Array.from({ length: 7 }, (_, i) => ({
      action: `read(file_path=/f${i}.md)`,
      evidence: { start: i * 10, end: i * 10 + 1 },
    })),
  );
  const rows = extractTouchedFiles(g);
  t.eq(rows.length, 5, "默认上限 5");
  t.eq(rows.map((r) => r.path), ["/f6.md", "/f5.md", "/f4.md", "/f3.md", "/f2.md"], "最近访问的在前");
  t.eq(extractTouchedFiles(g, { limit: 2 }).map((r) => r.path), ["/f6.md", "/f5.md"], "limit 生效");
  t.eq(extractTouchedFiles(g, { limit: 0 }).length, 5, "非法 limit 回落默认 5（不返回空）");
};

tests["C4-7 range 交集过滤：只取与折叠区间有交集的边"] = (t) => {
  const g = graphOf([
    { action: "read(file_path=/before.md)", evidence: { start: 1, end: 2 } },
    { action: "edit(file_path=/inside.md)", evidence: { start: 9, end: 11 } },
    { action: "write(file_path=/after.md)", evidence: { start: 30, end: 31 } },
    { action: "read(file_path=/no-evidence.md)" },
  ]);
  const rows = extractTouchedFiles(g, { range: { start: 10, end: 20 } });
  t.eq(rows.map((r) => r.path), ["/inside.md"], "只有与区间相交的边（9-11 ∩ 10-20）");
  // evidence 是数字的旧图形态也要认
  const numeric = graphOf([{ action: "read(file_path=/num.md)", evidence: 12 }]);
  t.eq(extractTouchedFiles(numeric, { range: { start: 10, end: 20 } })[0]?.path, "/num.md", "evidence 为数字也认");
  t.eq(extractTouchedFiles(numeric, { range: { start: 13, end: 20 } }).length, 0, "数字 evidence 不在区间 ⇒ 不取");
};

tests["C4-8 空集：没有文件类边 / 空图 ⇒ 空数组（摘要不追加段）"] = (t) => {
  t.eq(extractTouchedFiles(graphOf([])), [], "空图");
  t.eq(extractTouchedFiles(null), [], "null 图不崩");
  t.eq(extractTouchedFiles({ edges: {} }), [], "空 edges");
  const onlyBash = graphOf([{ action: "bash(command=ls)", evidence: { start: 1, end: 2 } }]);
  t.eq(extractTouchedFiles(onlyBash), [], "只有 bash ⇒ 空（不猜路径）");
  t.eq(formatTouchedFiles([]), "", "空数组渲染成空串（engine 因此不追加段）");
};

tests["C4-9 渲染格式：`- <path> (seq a-b)` 每行一条，保持抽取顺序"] = (t) => {
  const text = formatTouchedFiles([
    { path: "/a.md", seqStart: 30, seqEnd: 31 },
    { path: "D:\\repo\\b c.mjs", seqStart: 20, seqEnd: 21 },
  ]);
  t.eq(text, "- /a.md (seq 30-31)\n- D:\\repo\\b c.mjs (seq 20-21)", "机械格式固定");
};
