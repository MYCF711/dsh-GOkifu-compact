#!/usr/bin/env node
/**
 * repair-foldmarks.mjs —— 修 `foldMark.seqStart > seqEnd` 的历史坏记录（C279）
 *
 * 背景：C187 之前 tier-2 合并用 surface 顺序取 checkpoint，live 上真的落过一条
 * `foldMarks[9] seqStart=17596 > seqEnd=7629`（合并区间是反的）。C187 已修**生成侧**，
 * 但那条旧记录还留在磁盘上 ⇒ doctor / graph-audit / handoff-check 永远各报一条红，
 * 长期红下去等于把这条判据训练成噪声。
 *
 * 本脚本只做一件事：把**反了的两个数换回来**（`[start,end]` 升序）。
 *   · 默认 dry-run，只打印；
 *   · `--apply` 才写：先备份 `<graph.json>.bak-foldmark-<ts>`，再 tmp+rename 原子替换，
 *     写后立刻重读校验（换回来的必须真的升序）。
 *   · 只动 `foldMarks[i].seqStart/seqEnd`，别的字段一个不碰。
 *
 * 为什么允许换而不是删：tier-2 的语义就是「合并最老的两段」，那条记录的
 * `at/closure/summaryChars/quality` 都是真的，只是区间顺序反了 —— 换回来就是它本来的意思。
 *
 * 用法：
 *   node scripts/repair-foldmarks.mjs                 # dry-run
 *   node scripts/repair-foldmarks.mjs --apply         # 真写（带备份）
 *   node scripts/repair-foldmarks.mjs --home <dir>    # 指定 DSH_HOME
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/** 找出所有「区间反了」的 foldMark（纯函数，便于测试）。 */
export function findSwappedMarks(graph) {
  const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
  const out = [];
  for (let i = 0; i < marks.length; i += 1) {
    const m = marks[i];
    const start = Number(m?.seqStart);
    const end = Number(m?.seqEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start > end) out.push({ index: i, seqStart: start, seqEnd: end, trigger: m?.trigger ?? "?" });
  }
  return out;
}

/** 就地把反掉的区间换回来；返回换了几条（纯函数）。 */
export function swapRanges(graph) {
  let fixed = 0;
  for (const one of findSwappedMarks(graph)) {
    const m = graph.foldMarks[one.index];
    m.seqStart = one.seqEnd;
    m.seqEnd = one.seqStart;
    fixed += 1;
  }
  return fixed;
}

function defaultHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME
    : nodePath.join(os.homedir(), ".dsh");
}

function listGraphFiles(sessionsRoot) {
  if (!nodeFs.existsSync(sessionsRoot)) return [];
  return nodeFs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => nodePath.join(sessionsRoot, e.name, "graph.json"))
    .filter((file) => nodeFs.existsSync(file));
}

export function main(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const homeIdx = argv.indexOf("--home");
  const home = homeIdx >= 0 && argv[homeIdx + 1] ? argv[homeIdx + 1] : defaultHome();
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");

  const files = listGraphFiles(sessionsRoot);
  if (files.length === 0) {
    console.log(`没有会话图：${sessionsRoot}`);
    return 0;
  }

  let badSessions = 0;
  let badMarks = 0;
  let fixedTotal = 0;
  for (const file of files) {
    let graph;
    let text;
    try {
      text = nodeFs.readFileSync(file, "utf8");
      graph = JSON.parse(text);
    } catch (error) {
      console.log(`  ! 跳过坏图 ${nodePath.basename(nodePath.dirname(file))}：${String(error?.message ?? error).slice(0, 60)}`);
      continue;
    }
    const bad = findSwappedMarks(graph);
    if (bad.length === 0) continue;
    badSessions += 1;
    badMarks += bad.length;
    const session = nodePath.basename(nodePath.dirname(file));
    console.log(`  · ${session}：${bad.map((b) => `foldMarks[${b.index}] ${b.seqStart}>${b.seqEnd}(${b.trigger})`).join(" / ")}`);
    if (!apply) continue;

    const fixed = swapRanges(graph);
    if (fixed === 0) continue;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    nodeFs.copyFileSync(file, `${file}.bak-foldmark-${stamp}`);
    const tmp = `${file}.tmp-repair-${process.pid}`;
    nodeFs.writeFileSync(tmp, JSON.stringify(graph), "utf8");
    nodeFs.renameSync(tmp, file);
    // 写后校验：换回来的必须真的升序
    const reread = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    if (findSwappedMarks(reread).length !== 0) {
      console.log(`    ✗ ${session} 写后仍有反序记录（已保留备份 ${stamp}）`);
      continue;
    }
    fixedTotal += fixed;
    console.log(`    ✓ ${session} 已修 ${fixed} 条（备份 .bak-foldmark-${stamp}）`);
  }

  console.log(
    apply
      ? `\n修完：${badSessions} 个会话 / ${badMarks} 条反序记录；本次写入 ${fixedTotal} 条。`
      : `\n共 ${badSessions} 个会话 / ${badMarks} 条反序记录（dry-run：什么都没写；加 --apply 才修）。`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
