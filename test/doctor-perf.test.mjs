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
  const src = read("scripts/session-scan.mjs");
  t.eq(src.includes("b.indexOf(magic"), true, "用原生查找");
  t.eq(/for \(let i = 0; i \+ 4 <= b\.length; i \+= 1\)/.test(src), false, "逐字节扫描已删除（35MB = 3500 万次迭代）");
};

tests["C464 doctor 一次运行只解一次图（9 个块各自 loadSessionGraph = 多付 4 秒）"] = (t) => {
  const src = read("scripts/doctor.mjs");
  // 只允许一处直接调用（那个就是缓存函数的实现本身）
  const direct = [...src.matchAll(/loadSessionGraph\(/g)].length;
  t.eq(direct <= 2, true, `直接调用 loadSessionGraph 的地方有 ${direct} 处 —— 只该有 import 与 loadGraphCached 内部`);
  t.eq(src.includes("function loadGraphCached"), true, "必须有进程内图缓存");
  t.eq(src.includes("graphCache"), true, "缓存容器在位");
};
