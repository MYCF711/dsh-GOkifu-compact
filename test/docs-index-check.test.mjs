/**
 * docs-index-check.test.mjs —— 「新增文档必须被索引」的回归（2026-11-02，C23）
 *
 * 这条检查防的是**孤儿文档**：新写了调研/证据文件，但没人知道它在。
 * 测试两头都要钉住：能抓缺失、不误报已登记项。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { checkRepo, listMarkdown, missingFromIndex, INDEXED_DIRS } from "../scripts/docs-index-check.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

tests["D-1 索引里没提的文件 ⇒ 必须被抓出来（basename 与全名两种写法都算登记）"] = (t) => {
  const files = ["01-学术.md", "02-产品.md"];
  t.eq(missingFromIndex("见 docs/research/01-学术.md", files), ["02-产品.md"], "只登记了一个 ⇒ 另一个必须报缺");
  t.eq(missingFromIndex("清单：01-学术 与 02-产品（不带扩展名也算）", files), [], "不带 .md 的引用也算登记");
  t.eq(missingFromIndex("", files), files, "空索引 ⇒ 全部缺失");
};

tests["D-2 列目录：跳过索引自身、子目录、非 md"] = (t) => {
  const files = listMarkdown(REPO, { dir: "docs/research", index: "README.md" });
  t.eq(files.includes("README.md"), false, "索引自身不算");
  t.eq(files.every((f) => f.endsWith(".md")), true, "只列 .md");
  t.eq(files.length >= 5, true, `research 目录至少 5 个文件（实际 ${files.length}）`);
};

tests["D-3 真实仓库：docs/research 与 evidence 的每个文档都在各自 README 里"] = (t) => {
  const { ok, missing, checked } = checkRepo();
  t.eq(ok, true, `存在未索引文档：${JSON.stringify(missing, null, 1)}`);
  t.eq(checked >= 10, true, `应当检查到足够多的文件（实际 ${checked}）`);
};

tests["D-4 检查器自身可复跑：索引文件必须存在（否则等于没索引）"] = (t) => {
  for (const spec of INDEXED_DIRS) {
    const indexPath = nodePath.join(REPO, spec.dir, spec.index);
    t.eq(nodeFs.existsSync(indexPath), true, `${indexPath} 必须存在 —— 它是对应目录的唯一入口`);
  }
};
