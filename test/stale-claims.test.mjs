/**
 * stale-claims.test.mjs —— 「下一步要做 X」这类**承诺**过期了要能被抓出来（C544）
 *
 * 由来：真机 2026-11-04，`scripts/doctor.mjs` 里挂着一句
 *   「离线压缩还有缺口 …… 这些还没进欠账，**下一步做分段离线**」
 * 而 C519/C520/C522 早已做完。这类句子不会自己消失，还专门在下次排查时把人带偏。
 */
import { staleClaimInLine, scanFiles, collectDocs, collectCode } from "../scripts/stale-claims.mjs";
import nodePath from "node:path";
import nodeFs from "node:fs";
import { fileURLToPath } from "node:url";

export const tests = {};

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

tests["C544 真机那条过期句子必须被判出来"] = (t) => {
  const done = new Set(["C519", "C520", "C522"]);
  const old = "` —— 这些还没进欠账，下一步做分段离线（C519 之后就不对了）`";
  const hit = staleClaimInLine(old, done);
  t.eq(hit !== null, true, "「下一步做 + 已完成编号」必须命中");
  t.eq(hit.id, "C519", "命中的编号要指出来");
};

tests["C544 描述运行期状态的句子不许误报（第一版的坑）"] = (t) => {
  const done = new Set(["C219"]);
  const runtime = 'add("热清单注入动作", "warn", "未采集（ledger-budget.json 里还没有 injectActions —— C219 起才写）")';
  t.eq(staleClaimInLine(runtime, done), null, "「还没有 X 字段」是状态，不是待办");
  const log = "当时它还没生效（C219），所以没差别";
  t.eq(staleClaimInLine(log, done), null, "泛泛的『还没』不算承诺");
};

tests["C544 日志类文档不算现状（进度页/发布说明/evidence 是历史）"] = (t) => {
  const hits = scanFiles(
    [
      ...collectDocs(nodePath.join(ROOT, "docs")),
      ...collectCode(nodePath.join(ROOT, "scripts")),
      ...collectCode(nodePath.join(ROOT, "src")),
    ],
    (() => {
      const ids = new Set();
      const text = nodeFs.readFileSync(nodePath.join(ROOT, "CHANGELOG.md"), "utf8");
      for (const m of text.matchAll(/^### (C\d{1,4})\b/gm)) ids.add(m[1]);
      return ids;
    })(),
  );
  const historical = hits.filter((h) => h.file.startsWith("docs/knowledge/进度.md") || h.file.startsWith("evidence/"));
  t.eq(historical, [], "进度页与 evidence 里的『还没』是历史记录，不该被判过期");
};
