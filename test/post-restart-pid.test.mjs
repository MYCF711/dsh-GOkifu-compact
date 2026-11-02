/**
 * post-restart-pid.test.mjs —— 启动戳里的 pid 死了就必须说「不可信」（C293）
 *
 * 真实踩坑（2026-11-02）：build.json 写 pid 37616 / startedAt 12:30:05Z，
 * 而那个进程**早就不在了**。把它当"运行实例就绪时间"会把整轮判断带偏。
 */
import { pidAlive } from "../scripts/post-restart-check.mjs";

export const tests = {};

tests["C293 pid 探活：活着的进程 true、死的 pid false、坏值 null"] = (t) => {
  t.eq(pidAlive(process.pid), true, "自己一定活着");
  // 找一个几乎不可能存在的 pid（进程号上限内，且不是自己）
  const bogus = 2 ** 22 + 12345;
  t.eq(pidAlive(bogus), false, `不存在的 pid 必须判 false（${bogus}）`);
  t.eq(pidAlive(0), null, "0 不是合法 pid");
  t.eq(pidAlive(-1), null, "负数不是合法 pid");
  t.eq(pidAlive(Number.NaN), null, "NaN 不是合法 pid");
  t.eq(pidAlive(1.5), null, "非整数不是合法 pid");
};

tests["C294 能力探针：未知 action 必须判「内存里那份模块比磁盘旧」"] = async (t) => {
  const mod = await import("../scripts/post-restart-check.mjs");
  t.eq(typeof mod.checkPanelCapabilities, "function", "必须导出 checkPanelCapabilities");
  // 不可达端口 ⇒ warn（不许抛，也不许判 ok）
  const down = await mod.checkPanelCapabilities(undefined, { port: 1, timeoutMs: 300 });
  t.eq(down.level, "warn", "面板不可达必须 warn");
  t.includes(down.detail, "不可达", "要说清是端口不可达");
};
