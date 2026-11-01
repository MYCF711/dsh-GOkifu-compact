/**
 * user-patch.mjs —— 「用户层 patch 遮蔽引擎」的自动登记（2026-11-02，1.17.1）
 *
 * 背景：profile 的用户层 `cordis.patch.yml` 最后应用。GUI 的 preset 编辑器会把整份
 * `preset-standard`（含 compaction-basic）写进用户层，把插件 bundle 层的引擎覆盖盖回去。
 * 宿主还有一层**机器级 patch** `$DSH_HOME/cordis.patch.yml`，它比 profile 层**更晚**应用
 * （`composeEntries([bundle 层, profile 层, home 层])`），是唯一能压过用户层的合法层。
 *
 * 但宿主的 patch 语义是「按 id 整值替换、只匹配顶层/组内条目」：
 *   · 不能重命名 `compaction-basic`（patch 的 `name` 是**校验**不是赋值）；
 *   · 不能匹配 preset 内部的嵌套 id（`preset-*` 不是 group，其 `config.plugins` 不建索引）；
 *   · 能做的只有「整行替换 `preset-standard`」。
 * 所以这里走**整行复制 + 只换 compaction 成员**：把用户层里那条 preset 行原样抄到 home 层，
 * 仅把 `compaction-basic` 换成 `gokifu-compact/engine` —— persona / 工具开关 / 其它成员一律不动。
 *
 * 生效时机：home 层在启动装配时读取，所以本模块由插件在**进程退出时**写入（`process.on('exit')`，
 * 同步小文件，不会触发热重载）。下一次启动即接管；用户不需要跑任何命令。
 *
 * 纯函数 + 一个写盘函数，便于单测。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";

/**
 * 是不是测试运行时（`node test/run.mjs …` / `*.test.mjs`）。
 * 退出钩子必须在这里闭嘴：测试会 import 真实插件模块，跑完进程退出时若照常写盘，
 * 就会写到真实 `$DSH_HOME`（2026-11-02 实测发生过一次）。真实宿主的 argv[1] 是宿主入口，
 * 不会命中这些模式。
 */
export function isTestRuntime(argv1 = process.argv[1] ?? "") {
  const file = String(argv1).split(String.fromCharCode(92)).join("/");
  return file.includes("/test/") || file.endsWith("/test/run.mjs") || file.endsWith(".test.mjs");
}

/** home 层里我们托管的那一段的起始标记（每次重写这一段，其它内容原样保留）。 */
export const MANAGED_MARKER = "# gokifu-compact: 自动登记（下次启动生效；勿手改这一段）";

const PRESET_ROW = /^- id:\s*(preset-[A-Za-z0-9._-]+)\s*$/;
const COMPACTION_ID_LINE = /^(\s*)- id:\s*compaction-basic\s*$/;
const COMPACTION_NAME_LINE = /^(\s*)name:\s*['"]?@deepseek-ai\/dsh-compaction-basic['"]?\s*$/;

/** 把 YAML 文本切成顶层行块（每个 `- ` 开头的行是一个块的起点）。 */
export function splitTopLevelBlocks(text) {
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const lines = String(text ?? "")
    .split(LF)
    .map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line));
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (/^- /.test(line)) {
      current = { start: index, end: index, lines: [line] };
      blocks.push(current);
    } else if (current !== null) {
      current.lines.push(line);
      current.end = index;
    }
  });
  return { lines, blocks };
}

/**
 * 用户层 patch 里哪些 preset 行需要复制到 home 层（按文本判定，不解析 YAML —— 里面可能有 `!!js`）。
 * @returns {Array<{id:string, text:string, swapped:boolean}>}
 */
export function presetRowsNeedingHomeLayer(profilePatchText) {
  const { blocks } = splitTopLevelBlocks(profilePatchText);
  const out = [];
  for (const block of blocks) {
    const first = block.lines[0] ?? "";
    const idMatch = PRESET_ROW.exec(first);
    if (idMatch === null) continue;
    if (block.text === undefined) block.text = block.lines.join(String.fromCharCode(10));
    if (block.text.includes("dsh-gokifu-compact/engine")) continue; // 已经是引擎，无需登记
    const swapped = swapCompactionMember(block.lines);
    if (swapped === null) continue; // 没有 compaction-basic 成员
    out.push({ id: idMatch[1], text: swapped.join(String.fromCharCode(10)), swapped: true });
  }
  return out;
}

