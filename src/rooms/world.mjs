/**
 * worldstate.mjs —— 世界状态哈希（置换检测的判据来源）
 *
 * 判据（对应用户「置换 = 换一条路回到之前卡住的地方」）：
 *   stateKey = worldHash（世界变了没有） + constraintHash（已知约束变了没有）
 * 两条不同的边指向同一个 stateKey ⇒ 置换，不再新建节点。
 *
 * 成本纪律：
 *   · 只 stat 本会话触碰过的文件（不扫全树、不跑 git）
 *   · 触碰文件数超过上限时退化为「触碰路径集合哈希」（仍能判置换，只是更粗）
 *   · 哈希是同步的，可在任意地方调用
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { sha, hashSet } from "./kifu-model.mjs";

const MAX_STAT_FILES = 200;

export function createWorldTracker({ cwd = "", maxFiles = MAX_STAT_FILES } = {}) {
  const touched = new Set();
  return {
    get cwd() {
      return cwd;
    },
    get size() {
      return touched.size;
    },
    /** 记录一次触碰（写类/命令类工具的参数或结果里出现的路径）。 */
    touch(paths) {
      // ★ 2026-10-29 修复（全库自环 60.9% 的根因之一）：调用点 `engine.mjs:195`
      //   `st.touchPath = (p) => world.touch(p)` 传的是**单个路径字符串**，
      //   而这里按可迭代对象遍历 ⇒ 一个路径被拆成逐字符的 20 多个「路径」。
      //   后果链：触碰集合变成 {'.','D',':','/','m','a'…}（set 去重后只剩十来个字符）
      //   ⇒ `hash()` 对所有会话、所有步骤返回**同一个哈希** ⇒ `stateIndex` 命中同一节点
      //   ⇒ `step/end` 的边 to 指回本步起点 ⇒ 自环。
      //   兼容 string 与 array 两种入参；单字符丢弃（旧数据里混进来的就是这类）。
      const list = typeof paths === "string" ? [paths] : Array.isArray(paths) ? paths : [];
      for (const p of list) {
        if (typeof p !== "string" || p.length < 2) continue;
        const abs = nodePath.isAbsolute(p) ? p : nodePath.resolve(cwd || process.cwd(), p);
        if (touched.size < 2000) touched.add(abs);
      }
    },
    /** 触碰过的路径列表（供落盘/人读）。 */
    list() {
      return [...touched];
    },
    /**
     * 计算世界状态哈希。
     * @returns {{ hash: string, mode: 'stat'|'paths', files: number }}
     */
    hash() {
      if (touched.size === 0) return { hash: sha("empty"), mode: "paths", files: 0 };
      if (touched.size > maxFiles) {
        return { hash: hashSet([...touched]), mode: "paths", files: touched.size };
      }
      const entries = [];
      for (const p of [...touched].sort()) {
        try {
          const st = nodeFs.statSync(p);
          entries.push(`${rel(p, cwd)}:${st.size}:${Math.trunc(st.mtimeMs)}`);
        } catch {
          entries.push(`${rel(p, cwd)}:missing`);
        }
      }
      return { hash: hashSet(entries), mode: "stat", files: entries.length };
    },
    /** 从磁盘状态恢复（重启后继续用同一份触碰集合）。 */
    restore(paths) {
      for (const p of paths ?? []) touched.add(String(p));
    },
  };
}

function rel(abs, cwd) {
  if (!cwd) return abs;
  const r = nodePath.relative(cwd, abs);
  return r.length === 0 || r.startsWith("..") ? abs : r;
}
