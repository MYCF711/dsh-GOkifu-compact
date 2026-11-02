/**
 * knowledge-progress.test.mjs —— 进度页的「现状摘要」必须跟得上代码（C256）
 *
 * 为什么：进度页按轮次排，39 轮之后没人从头翻。摘要段是接手者唯一的入口，
 * 而它最容易变成"写着 1.17.5、实际已经 1.17.6"那种过期信息（本仓库已抓过三次同类）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

export const tests = {};

tests["C256 进度页必须有「现状摘要」，且版本号等于 package.json"] = (t) => {
  const doc = nodeFs.readFileSync(nodePath.join(ROOT, "docs", "knowledge", "进度.md"), "utf8");
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(ROOT, "package.json"), "utf8"));

  t.includes(doc, "## 现状摘要", "必须有摘要段（接手者的入口）");
  // 摘要段必须写出仓库版本，且就是 package.json 的版本
  const head = doc.slice(0, doc.indexOf("## 第 1 轮"));
  t.includes(head, `\`${pkg.version}\``, `摘要里的仓库版本必须是 ${pkg.version}`);
  // 三条「别再试」必须写明（防止下一个人重走）
  for (const id of ["B6", "B7", "B8"]) {
    t.includes(head, id, `摘要必须点名已否决的 ${id}`);
  }
  // 摘要段必须指向结论速查与重启验收清单（别让接手的人自己去翻目录）
  t.includes(head, "结论速查", "摘要要指向结论速查");
  t.includes(head, "重启验收清单", "摘要要指向重启验收清单");
};