/** 在一条 preset 块内把 compaction-basic 换成 gokifu-compact/engine（找不到返回 null）。 */
export function swapCompactionMember(lines) {
  const next = [...lines];
  let swapped = false;
  for (let i = 0; i < next.length - 1; i += 1) {
    const idLine = COMPACTION_ID_LINE.exec(next[i]);
    const nameLine = COMPACTION_NAME_LINE.exec(next[i + 1]);
    if (idLine === null || nameLine === null) continue;
    next[i] = `${idLine[1]}- id: gokifu-compact`;
    next[i + 1] = `${nameLine[1]}name: 'dsh-gokifu-compact/engine'`;
    swapped = true;
  }
  return swapped ? next : null;
}

/** 去掉 home 层里我们托管的那一段（标记行之后、到文件末尾；我们总是把它放在最后）。 */
export function stripManagedSection(homeText) {
  const text = String(homeText ?? "");
  const at = text.indexOf(MANAGED_MARKER);
  if (at < 0) return text;
  return text.slice(0, at).replace(/\s+$/, "");
}

/**
 * 计算 home 层应有的内容。
 * @param {string} profilePatchText 用户层 patch 原文
 * @param {string} homePatchText 现有 home 层 patch 原文（可空）
 * @returns {{needed:boolean, next:string, ids:string[]}}
 */
export function planHomePatch(profilePatchText, homePatchText) {
  const rows = presetRowsNeedingHomeLayer(profilePatchText);
  const base = stripManagedSection(homePatchText);
  if (rows.length === 0) {
    return { needed: false, next: homePatchText ?? "", ids: [] };
  }
  const LF = String.fromCharCode(10);
  const section = [MANAGED_MARKER, ...rows.map((row) => row.text)].join(LF);
  // 空列表 `[]` 后面不能直接跟 `- id:`（会变成「一个 [] 元素 + 一个对象」，不是合法 entry list）。
  // 文件为空或只有 `[]` 时，整份写成我们的 section（它本身就是合法的 YAML entry list）。
  const baseIsEmptyList = base.trim() === "" || base.trim() === "[]";
  const next = baseIsEmptyList ? section + LF : base + LF + LF + section + LF;
  return { needed: next !== (homePatchText ?? ""), next, ids: rows.map((row) => row.id) };
}


/**
 * 真正写盘：备份 → 写临时文件 → 原子替换。返回写入结果（不抛异常，退出钩子里必须静默）。
 * @param {{home:string, profile?:string, now?:number}} options
 */
export function healHomePatch({ home, profile = "desktop", now = Date.now() } = {}) {
  try {
    if (typeof home !== "string" || home === "") return { wrote: false, reason: "no-home" };
    const profilePatch = nodePath.join(home, "profiles", profile, "cordis.patch.yml");
    const homePatch = nodePath.join(home, "cordis.patch.yml");
    if (!nodeFs.existsSync(profilePatch)) return { wrote: false, reason: "no-profile-patch" };
    const profileText = nodeFs.readFileSync(profilePatch, "utf8");
    const homeText = nodeFs.existsSync(homePatch) ? nodeFs.readFileSync(homePatch, "utf8") : "";
    const plan = planHomePatch(profileText, homeText);
    if (!plan.needed) return { wrote: false, reason: "nothing-to-do", ids: plan.ids };
    if (homeText.trim() !== "") {
      try {
        nodeFs.copyFileSync(homePatch, `${homePatch}.bak-before-gokifu-${now}`);
      } catch {
        /* 备份失败不阻断（写入本身是幂等的：托管段可重算） */
      }
    }
    const temp = `${homePatch}.tmp-gokifu-${process.pid}`;
    nodeFs.writeFileSync(temp, plan.next, "utf8");
    nodeFs.renameSync(temp, homePatch);
    return { wrote: true, ids: plan.ids, path: homePatch };
  } catch (error) {
    return { wrote: false, reason: String(error?.message ?? error) };
  }
}
