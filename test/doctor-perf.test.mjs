/**
 * doctor-perf.test.mjs —— doctor 解会话日志的性能约束（C463）
 *
 * 由来：`doctor` 曾经每个会话日志起一个 `python -c ...` 子进程（最多 24 个）来解多帧 zstd，
 * 实测 **24 秒**。改成进程内解码后 **8.75 秒**（2.7×）。而 `status` 要调 doctor ⇒ 一起被拖慢（30s）。
 *
 * 这类退化不会报错、只会变慢，所以只能用**源码守卫**钉住（与 C427「用户会用的脚本必须在包里」同一类）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const read = (rel) => nodeFs.readFileSync(nodePath.join(HERE, "..", rel), "utf8");

tests["C463 doctor 不许再 spawn python 解会话日志（那是 24s → 8.75s 的那一刀）"] = (t) => {
  const src = read("scripts/doctor.mjs");
  t.eq(src.includes('execFileSync("python"'), false, "别回退到 python 子进程：每个日志一个进程，最多 24 个");
  t.eq(src.includes("decodeMultiFrameZstd"), true, "必须用进程内的多帧解码器（session-scan）");
};

tests["C463 多帧扫描要用 Buffer.indexOf（原生），不许逐字节 for"] = (t) => {
  // ★ C498：解码器已搬进 `src/rooms/zstd-log.mjs`（插件进程也要读日志）—— 守卫跟着实现走
  const src = read("src/rooms/zstd-log.mjs");
  t.eq(src.includes("b.indexOf(magic"), true, "用原生查找");
  t.eq(/for \(let i = 0; i \+ 4 <= b\.length; i \+= 1\)/.test(src), false, "逐字节扫描已删除（35MB = 3500 万次迭代）");
  t.eq(read("scripts/session-scan.mjs").includes("zstd-log"), true, "脚本侧必须转发到共享实现，不许再抄一份");
};

tests["C464 doctor 一次运行只解一次图（9 个块各自 loadSessionGraph = 多付 4 秒）"] = (t) => {
  const src = read("scripts/doctor.mjs");
  // 只允许一处直接调用（那个就是缓存函数的实现本身）
  const direct = [...src.matchAll(/loadSessionGraph\(/g)].length;
  t.eq(direct <= 2, true, `直接调用 loadSessionGraph 的地方有 ${direct} 处 —— 只该有 import 与 loadGraphCached 内部`);
  t.eq(src.includes("function loadGraphCached"), true, "必须有进程内图缓存");
  t.eq(src.includes("graphCache"), true, "缓存容器在位");
};

tests["C513 patch 里没有模型表 ⇒ 要问一次本机网关（magpie /v1/models），不许直接判 error"] = (t) => {
  const src = read("scripts/doctor.mjs");
  t.includes(src, "function liveProviderModels", "必须有运行时取模型表的兜底");
  t.includes(src, "http://127.0.0.1:3425/v1/models", "只问本机 magpie 网关（AGENTS.md 登记的出口）");
  t.includes(src, "if (fromPatch.length > 0) return fromPatch;", "patch 里有就以 patch 为准（不额外发请求）");
  t.includes(src, "return liveProviderModels(name);", "patch 没有才走兜底");
};

tests["C516 doctor 必须报出「归档了但仍有一大截没折」的会话（含合计事件数）"] = (t) => {
  const src = read("scripts/doctor.mjs");
  t.includes(src, "归档后剩余的未折尾巴", "要有这一条检查");
  t.includes(src, ">= 1000", "阈值写清楚");
  t.includes(src, "Math.max(...marks.map((m) => Number(m.seqEnd)))", "尾巴必须按 foldMarks 算");
  t.eq(src.includes("lastFoldSeq"), true, "注释里要说明为什么不能用 lastFoldSeq");
  t.includes(src, "只能补账", "要告诉人怎么办（已归档的不会再收尾）");
};

tests["C536 doctor 要区分「开关开着」与「真的在动」"] = async (t) => {
  const src = read("scripts/doctor.mjs");
  t.includes(src, "自动补账", "要有这一条");
  t.includes(src, "近 24h 折了", "要报近 24h 的真实产出");
  t.includes(src, "一次都没跑过", "从没跑过要明说");
  t.includes(src, "开关开着却没产出", "开着但零产出要给出可能原因");
  t.includes(src, "cordis.patch.yml", "开关来自预设文件");
  t.includes(src, "enabled = false", "显式 false 才算关");
};

tests["C543 「缺口还没进欠账」这句必须改掉（C519 之后它就是欠账）"] = async (t) => {
  const src = read("scripts/doctor.mjs");
  t.eq(/[^原来写「]这些还没进欠账/.test(src), false, "过期断言不许留着（注释里引用是可以的）");
  t.includes(src, "已经进欠账", "要说清缺口已经计入欠账");
  t.includes(src, "C519/C520/C522", "指出是哪几条改的（免得下次又写回过期结论）");
};

tests["C545 历史记录里的「更晚实体」也要滤掉硬事实 id（否则 C539 只治新数据）"] = async (t) => {
  const src = read("scripts/doctor.mjs");
  t.includes(src, "laterIdsRaw", "先留原始集合");
  t.includes(src, "factsEdgeIds", "要有硬事实 id 集合");
  t.includes(src, 'edge?.result === "failure" || edge?.result === "success"', "判据与 C539 一致");
  t.includes(src, "laterIdsRaw.filter((id) => !factsEdgeIds.has(String(id)))", "过滤后再取前 8 个");
};
