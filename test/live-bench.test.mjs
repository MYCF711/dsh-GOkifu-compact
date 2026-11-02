/**
 * live-bench.test.mjs —— 「真机基准」文档必须可机器复算（C376）
 *
 * 由来：这些数字以前是手抄的，一路过期（1072 passed / $0.83 / 40 分钟…），
 * 最后连 HANDOFF 都在说旧事实。现在改成生成物，这里守住它的形状。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { renderBenchDoc } from "../scripts/live-bench.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const DOC = nodePath.join(HERE, "..", "docs", "真机基准-自动生成.md");

export const tests = {};

tests["C376 基准文档由数据渲染：四节都在，且数字来自入参（不是写死）"] = (t) => {
  const doc = renderBenchDoc({
    files: 7,
    cache: { requests: 1234, miss: 11, hit: 99, output: 5, hitRate: 0.9 },
    folds: { n: 3, median: 11000, p90: 19000, max: 30000 },
    debt: { due: 4, tokens: 2_500_000, chunks: 9, estCost: 1.23, recommendedMaxTokens: 218348, totalCost: 9.87, top5Share: 0.56 },
  });
  for (const section of ["## 一、缓存与花费", "## 二、花费分布", "## 三、折叠耗时", "## 四、欠账"]) {
    t.includes(doc, section, `缺小节：${section}`);
  }
  // 数字来自入参
  t.includes(doc, "1,234", "请求数要来自入参（带千分位）");
  t.includes(doc, "90.0%", "命中率要按入参算");
  t.includes(doc, "11.0s", "中位耗时按毫秒换算");
  t.includes(doc, "$9.87", "全量花费来自入参");
  t.includes(doc, "218348", "建议单段上限来自入参");
  // 不许出现"手工维护"的痕迹
  t.eq(doc.includes("TODO"), false, "生成物里不许留 TODO");
};

tests["C376 仓库里的基准文档存在，且开头声明「自动生成」"] = (t) => {
  t.eq(nodeFs.existsSync(DOC), true, "docs/真机基准-自动生成.md 必须存在（缺了就跑 node scripts/live-bench.mjs --write）");
  if (!nodeFs.existsSync(DOC)) return;
  const text = nodeFs.readFileSync(DOC, "utf8");
  t.includes(text, "自动生成，勿手改", "必须声明是生成物");
  t.includes(text, "live-bench.mjs", "必须写明生成命令");
  t.includes(text, "命中率", "至少要有命中率这一节");
};

tests["C377 HANDOFF 必须指向生成物，且数字与它一致（防再次手抄漂移）"] = (t) => {
  const handoff = nodeFs.readFileSync(nodePath.join(HERE, "..", "HANDOFF.md"), "utf8");
  t.includes(handoff, "真机基准-自动生成.md", "HANDOFF 必须指向生成的基准文档（而不是自己抄数字）");
  t.includes(handoff, "生成物", "要说明那是生成物");

  if (!nodeFs.existsSync(DOC)) return;
  const bench = nodeFs.readFileSync(DOC, "utf8");
  // 从生成物里取命中率与全量花费，HANDOFF 里必须出现同样的数字
  const hit = bench.match(/\*\*(\d+\.\d)%\*\*（分母/);
  const cost = bench.match(/全量估算 \| \*\*\$(\d+\.\d\d)\*\*/);
  if (hit) t.includes(handoff, `${hit[1]}%`, `HANDOFF 的命中率必须与生成物一致（${hit[1]}%）`);
  if (cost) t.includes(handoff, `$${cost[1]}`, `HANDOFF 的全量花费必须与生成物一致（$${cost[1]}）`);
};

tests["C393 HANDOFF 不许再写着「跑的是旧代码 / 需重启」——真机已接管"] = (t) => {
  const handoff = nodeFs.readFileSync(nodePath.join(HERE, "..", "HANDOFF.md"), "utf8");
  const head = handoff.slice(0, handoff.indexOf("## 🗒"));
  t.eq(head.includes("运行实例跑的是旧代码"), false, "真机已接管，不许再写「跑的是旧代码」（过期信息比没有更糟）");
  t.eq(head.includes("需重启"), false, "不许再把「需重启」当现状");
  t.includes(head, "已接管", "要点明已接管");
  t.includes(head, "due 49", "要带出补账干跑的真实数字（49）");
  t.includes(head, "唯一待办", "必须保留唯一待办（C124）");
};

tests["C407 重启验收清单必须带「第二轮」现状快照（列清哪些字段还没生效）"] = (t) => {
  const doc = nodeFs.readFileSync(nodePath.join(HERE, "..", "evidence", "重启验收清单-2026-11-02.md"), "utf8");
  t.includes(doc, "第二轮（2026-11-03", "必须有第二张快照（否则又是一张过期地图）");
  for (const field of ["today.truncated", "update.relation", "foldMark.usage.model", "foldMark.finishReason", "measuredBefore"]) {
    t.includes(doc, field, `快照必须点名 ${field} 的状态`);
  }
  t.includes(doc, "accept-after-restart.mjs", "必须给出第一条件命令");
  t.includes(doc, "折叠证据字段", "必须指向 doctor 那行作为仪器链的判据");
};

tests["C418 docs 下的文件名不许含不可见字符（零宽/BOM/控制符）"] = (t) => {
  const root = nodePath.join(HERE, "..", "docs");
  const bad = [];
  const walk = (dir) => {
    for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const p = nodePath.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      // 零宽空格/连接符/BOM/双向控制符/控制字符
      if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u0000-\u001f]/.test(e.name)) bad.push(nodePath.relative(root, p));
    }
  };
  walk(root);
  t.eq(bad, [], `这些文件名含不可见字符（会让 glob/路径拼接/链接全部错位）：${bad.join(" / ")}`);
};

tests["C419 基准文档要有「从哪开始」：最小的三个会话（验证通道）"] = async (t) => {
  const doc = nodeFs.readFileSync(DOC, "utf8");
  t.includes(doc, "## 五、从哪开始", "必须有第五节（C419）");
  t.includes(doc, "尾巴事件", "要给尾巴事件数");
  const rows = doc.split("\n").filter((l) => /^\| \d \| /.test(l));
  t.eq(rows.length >= 1, true, "至少列出一个最小会话");
  // 渲染器本身也要能被假数据驱动（防写死）
  const { renderBenchDoc } = await import("../scripts/live-bench.mjs");
  const fake = renderBenchDoc({
    files: 1,
    cache: { requests: 1, miss: 1, hit: 0, output: 0, hitRate: 0 },
    folds: { n: 0, median: null, p90: null, max: null },
    debt: {
      due: 1, tokens: 0, chunks: 0, estCost: 0, recommendedMaxTokens: null, totalCost: 0, top5Share: null,
      smallest: [{ sessionId: "sess-x", tail: 7 }],
    },
  });
  t.includes(fake, "sess-x", "最小三个必须来自入参");
  t.includes(fake, "| 1 | sess-x | 7 |", "行格式要正确");
};

tests["C424 HANDOFF 必须给出「重启后三步」与「应该新出现的东西」（让重启可执行、可验收）"] = (t) => {
  const handoff = nodeFs.readFileSync(nodePath.join(HERE, "..", "HANDOFF.md"), "utf8");
  const head = handoff.slice(0, handoff.indexOf("## 🗒"));
  t.includes(head, "重启后的三步", "必须有照抄步骤（C424）");
  t.includes(head, "npm run status", "第一步必须是一键看现状");
  t.includes(head, "accept-after-restart.mjs", "第二步必须是验收命令");
  t.includes(head, "backfill-one.mjs", "第三步必须给出单会话验证命令");
  t.includes(head, "应该新出现", "必须列清重启后应新增的字段（否则无法判断生效没生效）");
  t.includes(head, "today.truncated", "要点名具体字段");
  t.includes(head, "sessionIds", "要点名参数级能力");
};
