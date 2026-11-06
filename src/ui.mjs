/**
 * ui.mjs —— 「上下文压缩」详情页的 host 半（HTTP 路由 + 状态/配置读写）
 *
 * 为什么需要 host 半：引擎挂在 **agent preset 的 compaction group（isolate realm）** 里，
 * 浏览器页面摸不到它；而配置又写在 preset 的 `cordis.patch.yml`（磁盘文件）。
 * 所以页面只做 UI，数据由这里通过 `ctx.webServer` 的具名路由提供：
 *
 *   POST /gokifu/api  {action:"state"|"models"|"defaults"|"save"|"health"|"update", patch?, profile?, refresh?}
 *
 * 设计约束（都是实机踩出来的）：
 *   · 只走 webServer 具名路由，不用 Typert —— Typert 的 remote-client 是 DSH 构建期生成的，
 *     第三方插件拿不到那条流水线；`register({kind, path, handler})` 是公开的、够用。
 *   · 写配置**必须**走文本级块替换（`src/rooms/preset-format.mjs` 的 renderEngineBlock），
 *     因为 preset 里那一块前后都有别的行；用 YAML 库整份重写会丢注释与顺序。
 *   · 保存后必须重启才生效（插件在 boot 时读 preset），所以返回值带 `restartRequired`。
 *
 * 安全（2026-10-30 实装，WS-UIAUDIT A1/A2）：
 *   · **CSRF**：DSH 的 webServer 不做任何 Origin 校验（`asar/webserver.js` 全文无 origin 字样），
 *     路由 handler 自己负责。这里对每个 POST 校验三件事：
 *       ① Host 必须是回环地址（防 DNS rebinding）——**fail closed**：绑到 `0.0.0.0` 也不放行，
 *          非回环 Host 只有出现在 `DSH_GOKIFU_ALLOWED_HOSTS`（逗号分隔）里才通过
 *          （「绑 0.0.0.0」只表示监听所有网卡，不等于「信任任意域名解析到本机」）
 *       ② 带 Origin 时必须是同源（协议+主机+端口与 Host 一致）
 *       ③ 带 Sec-Fetch-Site 时只允许 same-origin / none（**same-site 也不行**：
 *          127.0.0.1:19401 → 127.0.0.1:19400 的跨站简单请求实测就是 `same-site`）
 *     再要求 `content-type: application/json` —— 表单与 `text/plain` 都进不来。
 *   · **真实调用方核对**（不是凭猜）：唯一的浏览器调用方是 `lib/client.js` 的
 *     `fetch("/gokifu/api", {method:"POST", headers:{"content-type":"application/json"}})`。
 *     本机 Chromium 实测（`tmp/dsh-gokifu-compact/ws-csrf/browser-origin-probe.mjs`）：
 *     同源 POST 必带 `origin: http://127.0.0.1:<port>` + `sec-fetch-site: same-origin`；
 *     跨站 `text/plain` 简单请求带 `origin: <攻击者源>` + `sec-fetch-site: same-site`。
 *     ⇒ 浏览器永远不会「不带 Origin」发 POST，所以**缺 Origin 只可能是非浏览器本机调用**
 *     （curl / node / 测试），策略是「允许，但只允许打回环 Host」。
 *   · **备份**：每次 save 的 `.bak-before-ui-<ts>` 轮转到最多 {@link BACKUP_KEEP} 份；
 *     preset 里一旦出现密钥样式（键名以 key/secret/token/password/credential 结尾，
 *     或值形如 `sk-…` / PEM 私钥），**不生成明文备份**，返回 `backupSkipped` 说明原因。
 *
 * 配置正确性（2026-10-30 实装，WS-UIAUDIT B4/B5/B6）：
 *   · **B4 不许撒谎**：`state.config` 与 `save.effectiveConfig` 给的是**引擎生效值**
 *     （缺失键补默认、非法值按 `engine.mjs` 规则净化、`retainRatio ≥ thresholdRatio` 那条修正也照做），
 *     文件里实际写了什么另走 `presetConfig`；每键来源在 `configOrigins`（preset/default/sanitized/adjusted），
 *     没写的键在 `unconfiguredKeys`。
 *   · **B5 空串不是 0**：数字字段收到 `""`/空白/`null` → 400「…不能为空」；
 *     非十进制字面量（`0x10`/`1e3`/`true`）→ 400「必须是数字」；越界 → 400「超出范围」。
 *     错误信息一律用中文字段名（{@link FIELD_LABELS}）。
 *   · **B6 不静默丢**：`save` 带白名单外的键 → **不写任何东西**，400 且响应体带 `skipped` 列表。
 *
 * 性能（2026-10-30 实装，P4）：
 *   · 首屏 `state` 原本对 133 个 `graph.json`（33MB）**全量 parse**，实测 342~400ms。
 *     现按 `(绝对路径, mtimeMs, size)` 缓存「聚合摘要」（只存 foldMarks / 计数，不存整图）；
 *     同一次请求里 `latest` 与 `today` 共用一次目录扫描；热路径 = 一次 readdir + N 次 stat。
 *   · 失效规则：mtime 或 size 任一变化即重读；坏图缓存「坏」；会话目录消失时清对应缓存。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
// ★ A2-1（2026-10-30）：preset 块格式的唯一定义在 R13 的 preset-format 子房间（src/rooms/）。
//   旧写法 import "../scripts/install.mjs" 是本仓库唯一的反向依赖（R-A 红点）。
import { countResolvedFailures, isTruncatedFinish } from "./rooms/kifu-model.mjs";
import { readProfileBundles, readTextOrNull } from "./rooms/profile-io.mjs";
import { repoVersion, repoBuildId, processIsAlive } from "./rooms/build-stamp.mjs";
import { parseEngineBlock, renderEngineBlock, ENTRY_ID, PKG_NAME } from "./rooms/preset-format.mjs";
// ★ T62：补 import。`recentFoldP90` / `closeoutTimeoutAdvice` 由 closeout-plan 导出，
//   `engine.mjs` 一直正确 import，这里漏了 ⇒ dryRun 的 backfill 路径会 ReferenceError。
//   此前没被测出来，是因为守卫写的是 `t.includes(src, "closeoutTimeoutAdvice(")`（字符串匹配），
//   缺 import 也照样绿 —— 这类「只看字面量」的守卫正是它能活下来的原因。
import { closeoutTimeoutAdvice, recentFoldP90 } from "./rooms/closeout-plan.mjs";
// ★ A2-4（2026-10-30）：默认值/中文名/净化规则全部来自 R15（config-schema），页面不再各留一份。
import { configDefaults, fieldLabels, describeConfig as describeConfigFromSchema, validatePatch } from "./rooms/config-schema.mjs";
// ★ C216「补做收尾」：判债务 / 排序限量 / 串行补（取消归档 → resume → 收尾 → 归档回去）都在 R17 房间里，
//   这里只做接线（取会话清单、拿宿主服务、把引擎的 closeoutNow 递进去）。
import { listDebts, backfillArchivedSessions } from "./rooms/closeout-backfill.mjs";
// 读图必须走 R01 的 store（**会重放 delta** —— 与引擎 / doctor / graph-audit 同口径）。
import { createPersistStore, createFsPort, graphRoot } from "./rooms/kifu-persist.mjs";

/**
 * 本文件所在目录（真实路径）。
 *
 * 为什么不用 `new URL(import.meta.url).pathname`：pathname 是**百分号编码**串
 * （`/<WORKSPACE>/…`），拼出来的路径在磁盘上不存在 ⇒
 * `readFileSync` ENOENT ⇒ `readVersion()` 的 catch 吞成 `null` ⇒ 页面标题渲染成 `v?`
 * （`lib/client.js:197` 的 `v${state?.version ?? "?"}`）。
 * `fileURLToPath` 是 Node 官方解码入口（空格 `%20`、中文、`~` 的 `%7E` 一并还原）。
 */
const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

export const name = "dsh-gokifu-compact/ui";
// ★ U1（2026-11-01）：加 `llm`。主人拍板的架构是「插件不自己存凭据、不自己接外部 API」——
//   用户要在 DSH 里加供应商，页面的摘要模型下拉就从**宿主已注册的模型目录**里自动长出来。
//   实测宿主服务名就是 `"llm"`（`dsh-llm/lib/index.js` 的 `LlmRuntime extends Service` 里 `super(ctx, "llm")`）。
export const inject = ["webServer", "llm"];

import nodeOs from "node:os";
import { healHomePatch, planHomePatch, isTestRuntime } from "./rooms/user-patch.mjs";

/** 与 engine.mjs 的 Config 保持一致的默认值（页面用来显示「默认」）。 */
/** 与 R15（config-schema）保持一致的默认值（页面用来显示「默认」）。 */
export const DEFAULTS = Object.freeze(configDefaults());

/** T68：自动归档补折是可选的预付功能，默认关；说明随 defaults/state 一并暴露。 */
export const AUTO_ARCHIVE_BACKFILL_CONFIG = Object.freeze({
  key: "autoArchiveBackfill",
  type: "boolean",
  default: false,
  label: "自动归档补折",
  desc: "自动为已归档会话补做离线折叠；默认关闭。打开后会按既有调度调用摘要模型并产生费用（T68：504 个会话 / 1158 段，真实使用 0 次，已花 $11.0546）；设为 true 打开，设为 false 关闭。实时折叠与当前会话归档收尾不受影响；手工补：node scripts/archive-fold.mjs --session <id> --write",
});
export const CONFIG_ITEMS = Object.freeze([AUTO_ARCHIVE_BACKFILL_CONFIG]);

function uiDefaults() {
  return { ...DEFAULTS, autoArchiveBackfill: AUTO_ARCHIVE_BACKFILL_CONFIG.default };
}

function resolveHome() {
  return process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "DeepSeek Harness", "home");
}

/** 读 profile 的 `dsh.profile.bundles[]`；任何异常都当成「没有」（发现函数不许抛）。 */

/** 读文本；不存在 / 不是文件 / 读失败 ⇒ null（发现函数不许抛）。 */

/**
 * 找 preset 文件，**两代兼容**（W4，2026-11-01）。
 *
 * 为什么不能只读 `<$DSH_HOME>/preset-bundles`：新版 DSH（0.2.1-rc.5）**已经没有这个目录**
 * （全 asar grep `preset-bundles` = 0 命中）。新一代的用户 preset 是一个 **bundle 包**：
 *   `<home>/profiles/<p>/package.json` 的 `dsh.profile.bundles[]` 里有包名，
 *   包根 `cordis.patch.yml` 里写 `- insert: [{id: preset-<id>,
 *   name: '@deepseek-ai/dsh-agent-preset', config: {...}}]`
 * （实机记载见 gokifu-2026-11-01/compat-deploy.md §2.4）。
 *
 * 发现顺序（**新一代命中就不再退回旧目录**；两代都空 ⇒ `[]`，不抛）：
 *   ① 新：`profiles/<p>/package.json` → `dsh.profile.bundles[]` →
 *      `profiles/<p>/node_modules/<bundle>/cordis.patch.yml`；
 *      命中判据：含 `@deepseek-ai/dsh-agent-preset` / 含 `- id: compaction-basic` / 含 {@link PKG_NAME}。
 *   ② 旧：`<home>/preset-bundles/<dir>/cordis.patch.yml`（老 home 唯一形态，判据与行为逐字不变）。
 *   ③ 都没有 ⇒ `[]`（home 不存在 / package.json 坏 / 读文件失败一律当「没有」）。
 *
 * 返回形状固定 `{ name, file, text }`：`name` 新一代是 bundle 包名，旧一代是目录名。
 * 本包自己的 bundle patch（`name === PKG_NAME`）**只有当它真的声明了 preset 时**才算 preset：
 *   1.15.0 起本包的 `cordis.patch.yml` 同时带 UI 行与 preset 行（一个包装上就接管）；
 *   ≤1.14.0 的旧包只有 UI 行 —— 继续排除，否则安装器/doctor 会把自己当成要改的 preset（自指噪音）。
 *
 * ⚠ 同一逻辑在 `scripts/install.mjs` 的 `presetsWithCompaction()` 里**复制了一份**，不是偷懒：
 *   `install.mjs` 会被单独复制进夹具/已装包运行（test/install-link.test.mjs F1 只复制
 *   `scripts/{install,link-path}.mjs` + `src/rooms/preset-format.mjs`），静态 import 本文件会让
 *   那份副本 ESM 解析失败；而 R-A（test/rooms.test.mjs）禁止 `src/**` 反向 import `scripts/`，
 *   也没法反过来共享。⇒ 两份必须**行为一致**，`test/preset-discovery.test.mjs` 有「两处一致」
 *   用例锁着：改这里必须同步改 `scripts/install.mjs`。
 *
 * @param {string} home DSH_HOME
 * @param {string} [profile] profile 名，默认 `desktop`
 * @returns {{name:string,file:string,text:string}[]}
 */
export function findPresetFiles(home = resolveHome(), profile = "desktop") {
  const dshHome = home ?? resolveHome();
  const profileName = profile || "desktop";

  /* ── ① 新一代：profile 的 dsh.profile.bundles → 包的 cordis.patch.yml ── */
  const profileDir = nodePath.join(dshHome, "profiles", profileName);
  const out = [];
  /** 本包自己的 preset 声明（1.15.0+ 才有；单独存着 —— 不许用它遮住旧一代 preset 的发现）。 */
  let ownPreset = null;
  for (const bundle of readProfileBundles(profileDir)) {
    const file = nodePath.join(profileDir, "node_modules", bundle, "cordis.patch.yml");
    const text = readTextOrNull(file);
    if (text === null) continue;
    const declaresPreset = text.includes("@deepseek-ai/dsh-agent-preset");
    if (bundle === PKG_NAME) {
      // 1.15.0+：本包 patch = UI 行 + preset 行（一个包装上就接管）；UI-only 的旧包继续排除（见上方注释）。
      if (declaresPreset && text.includes(ENTRY_ID)) ownPreset = { name: bundle, file, text };
      continue;
    } else if (!declaresPreset && !text.includes("- id: compaction-basic") && !text.includes(PKG_NAME)) continue;
    out.push({ name: bundle, file, text });
  }
  // 关键：只有本包自己命中时**不许提前返回** —— 旧 home 的 preset 在 preset-bundles/ 里，
  // 提前返回会让安装器/doctor 找不到真正要改的 preset（C5 幂等用例就是踩这个）。
  if (out.length > 0) return ownPreset === null ? out : [...out, ownPreset];

  /* ── ② 旧一代：<home>/preset-bundles/<dir>/cordis.patch.yml（原行为） ── */
  const root = nodePath.join(dshHome, "preset-bundles");
  if (!nodeFs.existsSync(root)) return ownPreset === null ? [] : [ownPreset];
  try {
    for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = nodePath.join(root, entry.name, "cordis.patch.yml");
      const text = readTextOrNull(file);
      if (text === null) continue;
      if (text.includes(PKG_NAME) || text.includes("- id: compaction-basic")) out.push({ name: entry.name, file, text });
    }
  } catch {
    return ownPreset === null ? [] : [ownPreset];
  }
  return ownPreset === null ? out : [...out, ownPreset];
}

/* ─────────────────── 棋谱扫描/解析缓存（P4：首屏 state 性能） ───────────────────
 *
 * 现场（perf task-26）：live 132~133 个 graph.json / 33MB，首屏 state 一次要把它们**全部** parse 一遍
 * （todayAggregate），耗时 342~400ms，分解为 existsSync 76.5 + readFile 160.3 + JSON.parse 20.3 + 聚合 2.7。
 * 但 state 只在页面打开/保存后调用，绝大多数文件自上次调用以来根本没变 ⇒ 按 (path, mtimeMs, size) 缓存
 * 「解析后真正被用到的字段」，热路径只剩一次目录扫描 + 133 次 stat。
 *
 * 三条纪律：
 *   · 缓存值**只存聚合用得到的字段**（foldMarks / 计数），不存整张图 —— 133 张图全留会占上百 MB。
 *   · 坏图（JSON.parse 失败）也缓存"坏"这个事实，否则一个坏文件会每次被重新读一遍。
 *   · 同一个请求里 latestGraph 与 todayAggregate **共用一次扫描**（否则 readdir+stat 要跑两遍）。
 */
const GRAPH_CACHE = new Map();
// ★ C282：基础上限 256，并改成**真正的 LRU 淘汰**（满了只逐条淘汰，绝不 clear 雪崩）。
// ★ 面板大工作集修正：256 小于真机 925 个会话时，顺序扫描会循环淘汰 —— 每次打开仍全量重读。
//   因此完整扫描的缓存下限必须覆盖本次 files；小扫描仍用 256，不预设一个永远不够大的硬编码总数。
const GRAPH_CACHE_MAX = 256;

function graphCacheCapacity(scan) {
  const files = Array.isArray(scan?.files) ? scan.files.length : 0;
  return Math.max(GRAPH_CACHE_MAX, files);
}

/**
 * 把 key 放到队尾（= 最近使用），并在超限时淘汰队首（= 最久未用）。
 * 抽成纯函数是为了能单独测：缓存策略错了不会报错，只会**悄悄变慢**。
 */
export function lruSet(map, key, value, max = GRAPH_CACHE_MAX) {
  map.delete(key); // 先删再插 ⇒ 插入序 = 最近使用序
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
  return map;
}

/** 目录扫描：{root, files:[{dir,file,mtimeMs,size}]}（不读文件内容）。 */
export function collectGraphFiles(home = resolveHome()) {
  const root = nodePath.join(home, "chess-context", "sessions");
  const files = [];
  let entries;
  try {
    entries = nodeFs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { root, files };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "graph.json");
    // throwIfNoEntry:false 比 existsSync+statSync 少一次系统调用（这条在 133 个会话上是真金白银）
    const stat = nodeFs.statSync(file, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    files.push({ dir: entry.name, file, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return { root, files };
}

/**
 * ★ C232：数出「已修正的失败」—— 同一条 `action` 后来又跑通的失败边。
 * 与 `scripts/doctor.mjs` 的「热清单抗干扰」同一条判据（那边数全部会话，这里数单个会话）。
 * 没有任何副作用；坏图返回 0（面板不许因为一张坏图整页坏掉）。
 */
// ★ C300：实现搬到 `rooms/kifu-model.mjs`（doctor 与面板共用一份），这里只再导出，保持对外 API 不变。
export { countResolvedFailures };

/**
 * ★ C260：补账的**在途闸门**（模块级）。同一进程同一时刻只允许一次真补账。
 * 用对象包一层，测试可以读/重置，不需要额外导出整套状态。
 */
export const BACKFILL_GATE = { inFlight: false };

/** ★ C416：欠账清单短缓存（10 秒），避免干跑与真补连着扫两遍。 */
const LIST_DEBTS_CACHE = new Map();

/** 每个文件的聚合摘要缓存（key = 绝对路径 + mtimeMs + size）。 */
function graphSummary(entry, cacheMax = GRAPH_CACHE_MAX) {
  const cached = GRAPH_CACHE.get(entry.file);
  if (cached !== undefined && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) {
    // 小扫描保留原始调用；只有大工作集需要显式容量（C282 的静态接线守卫也锁定这一分支）。
    if (cacheMax === GRAPH_CACHE_MAX) lruSet(GRAPH_CACHE, entry.file, cached);
    else lruSet(GRAPH_CACHE, entry.file, cached, cacheMax);
    return cached;
  }
  let summary = null;
  try {
    const g = JSON.parse(nodeFs.readFileSync(entry.file, "utf8"));
    summary = {
      foldMarks: g.foldMarks ?? [],
      foldCount: g.foldCount ?? 0,
      lastFoldTotalTokens: g.lastFoldTotalTokens ?? 0,
      checkpointSeq: g.checkpointSeq ?? null,
      lastFoldUsage: g.lastFoldUsage ?? null,
      failures: Object.values(g.edges ?? {}).filter((edge) => edge?.result === "failure").length,
      // ★ C232：**已修正的失败**（同一条 action 后来又跑通了）—— 与 doctor 的「抗干扰度」同口径。
      //   面板上直接可见，用户不用跑 doctor 就知道 LEARNED 里有多少行是"自己已经修好"的。
      resolvedFailures: countResolvedFailures(g),
      nodes: Object.keys(g.nodes ?? {}).length,
      edges: Object.keys(g.edges ?? {}).length,
    };
  } catch {
    summary = null; // 坏图：缓存「坏」这个事实，别每次重读
  }
  const row = { mtimeMs: entry.mtimeMs, size: entry.size, summary };
  lruSet(GRAPH_CACHE, entry.file, row, cacheMax);
  return row;
}

/** 丢掉已消失会话的缓存条目（只清当前 root 下的，别的 home 不动）。 */
function pruneGraphCache(root, files) {
  const alive = new Set(files.map((f) => f.file));
  const prefix = root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`;
  for (const key of GRAPH_CACHE.keys()) {
    if (key.startsWith(prefix) && !alive.has(key)) GRAPH_CACHE.delete(key);
  }
}

/** 最近活跃的棋谱（按 graph.json mtime）。 */
export function latestGraphFrom(scan) {
  const cacheMax = graphCacheCapacity(scan);
  const best = scan.files.reduce((acc, file) => (acc === null || file.mtimeMs > acc.mtimeMs ? file : acc), null);
  if (best === null) return null;
  const summary = graphSummary(best, cacheMax).summary;
  if (summary === null) return null;
  return {
    session: best.dir,
    updatedAt: best.mtimeMs,
    foldCount: summary.foldCount,
    totalAfter: summary.lastFoldTotalTokens,
    checkpointSeq: summary.checkpointSeq,
    lastFold: summary.foldMarks.length > 0 ? summary.foldMarks[summary.foldMarks.length - 1] : null,
    lastUsage: summary.lastFoldUsage,
    failures: summary.failures,
    resolvedFailures: summary.resolvedFailures ?? 0,
    nodes: summary.nodes,
    edges: summary.edges,
  };
}

/** 折痕列表只暴露最近 20 条，与图本身的折痕保留上限一致。 */
export const FOLD_LIST_LIMIT = 20;

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 页面折痕的字段白名单。保留原始 lastFold 契约不动，列表走 state.foldMarks。
 * usage 也只给页面实际渲染的三个 token 数，不透出摘要正文、路由等无关字段。
 */
export function foldMarksForUi(foldMarks) {
  const marks = Array.isArray(foldMarks) ? foldMarks : [];
  return marks.slice(-FOLD_LIST_LIMIT).reverse().map((mark) => {
    const rawUsage = mark?.usage;
    const usage = rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? {
          inputTokens: finiteNumberOrNull(rawUsage.inputTokens),
          outputTokens: finiteNumberOrNull(rawUsage.outputTokens),
          totalTokens: finiteNumberOrNull(rawUsage.totalTokens),
        }
      : null;
    return {
      at: finiteNumberOrNull(mark?.at) ?? (typeof mark?.at === "string" && mark.at !== "" ? mark.at : null),
      seqStart: finiteNumberOrNull(mark?.seqStart),
      seqEnd: finiteNumberOrNull(mark?.seqEnd),
      trigger: typeof mark?.trigger === "string" && mark.trigger !== "" ? mark.trigger : null,
      summaryChars: finiteNumberOrNull(mark?.summaryChars),
      usage,
      truncated: typeof mark?.truncated === "boolean" ? mark.truncated : null,
      finishReason: typeof mark?.finishReason === "string" && mark.finishReason !== "" ? mark.finishReason : null,
    };
  });
}

/** 全局最近折痕：跨会话按 foldMark.at 排序，最近 20 条在前；坏图跳过，真空才返回 []。 */
export function latestFoldMarksFrom(scan) {
  const files = Array.isArray(scan?.files) ? scan.files : [];
  const cacheMax = graphCacheCapacity(scan);
  const all = [];
  for (const file of files) {
    const summary = graphSummary(file, cacheMax).summary;
    if (summary === null) continue;
    // 每个会话只取它自己的最近 20 条：全局前 20 不可能落在某个会话的第 21 条之后。
    all.push(...foldMarksForUi(summary.foldMarks));
  }
  const epoch = (mark) => {
    const at = mark?.at;
    if (typeof at === "number" && Number.isFinite(at)) return at;
    if (typeof at === "string" && at !== "") {
      const parsed = Date.parse(at);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  };
  return all
    .map((mark, index) => ({ mark, index, at: epoch(mark) }))
    .sort((left, right) => {
      // 没有合法时刻的旧记录仍保留，但排在有时刻的记录之后；原始相对顺序作为稳定次序。
      if (left.at === null && right.at !== null) return 1;
      if (left.at !== null && right.at === null) return -1;
      if (left.at !== right.at) return right.at - left.at;
      return left.index - right.index;
    })
    .slice(0, FOLD_LIST_LIMIT)
    .map(({ mark }) => mark);
}

/** 今天的 fold 汇总（按 foldMarks.at，不按文件 mtime）。 */
/**
 * ★ C239：折叠成本的**估算**（美元）。价目来自 DeepSeek 官方页（2026-11-02 抓取，deepseek-flash，低峰）：
 *   命中 $0.003 / 未命中 $0.15 / 输出 $0.6（每 1M tokens）。价目会变 ⇒ 这里只给"量级"，页面必须写「估算」。
 * 判据（本机实测）：fold 的输入几乎不命中（3.4%），输出只占 3.7% —— 所以估算主要看未命中的输入。
 * @param {{inputTokens?:number, cacheReadTokens?:number, outputTokens?:number}} usage
 * @returns {number|null} 美元；没有 usage ⇒ null（页面显示 —，不许编 0）
 */
/**
 * ★ C271：价目**只在这里写一次**（美元 / 每 1M tokens），并注明出处与口径。
 * 官方有两档（高峰/低峰），这里用**低峰**（便宜的那档）⇒ 估算是**下限**，不是上限。
 * 依据：docs/knowledge/成本模型-deepseek价格.md（`test/ui-update` C271 会比对两者的数字，漂了就红）。
 */
export const PRICE_USD_PER_MTOK = Object.freeze({
  miss: 0.15, // 输入 cache miss（低峰）
  hit: 0.003, // 输入 cache hit（低峰）—— 比 miss 便宜 50 倍
  out: 0.6, // 输出（低峰）
});

/**
 * ★ C345：**官方是两个模型、两种价**（2026-11-03 抓 <https://api-docs.deepseek.com/quick_start/pricing>）：
 *
 * | 每 1M token（低峰） | deepseek-flash | deepseek-v4-pro |
 * |---|---|---|
 * | 输入 cache hit | $0.003 | $0.022 |
 * | 输入 cache miss | $0.15 | $0.66 |
 * | 输出 | $0.6 | $1.98 |
 *
 * 差别是 **3.3×–4.4×**。此前 `estimateFoldCostUsd` 一律按 flash 算 ——
 * 如果用户跑的是 pro，面板上的"今日折叠成本"会**低报 4 倍多**。
 * 低报比不报更糟：它让人以为很便宜。
 */
/**
 * ★ C452：**峰谷两档价**（官方原文："Off-peak rates are half of the peak rates"）。
 *
 * 我们表里（C271/C345）用的都是**低峰价** ⇒ 估算是**下限**。而高峰时段换算到北京时间恰好是
 * **工作日 09:00–12:00 与 14:00–18:00**（UTC 01–04 / 06–10）—— 正是大家真正在干活的时候。
 * 也就是说：白天算出来的成本可能**低报一倍**。这一行把它说清楚，并给一个能判定的函数。
 */
export const PEAK_MULTIPLIER = 2;

/**
 * 现在（或指定时刻）是不是**高峰时段**。官方口径：UTC 周一~周五 01:00–04:00 与 06:00–10:00。
 *
 * **已知近似**：官方还要排除"中国法定节假日"（原文："excluding Chinese public holidays"），
 * 我们离线没有节假日表 ⇒ 节假日会被算成高峰（**只会高估，不会低估**，方向上是安全的）。
 *
 * @param {Date|number|string} [at]
 * @returns {boolean}
 */
export function isPeakUtc(at) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  if (Number.isNaN(d.getTime())) return false;
  const weekday = d.getUTCDay(); // 0=周日, 6=周六
  if (weekday === 0 || weekday === 6) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export const MODEL_PRICES_USD_PER_MTOK = Object.freeze({
  "deepseek-flash": PRICE_USD_PER_MTOK,
  "deepseek-v4-pro": Object.freeze({ miss: 0.66, hit: 0.022, out: 1.98 }),
});

/**
 * 按模型名挑单价。认不出的名字一律回落到 flash（= 下限估算），并在调用方标注"按 flash 估"。
 * @param {string} [model]
 * @returns {{miss:number, hit:number, out:number, matched:boolean}}
 */
export function priceForModel(model, { at = null } = {}) {
  const key = String(model ?? "").trim().toLowerCase();
  const base = key.includes("pro") ? MODEL_PRICES_USD_PER_MTOK["deepseek-v4-pro"] : PRICE_USD_PER_MTOK;
  const matched = key.includes("pro") || key.includes("flash");
  // ★ C452：峰时价 = 低谷价 × 2（官方原文）。
  //   **不传 `at` = 按低谷算（下限），而不是按"现在"** —— 否则同一份 usage 的结果会在一天里翻倍，
  //   历史数字、单测、落盘文档全都会跟着漂（这是比"少算"更糟的一类问题）。
  //   要看高峰价必须**显式**传时刻，调用方自己决定。
  const peak = at === null || at === undefined ? false : isPeakUtc(at);
  const k = peak ? PEAK_MULTIPLIER : 1;
  return { miss: base.miss * k, hit: base.hit * k, out: base.out * k, matched, peak };
}

export function estimateFoldCostUsd(usage, model = usage?.model, { at = null } = {}) {
  const input = Number(usage?.inputTokens);
  if (!Number.isFinite(input) || input < 0) return null;
  const hit = Math.max(0, Number(usage?.cacheReadTokens) || 0);
  const output = Math.max(0, Number(usage?.outputTokens) || 0);
  // ★ C361：**`inputTokens` 到底是"全部输入"还是"未命中输入"？** 真机数据给了答案：
  //   会话文件里一条真实 usage 是 `{inputTokens:2158, outputTokens:257, totalTokens:21999, cacheReadTokens:19584}`，
  //   且 2158 + 19584 + 257 = 21999 ⇒ **inputTokens 只算未命中部分**（miss），total 才是三者之和。
  //   旧实现按"input 含 hit"算（miss = input - hit）⇒ 命中一多 miss 就被算成 0，**成本被严重低估**。
  //   这里用 totalTokens 自证：若 total ≈ miss + hit + out，就按"input 即 miss"；否则退回老口径。
  const total = Number(usage?.totalTokens);
  const looksSplit = Number.isFinite(total) && total > 0 && Math.abs(total - (input + hit + output)) <= 2;
  const miss = looksSplit ? input : Math.max(0, input - hit);
  const hitTokens = looksSplit ? hit : Math.min(input, hit);
  const p = priceForModel(model, { at });
  return (miss * p.miss + hitTokens * p.hit + output * p.out) / 1e6;
}

export function todayAggregateFrom(scan) {
  const cacheMax = graphCacheCapacity(scan);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let folds = 0;
  let shadowed = 0;
  let costUsd = 0;
  let costKnown = 0;
  let peakFolds = 0;
  const sessions = new Set();
  let totalSessions = 0;
  let totalFailures = 0;
  let truncated = 0;
  // ★ C609：**「不知道」必须和「没截断」分开数**。旧口径下两者都落在 0 上 ⇒ 仪器静默失灵时面板看起来完全正常。
  let truncatedUnknown = 0;
  // ★ C610：**「输入被裁」单独一个数**，不与上面的输出截断相加。
  //   为什么必须分开：`truncated` 答的是「模型**写没写完**」，`inputTruncated` 答的是「模型**看没看全**」。
  //   真机 526 条 foldMark 里 238 条是 `truncated:false` 而输入侧裁过（假「没截断」，审计见
  //   `scripts/input-truncation-audit.mjs`）—— 混成一个数就再也分不出是"输出短了"还是"输入少了"。
  //   只数**有证据裁过**（`=== true`）；`false` 与缺失（旧记录）都不数。
  let inputTruncated = 0;
  for (const file of scan.files) {
    totalSessions += 1;
    const summary = graphSummary(file, cacheMax).summary;
    if (summary === null) continue;
    const marks = summary.foldMarks.filter((mark) => (mark.at ?? 0) >= from);
    if (marks.length > 0) {
      folds += marks.length;
      sessions.add(file.dir);
      shadowed += marks.reduce((sum, mark) => sum + (mark.shadowedTokens ?? 0), 0);
      for (const mark of marks) {
        // ★ C453：**按这次折叠发生的时刻计价**。C452 把峰谷两档补上了，但如果这里不传时刻，
        //   每一次折叠都会被按低谷价算 —— 白天干活时面板就系统性**低报一倍**。
        //   `foldMark.at` 本来就有，只是以前没人用它定价。
        const cost = estimateFoldCostUsd(mark?.usage, mark?.usage?.model, { at: mark?.at ?? null });
        if (cost !== null) {
          costUsd += cost;
          costKnown += 1;
          // 顺便记一下"今天有几笔是按高峰价算的" —— 让面板能标出来，不然用户没法解释这个数为什么比昨天高
          if (mark?.at !== null && mark?.at !== undefined && isPeakUtc(mark.at)) peakFolds += 1;
        }
      }
    }
    totalFailures += summary.failures;
    // ★ C390：今日**被截断**的折叠数（finishReason = max-tokens/length 类）。
    //   C317–C321 把这个字段装好了，但面板一直没用它 ⇒ 用户看不到"摘要被截断"这件事。
    // ★ C609：**离线补折不写 `finishReason`** —— 它的写入点（`applyOfflineFoldToGraph`）手上只有
    //   「我们判没判它没写完」这个结论（落 `truncated`）；上游 finish 在那个点上**根本取不到**
    //   （`runOfflineFold` 的 chunk 只带 usage/model，没带 finish）。所以只读 `finishReason`
    //   ⇒ 现在的主来路（真机 283/462 条 foldMark 是离线补折）被截断了也看不见。
    //   两个字段**语义不同、永不互相写入**，这里只做"或"，任何一种证据都不漏：
    //     · `finishReason` 是字符串 ⇒ 知道上游怎么结束的（max-tokens/length = 被截断）；
    //     · `truncated === true`     ⇒ 我们的判定是"没写完"；
    //     · `truncated === false`    ⇒ 我们的判定是"写完了"（有证据的"没截断"，不是"不知道"）；
    //     · 两个字段都没有（旧记录 / 该写入点没采集）⇒ **不知道**，单独计数，别混进前两档。
    for (const mark of marks) {
      if (isTruncatedFinish(mark?.finishReason) || mark?.truncated === true) truncated += 1;
      else if (mark?.truncated !== false && typeof mark?.finishReason !== "string") truncatedUnknown += 1;
      // ★ C610：输入侧裁切独立计数（绝不并进 `truncated`）
      if (mark?.inputTruncated === true) inputTruncated += 1;
    }
  }
  // ★ C239：`costUsd` 是**估算**（官方价目 × 真实 usage）；`costKnown` 是有 usage 的 fold 数，供页面标注覆盖率。
  // ★ C609：`truncatedUnknown` 只能**追加在最后**（C390 的接口契约：旧字段顺序不动，新字段必须是数字）。
  return {
    folds,
    shadowed,
    sessions: sessions.size,
    totalSessions,
    totalFailures,
    costUsd,
    costKnown,
    truncated,
    peakFolds,
    truncatedUnknown,
    // ★ C610：今日**输入侧被裁**的折叠数（事件没放进去 / 单条正文被切）。与 `truncated` 语义不同，永不合并。
    inputTruncated,
  };
}

/** 一次扫描 + 清缓存，给同一个请求里的两个聚合用。 */
function scanGraphs(home = resolveHome()) {
  const scan = collectGraphFiles(home);
  pruneGraphCache(scan.root, scan.files);
  return scan;
}

/** 兼容旧调用点（单独调用 = 自己扫一次）。 */
function latestGraph(home = resolveHome()) {
  return latestGraphFrom(scanGraphs(home));
}

/** 兼容旧调用点（单独调用 = 自己扫一次）。 */
function todayAggregate(home = resolveHome()) {
  return todayAggregateFrom(scanGraphs(home));
}

/**
 * 从请求体里取 profile 名（W-D）。只允许安全字符（挡住 `../` 之类的路径穿越）；
 * 缺省 / 非法一律回落 `desktop` —— **保持向后兼容**（老的调用方根本不带这个字段）。
 */
function profileFromRequest(body) {
  const raw = typeof body?.profile === "string" ? body.profile.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) ? raw : "desktop";
}

/**
 * 安装/单实例/摘要模型 三项体检（比 test/doctor.mjs 轻，够页面用）。
 *
 * ★ W-D（2026-11-01）：profile 名以前在这里写死成 `desktop` —— 非默认 profile 的实例
 *   （真实测试实例的 profile 叫 `web`）明明装好并进了 `dsh.profile.bundles`，自检却报
 *   `installed:false, notInBundles:true`。而「装了没反应」排障第一眼看的就是这个接口，
 *   它说假话的代价很高。现在与 {@link findPresetFiles} 同一个口径：查 `profiles/<profile>/`。
 *   返回体带 `profile`，一眼能看出读的是哪个 profile。
 *
 * @param {string} home DSH_HOME
 * @param {{name:string,file:string,text:string}[]} presets 已发现的 preset（调用方必须用**同一个** profile 发现）
 * @param {string} [profile] profile 名（默认 desktop；空/非法回落 desktop）
 */
function health(home = resolveHome(), presets = findPresetFiles(home), profile = "desktop") {
  const profileName = profile || "desktop";
  const profileDir = nodePath.join(home, "profiles", profileName);
  // mounted 的判据（1.16 起改口径）：
  //   · 旧架构（≤1.15.x）：靠「preset 声明里出现本引擎行」证明挂上了；
  //   · 新架构（1.16+）：**不需要 preset 文件** —— 压缩后端由 bundle patch 里
  //     `- id: preset-{standard,ptc,minimal,cordis}` 四行整体覆盖直接换掉（见 scripts/make-presets-override.mjs）。
  //     此时若还按 preset 判，明明装好了，页面 pill 仍然写「未接管」⇒ 直接说假话。
  //   ⇒ 两个通道任一成立即算挂载：本包进了 profile 的 `dsh.profile.bundles`（UI 行会启动、patch 会合并），
  //     或仍存在挂了本引擎的 preset 声明（兼容 1.15.x 的 home）。
  // singleInstance：**在这份声明里**没有 compaction-basic（作用域是 preset 内部，不是全局）。
  const withOurs = presets.filter((p) => p.text.includes(ENTRY_ID));
  const withNative = withOurs.filter((p) => /^\s*- id: compaction-basic\s*$/m.test(p.text));
  const profilePkgFile = nodePath.join(profileDir, "package.json");
  let profileOk = false;
  let inBundles = false;
  if (nodeFs.existsSync(profilePkgFile)) {
    try {
      const pkg = JSON.parse(nodeFs.readFileSync(profilePkgFile, "utf8"));
      profileOk = Boolean(pkg.dependencies?.[PKG_NAME]) || nodeFs.existsSync(nodePath.join(profileDir, "node_modules", PKG_NAME));
      inBundles = (pkg.dsh?.profile?.bundles ?? []).includes(PKG_NAME);
    } catch {
      /* profile/package.json 读不出/坏 JSON ⇒ 保持 false（health 是自检，不许抛） */
    }
  }
  return {
    profile: profileName,
    installed: profileOk,
    mounted: inBundles || withOurs.length > 0,
    singleInstance: withNative.length === 0,
    notInBundles: !inBundles,
    presets: presets.map((p) => ({ name: p.name, file: p.file })),
  };
}

/* ───────────────────── 模型目录（U1）：只读宿主，不存凭据 ───────────────────── */

/**
 * 单次宿主调用的时间上限（毫秒）。
 *
 * 为什么要它：不是所有适配器都本地查表 —— `dsh-llm-deepseek` 的 `listModels()` 是
 * `discoverModels?.(provider) ?? []`（发现钩子可能走网络），`resolveModel()` 还要先 `connection()`。
 * 这台机器的组合树里 `llm-deepseek-api-key` / `llm-deepseek-account` 都在（见组合树实测），
 * 所以「首屏等一个网络发现」是真会发生的。**页面宁可少一个下拉项，也不许卡住首屏。**
 */
const CATALOG_CALL_TIMEOUT_MS = 4000;

/**
 * 给一个 promise 套时间上限；超时按「拿不到」处理（调用方的 catch 会接住）。
 * @param {Promise<any>} promise
 * @param {number} [ms] 上限（毫秒）
 * @param {string} [reason] 超时错误文本（默认沿用换模型目录那条；版本检查传自己的）
 */
async function withinBudget(promise, ms = CATALOG_CALL_TIMEOUT_MS, reason = "catalog call timed out") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        // ⚠ 不许 unref：这个 timer 就是「保证一定会 settle」的那一半。
        //   unref 掉之后，如果宿主调用恰好不产生任何句柄（真实卡死就是这种），
        //   事件循环会先空转退出 ⇒ await 永远不返回（实测：test 里报 unsettled top-level await）。
        timer = setTimeout(() => reject(new Error(reason)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 单个模型的**真实**上下文窗口。
 *
 * 为什么不能从 `listModels()` 直接读：宿主 `LlmRuntime.listModels(provider)` 的返回项实测只有
 * `{ provider, id, name, description?, inputModalities? }` —— **没有窗口字段**。
 * 窗口只出现在 `resolveModelInfo(provider, model)` 的 `context.contextWindow` 里
 * （宿主对它做 `Number.isInteger(w) && w > 0` 校验，非法直接抛 `INVALID_MODEL_CONTEXT`）。
 * 所以这里逐模型再问一次。
 *
 * 拿不到（没这方法 / 抛错 / 超时 / 字段缺失 / 非法）一律返回 `null` —— **绝不伪造数字**：
 * 页面拿 null 就显示 `—`，写死一个 1000000 会把进度条画成假的。
 */
async function contextWindowOf(llm, provider, modelId, timeBudgetMs) {
  try {
    if (typeof llm?.resolveModelInfo !== "function") return null;
    const info = await withinBudget(llm.resolveModelInfo(provider, modelId), timeBudgetMs);
    const window = info?.context?.contextWindow;
    return Number.isInteger(window) && window > 0 ? window : null;
  } catch {
    return null;
  }
}

/**
 * 读宿主已注册的模型目录，聚合成页面下拉要用的稳定形状。
 *
 * 契约（U2 的 `lib/client.js` 靠它衔接，改动要同步）：
 * ```js
 * { providers: [ { provider, name, models: [ { id, name, contextWindow: number|null } ] } ] }
 * ```
 * 不稳定/失败的形态**一律降级**，本函数永不抛：
 *   · 没有 llm 服务 / `listProviders()` 抛错 ⇒ `{ providers: [] }`
 *   · 某个 provider 的 `listModels()` 抛错 ⇒ 只跳过它，其它照常
 *   · 模型项缺 `id` 或 `name` ⇒ 丢弃（不产出半截项）
 * 排序：provider 按 id、模型按 name（同名再按 id），保证同一目录每次输出一致（页面快照可测）。
 *
 * 时间预算：每次宿主调用（listProviders / listModels / resolveModelInfo）都有上限（默认 4 s），
 * 超时按「拿不到」处理 —— 适配器的模型发现可能走网络，首屏不许被它拖住。
 *
 * @param {any} llm 宿主 llm 服务（`LlmRuntime`）；测试可注入假对象
 * @param {{timeBudgetMs?:number}} [options] 单次宿主调用的时间上限（毫秒；测试可调小）
 * @returns {Promise<{providers:{provider:string,name:string,models:{id:string,name:string,contextWindow:number|null}[]}[]}>}
 */
export async function modelCatalog(llm, options = {}) {
  const empty = { providers: [] };
  // 单次宿主调用的时间预算（见 withinBudget 的注释）；测试可传更小的值
  const budget = Number.isFinite(options.timeBudgetMs) && options.timeBudgetMs > 0 ? options.timeBudgetMs : CATALOG_CALL_TIMEOUT_MS;
  // 测试与降级路径都会走到这里（fake ctx 可能根本没有 llm）
  if (llm === null || typeof llm !== "object") return empty;
  let routes;
  try {
    if (typeof llm.listProviders !== "function") return empty;
    routes = await withinBudget(llm.listProviders(), budget);
  } catch {
    return empty; // ③ 连 provider 都列不出来 ⇒ 空目录，绝不抛
  }
  if (!Array.isArray(routes)) return empty;

  const providers = [];
  for (const route of routes) {
    // 实测返回形状是 `[{ id, name }]`（宿主 registration 里的 provider 就是 {id,name}）。
    // 顺手容忍纯字符串（将来若改成 id 列表，也不至于整页空白）——但对象缺 id 就跳过。
    const providerId = typeof route === "string" ? route : typeof route?.id === "string" ? route.id : null;
    if (providerId === null || providerId.length === 0) continue;
    const displayName = typeof route?.name === "string" && route.name.length > 0 ? route.name : providerId;
    let listed;
    try {
      if (typeof llm.listModels !== "function") continue;
      listed = await withinBudget(llm.listModels(providerId), budget);
    } catch {
      continue; // ② 单个 provider 失败 ⇒ 只跳过它
    }
    if (!Array.isArray(listed)) continue;
    // ④ 缺 id / name 的畸形项直接过滤掉（半截项比没有更糟：页面会渲染出一个选不了的 option）
    const usable = listed.filter(
      (model) => typeof model?.id === "string" && model.id.length > 0 && typeof model?.name === "string" && model.name.length > 0,
    );
    // 逐模型取窗口：并发问，单个失败只让那一项变 null（⑤）
    const models = await Promise.all(
      usable.map(async (model) => ({
        id: model.id,
        name: model.name,
        contextWindow: await contextWindowOf(llm, providerId, model.id, budget),
      })),
    );
    models.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
    providers.push({ provider: providerId, name: displayName, models });
  }
  providers.sort((a, b) => a.provider.localeCompare(b.provider, "en"));
  return { providers };
}

/* ───────────────────── 版本检查（U5）：只读 registry，绝不安装 ───────────────────── */

/**
 * 「检查更新」的唯一定义 —— `action:"update"`（点「重新检查」）与 `state.update`（首屏读缓存）共用这一份。
 *
 * **为什么必须只读**：升级要改 `profiles/<profile>/package.json`（`dsh plugin --profile … add`），
 * 装完还得重载宿主才会用上新版本。那是人的动作；这里只负责说清「现在是不是新版本、升级命令长什么样」，
 * 一个字节都不写、一个子进程都不起、也不碰 `node_modules`。
 *
 * 契约（`lib/client.js` 与 `test/ui-update.test.mjs` 靠它衔接，改字段要同步）：
 * ```js
 * { ok:true, current, latest, publishedAt, hasUpdate, command, error, cachedAt }
 * ```
 * 失败**不抛**：`ok:true, latest:null, hasUpdate:false, error:"<原因>"`。
 * registry 不可达是常态（离线 / 公司网 / 上游故障），页面只该显示「检查失败」+ 原因，
 * 不许整页坏掉，更不该让首屏等它。
 */
export const UPDATE_CACHE_MS = 10 * 60 * 1000;

/**
 * 失败快照只留 60 秒（成功留 {@link UPDATE_CACHE_MS}）。
 * 为什么两种 TTL：registry 抖一下不该让那一行 10 分钟都写着「检查失败」；
 * 但也不能每次开页都重打一个已经挂掉的域名（离线时那就是每次开页卡 5 秒）。
 */
const UPDATE_FAILURE_CACHE_MS = 60 * 1000;

/** registry 请求上限（毫秒）—— 外层 `withinBudget` 与 `AbortSignal.timeout` 用同一个数。 */
const UPDATE_TIMEOUT_MS = 5000;

/** 包文档（packument）：`dist-tags.latest` 是 registry 的权威「最新版」，`time[版本]` 是它的发布时间。 */
const REGISTRY_PACKUMENT_URL = `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}`;

/**
 * 内存缓存：**键 = profile**。
 * 为什么键里必须带 profile：命令里嵌着 `--profile <name>`，串了就会把 A 机器的升级命令贴给 B。
 */
const UPDATE_CACHE = new Map();

/** 正在飞的请求（同一个 profile 共用；见 {@link checkUpdate} 里的单飞说明）。 */
const UPDATE_INFLIGHT = new Map();

/**
 * 解析 `1.2.3` / `v1.2.3` / `1.2.3-rc.1+build.7`。解析不了 ⇒ `null`（**不猜**）。
 * @param {any} text
 * @returns {{major:number, minor:number, patch:number, prerelease:string}|null}
 */
export function parseVersion(text) {
  const raw = String(text ?? "").trim().replace(/^v/i, "");
  const matched = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (matched === null) return null;
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    prerelease: matched[4] ?? "",
  };
}

/** semver §11：预发布标识逐段比，数字段按数值比且优先级低于字母段。 */
function comparePrerelease(left, right) {
  const a = left.split(".");
  const b = right.split(".");
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNumber = /^\d+$/.test(a[index]) ? Number(a[index]) : null;
    const bNumber = /^\d+$/.test(b[index]) ? Number(b[index]) : null;
    if (aNumber !== null && bNumber !== null) {
      if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1;
      continue;
    }
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * 语义化比较：`-1` / `0` / `1`；任一版本解析不了一律 `null`（调用方按「不判断」处理）。
 *
 * **不许用字符串比较**：字典序里 `"0.8.9" > "0.8.10"`、`"1.9.0" > "1.10.0"`，
 * 版本语义上恰好相反 —— 用字符串比会稳定地告诉用户「有新版本」而实际没有（或反过来）。
 * @param {any} left
 * @param {any} right
 * @returns {-1|0|1|null}
 */
/**
 * ★ C394：告诉人「为什么没有更新」。`hasUpdate:false` 有三种完全不同的原因：
 * 已经是最新、**本地比 registry 还新**（自己装的未发布版本）、根本没查到。
 * 不区分的话，用户会以为"我已经是最新了"。
 * @param {string|null} current 本地版本
 * @param {string|null} latest registry 版本
 * @returns {"ahead"|"behind"|"same"|null}
 */
export function versionRelation(current, latest) {
  if (typeof current !== "string" || current === "" || typeof latest !== "string" || latest === "") return null;
  const cmp = compareVersions(latest, current);
  if (cmp === 1) return "behind";
  if (cmp === -1) return "ahead";
  return "same";
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  // 正式版 > 任何预发布（1.18.0 > 1.18.0-rc.1）
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** 升级命令：profile 用请求里的那个，版本用 registry 给的 latest（拿不到就 `@latest`，npm 自己解析）。 */
function updateCommand(latest, profile) {
  return `dsh plugin --profile ${profile} add ${PKG_NAME}@${latest || "latest"}`;
}

/**
 * 网络/响应异常 → 一句能显示在面板上的中文原因（**不抛**，也不回显整段 HTML）。
 * 特意把 `error.cause.code`（`ECONNREFUSED` / `ENOTFOUND`）带出来：排障第一眼看的就是它。
 */
function describeUpdateError(error) {
  const message = String(error?.message ?? error).trim() || "未知错误";
  const cause = String(error?.cause?.code ?? error?.cause?.message ?? "").trim();
  const combined = cause === "" || message.includes(cause) ? message : `${message}（${cause}）`;
  const truncated = combined.length > 160 ? `${combined.slice(0, 160)}…` : combined;
  const timedOut =
    error?.name === "TimeoutError" || error?.name === "AbortError" || /timed out|timeout|超时/i.test(message);
  if (timedOut) return message.startsWith("请求 registry") ? message : `请求 registry 超时（${UPDATE_TIMEOUT_MS}ms）`;
  return truncated;
}

/**
 * 问 registry 要最新版与它的发布时间。**只读一个 GET**，不下载 tarball、不校验、不安装。
 * `dist-tags.latest` 缺失时容忍裸 manifest 形态（`/latest` 端点也长这样），两者都没有 ⇒ 抛（由调用方转成 error）。
 */
async function fetchRegistryLatest(fetchImpl) {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(UPDATE_TIMEOUT_MS)
      : undefined;
  const response = await fetchImpl(REGISTRY_PACKUMENT_URL, { signal, headers: { accept: "application/json" } });
  if (response === null || response === undefined || typeof response.ok !== "boolean") {
    throw new Error("registry 返回了非 HTTP 响应");
  }
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  const body = await response.json();
  const latest = String(body?.["dist-tags"]?.latest ?? body?.version ?? "").trim();
  if (latest === "") throw new Error("registry 返回里没有 latest 版本号");
  const stamp = body?.time?.[latest];
  const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return { latest, publishedAt: Number.isNaN(at) ? null : new Date(at).toISOString() };
}

/**
 * 只读缓存快照（`state.update` 用）：**绝不发网络**，没有缓存/已过期 ⇒ `null`。
 * 首屏因此永远只是「本地读一个 Map」—— registry 慢或挂掉都不会拖住页面打开。
 * @param {string} [profile]
 */
export function cachedUpdate(profile = "desktop") {
  const entry = UPDATE_CACHE.get(String(profile));
  if (entry === undefined) return null;
  const ttl = entry.value.error ? UPDATE_FAILURE_CACHE_MS : UPDATE_CACHE_MS;
  if (Date.now() - entry.at >= ttl) return null;
  return { ...entry.value, cachedAt: new Date(entry.at).toISOString() };
}

/**
 * 检查有没有新版本（**只读**；10 分钟内存缓存，`refresh` 强制绕过）。
 *
 * 永不抛：连「宿主没有 fetch」都转成 `error`。返回体的 `ok` 恒为 `true` ——
 * 对页面来说「检查不到」是一种**正常结果**，不是请求失败。
 *
 * @param {{profile?:string, refresh?:boolean, current?:any, fetch?:Function, timeoutMs?:number}} [options]
 * @returns {Promise<{ok:true, current:any, latest:string|null, publishedAt:string|null, hasUpdate:boolean, command:string, error:string|null, cachedAt:string}>}
 */
export async function checkUpdate(options = {}) {
  const profile = typeof options.profile === "string" && options.profile.trim() !== "" ? options.profile.trim() : "desktop";
  const refresh = options.refresh === true;
  const current = options.current === undefined ? readVersion() : options.current;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : UPDATE_TIMEOUT_MS;
  const fetchImpl =
    typeof options.fetch === "function"
      ? options.fetch
      : typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null;
  if (!refresh) {
    const cached = cachedUpdate(profile);
    if (cached !== null) return cached;
  }
  // 单飞（single-flight）：同一个 profile 的并发请求共用一次网络。
  // 为什么需要：React 开发态会把 effect 跑两遍、用户也会连点「重新检查」——
  // 没有这一层，2 次点击就是 2 个 registry 请求（缓存只在**完成之后**才生效）。
  const pending = UPDATE_INFLIGHT.get(profile);
  if (pending !== undefined) return pending;
  const task = (async () => {
    const value = {
      ok: true,
      current,
      latest: null,
      publishedAt: null,
      hasUpdate: false,
      relation: null,
      // 兜底：**不知道**最新版时给 `@latest`（由 npm 解析）。知道「不新」时会清空（见下面的赋值）。
      command: updateCommand(null, profile),
      error: null,
    };
    try {
      if (fetchImpl === null) throw new Error("宿主没有可用的 fetch");
      const info = await withinBudget(fetchRegistryLatest(fetchImpl), timeoutMs, `请求 registry 超时（${timeoutMs}ms）`);
      value.latest = info.latest;
      value.publishedAt = info.publishedAt;
      value.hasUpdate = compareVersions(info.latest, current) === 1;
      // ★ C394：同时告诉人比较结果（behind/same/ahead）—— `hasUpdate:false` 不等于"已是最新"。
      value.relation = versionRelation(current, info.latest);
      // ★ 只有**真的有新版**才给命令：本地比 registry 新（自己装的是未发布版本）时给 `@<latest>` 等于教人降级。
      value.command = value.hasUpdate ? updateCommand(info.latest, profile) : "";
    } catch (error) {
      value.error = describeUpdateError(error);
    }
    const at = Date.now();
    UPDATE_CACHE.set(profile, { at, value: { ...value } });
    return { ...value, cachedAt: new Date(at).toISOString() };
  })();
  UPDATE_INFLIGHT.set(profile, task);
  try {
    return await task;
  } finally {
    UPDATE_INFLIGHT.delete(profile);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON: ${String(error?.message ?? error)}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 1);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/* ───────────────────────── 请求可信度（CSRF 防护） ───────────────────────── */

/** 每个 preset 最多保留几份 `.bak-before-ui-*`（轮转上限）。 */
export const BACKUP_KEEP = 5;
/** 备份文件名标记（保持旧命名，旧备份会被同一轮转逻辑收编）。 */
export const BACKUP_MARK = ".bak-before-ui-";

/** 键名以这些词结尾 ⇒ 视为密钥载体（注意 `headroomTokens` 之类复数不会被误判）。 */
const SECRET_KEY_RE = /(key|secret|password|passwd|credential|token)$/i;
/** 值层面的密钥样式（常见 token 前缀 + PEM 私钥头）。 */
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpsr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** 去掉 IPv6 的方括号并转小写，便于比较 Host 与 Origin。 */
function normalizeHostname(value) {
  return String(value ?? "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

/** 补零到 4 位（IPv6 分组比较用）。 */
const pad16 = (part) => (part === "" ? "0" : part.padStart(4, "0"));

/**
 * 把主机名归一到可比较的形式：大小写不敏感 + IPv6 展开成 8 组定长。
 * `[::1]` 与 `[0:0:0:0:0:0:0:1]` 必须被当成同一台机器，否则 Host/Origin 比对会误判成跨源。
 * （只处理字面量，不做 DNS；内嵌 IPv4 的 `::ffff:1.2.3.4` 形式不展开，够用即可。）
 */
export function canonicalHostname(value) {
  const h = normalizeHostname(value);
  if (!h.includes(":")) return h;
  const [headText, tailText] = h.split("::");
  const head = headText === "" ? [] : headText.split(":");
  if (tailText === undefined) return head.map(pad16).join(":");
  const tail = tailText === "" ? [] : tailText.split(":");
  const zeros = Math.max(0, 8 - head.length - tail.length);
  return [...head, ...new Array(zeros).fill("0"), ...tail].map(pad16).join(":");
}

/** `::1` 的规范形（回环 IPv6）。 */
const LOOPBACK_V6 = canonicalHostname("::1");

/** `host:port` / `[::1]:port` → { hostname, port }；缺端口按 http 的 80 算。非法返回 null。 */
export function parseAuthority(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (m === null) return null;
  const hostname = canonicalHostname(m[1]);
  if (hostname === "") return null;
  const port = m[2] === undefined ? "80" : String(Number(m[2]));
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  return { hostname, port };
}

/**
 * 回环主机名（含 localhost 子域、IPv4 127/8、IPv6 ::1 的各种写法）。
 * 注意：`[::1]`、`[0:0:0:0:0:0:0:1]`、`[::0:1]` 经 {@link canonicalHostname} 都归一到同一串。
 */
export function isLoopbackHostname(hostname) {
  const h = canonicalHostname(hostname);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === LOOPBACK_V6) return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

/** content-type 必须是 application/json（允许带 charset 等参数）。 */
export function isJsonContentType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return false;
  return /^application\/json\s*(;|$)/i.test(raw.trim());
}

/**
 * 判断一个 POST 是否来自可信调用方。
 *
 * 顺序：Host（防 rebinding）→ Sec-Fetch-Site（浏览器自报跨站直接拒）→ Origin（同源比对）。
 * 返回 `{ ok, status?, reason?, mode }`；`mode` 用于区分「浏览器同源」与「本机无 Origin 调用」。
 *
 * ⚠ **fail closed**（task-34）：服务器绑到 `0.0.0.0` 时**不会**因此放行任何 Host ——
 *   非回环 Host 只有在 `allowedHosts`（`DSH_GOKIFU_ALLOWED_HOSTS`）里显式列过才通过。
 *   否则「绑 0.0.0.0」就等于「任何域名只要解析到本机就能打这个写配置接口」（DNS rebinding）。
 *
 * @param {{headers?: Record<string, unknown>}} req
 * @param {{allowedHosts?: string[], boundAllInterfaces?: boolean}} [options]
 */
export function checkRequestTrust(req, options = {}) {
  const headers = req?.headers ?? {};
  const hostRaw = headers.host;
  const host = parseAuthority(hostRaw);
  if (host === null) return { ok: false, status: 403, reason: "缺少或非法的 Host 头", mode: "bad-host" };

  const allowedHosts = (options.allowedHosts ?? []).map(canonicalHostname);
  const explicitlyAllowed = allowedHosts.includes(host.hostname);
  const loopback = isLoopbackHostname(host.hostname);
  if (!loopback && !explicitlyAllowed) {
    const hint = options.boundAllInterfaces === true
      ? `服务器绑在 0.0.0.0 也不无条件放行：要放行请显式设 DSH_GOKIFU_ALLOWED_HOSTS=${host.hostname}`
      : "需要时设 DSH_GOKIFU_ALLOWED_HOSTS";
    return { ok: false, status: 403, reason: `拒绝非本机 Host：${host.hostname}（防 DNS rebinding；${hint}）`, mode: "untrusted-host" };
  }

  const site = Array.isArray(headers["sec-fetch-site"]) ? headers["sec-fetch-site"][0] : headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { ok: false, status: 403, reason: `拒绝跨站请求（sec-fetch-site: ${site}）`, mode: "cross-site" };
  }

  const originRaw = headers.origin;
  if (originRaw === undefined) {
    // 浏览器对 POST 必带 Origin（本机 Chromium 实测见文件头注释）⇒ 走到这里的是本机工具。
    return { ok: true, mode: "local-no-origin" };
  }
  const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
  if (typeof origin !== "string" || origin === "" || origin === "null") {
    return { ok: false, status: 403, reason: `拒绝非法 Origin：${String(origin)}`, mode: "bad-origin" };
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, status: 403, reason: `非法 Origin：${origin}`, mode: "bad-origin" };
  }
  const originPort = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : String(Number(parsed.port));
  const originHost = canonicalHostname(parsed.hostname);
  if (explicitlyAllowed) {
    // 运营者显式放行的主机（DSH_GOKIFU_ALLOWED_HOSTS）：只比主机名 ——
    // 因为这种部署通常是「本机 http 被反代/隧道包成 https」，端口与协议在插件这侧看不到真值。
    if (originHost !== host.hostname) {
      return { ok: false, status: 403, reason: `跨源请求被拒（origin=${origin}，host=${String(hostRaw)}）`, mode: "cross-origin" };
    }
    return { ok: true, mode: "allowlisted-host" };
  }
  // DSH 的 webServer 是纯 node:http（无 TLS），所以默认路径只接受 http 同源。
  if (parsed.protocol !== "http:") {
    return { ok: false, status: 403, reason: `只接受 http 同源调用，收到 ${parsed.protocol}`, mode: "bad-origin" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, status: 403, reason: "Origin 不得带凭据", mode: "bad-origin" };
  }
  if (originHost !== host.hostname || originPort !== host.port) {
    return { ok: false, status: 403, reason: `跨源请求被拒（origin=${origin}，host=${String(hostRaw)}）`, mode: "cross-origin" };
  }
  return { ok: true, mode: "same-origin" };
}

/**
 * 找出一段 YAML 文本里的密钥样式内容。
 * **只返回键名，不回传值** —— 这个结果会进 HTTP 响应，值绝不能外泄。
 *
 * @param {string} text
 * @returns {string[]} 命中的键名（值层面的命中记为 `<value-pattern>`）
 */
export function findSecretLike(text) {
  const hits = [];
  const src = String(text ?? "");
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    if (!SECRET_KEY_RE.test(m[1])) continue;
    const value = m[2].replace(/\s+#.*$/, "").trim();
    if (value === "" || value === "''" || value === '""' || value === "null" || value === "~") continue;
    hits.push(m[1]);
  }
  if (SECRET_VALUE_RE.test(src)) hits.push("<value-pattern>");
  return hits;
}

/** 列出某 preset 的备份（按时间戳升序）。 */
export function listBackups(presetFile) {
  const dir = nodePath.dirname(presetFile);
  const prefix = `${nodePath.basename(presetFile)}${BACKUP_MARK}`;
  let names;
  try {
    names = nodeFs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(prefix)).sort().map((n) => nodePath.join(dir, n));
}

/** 只保留最近 `keep` 份备份，返回被删掉的文件名。 */
export function pruneBackups(presetFile, keep = BACKUP_KEEP) {
  const backups = listBackups(presetFile);
  const removed = [];
  while (backups.length > keep) {
    const file = backups.shift();
    try {
      nodeFs.rmSync(file);
      removed.push(nodePath.basename(file));
    } catch {
      /* 删不掉就留着，下一次再试 */
    }
  }
  return removed;
}

/**
 * 中文键名 —— 错误信息里必须出现用户认得的名字，而不是 `tier2After` 这种配置键。
 * 与 `lib/client.js` 的 `FIELDS[].label` 保持一致（host 侧不能 import 浏览器半，只能各留一份；
 * `test/ui-config.test.mjs` 有一致性断言钉住这两份）。
 */
/**
 * 中文键名 —— 错误信息里必须出现用户认得的名字，而不是 `tier2After` 这种配置键。
 * 与 `lib/client.js` 的 `FIELDS[].label` 保持一致（host 侧不能 import 浏览器半，只能各留一份；
 * `test/ui-config.test.mjs` 有一致性断言钉住这两份）。
 */
export const FIELD_LABELS = Object.freeze(fieldLabels());
function uiFieldLabels() {
  return { ...FIELD_LABELS, [AUTO_ARCHIVE_BACKFILL_CONFIG.key]: AUTO_ARCHIVE_BACKFILL_CONFIG.label };
}
/**
 * 把 preset 里「实际写了什么」翻译成「引擎实际生效什么」。
 *
 * 为什么需要它（WS-UIAUDIT B4）：真实 preset 只有 14 个键，而引擎会给缺失键补默认值
 * （`engine.mjs` 的 `Config` 默认 + `resolveChess()` 兜底）。页面按「文件里有没有」渲染，
 * 就会把生效中的 `hotLedgerReplace: true` 显示成未勾选 —— 页面在撒谎。
 * 这里按引擎的规则算出生效值，并逐键标注来源（preset / default / sanitized / adjusted）。
 *
 * ⚠ 这是 `src/engine.mjs`（`Config` 默认值 + `resolveChess()`）的**镜像**，不是真实调用：
 *    ui.mjs 不能 import engine.mjs（那会拉起 dsh-compaction/llm 等 peer 依赖）。
 *    `test/ui-config.test.mjs` 有一条静态断言逐键比对 `DEFAULTS` 与 engine.mjs 的 schema 默认值，
 *    规则若有变动（例如再出现 4096/2048/8192 那种三处不一致）必须同步这里与那条测试。
 *
 * @param {Record<string, unknown>} presetConfig 从 preset 文本解析出来的原始键值
 * @returns {{effective: Record<string, unknown>, origins: Record<string, string>, unconfiguredKeys: string[]}}
 */
/**
 * 「preset 里写了什么 → 引擎实际生效什么」+ 逐键来源（default / preset / sanitized / adjusted）。
 * ★ A2-4：实现已搬到 R15（`config-schema.describeConfig`）—— 这里只保留导出名与返回形状，
 *   避免页面与引擎各算一套（那正是 `hotLedgerReplace` 显示成未勾选的起因）。
 */
function describeSchemaConfig(presetConfig) {
  return describeConfigFromSchema(presetConfig);
}

export function describeConfig(presetConfig = {}) {
  const described = describeSchemaConfig(presetConfig);
  const key = AUTO_ARCHIVE_BACKFILL_CONFIG.key;
  const raw = presetConfig?.[key];
  const valid = typeof raw === "boolean";
  const unconfiguredKeys = [...described.unconfiguredKeys];
  if (raw === undefined) unconfiguredKeys.push(key);
  unconfiguredKeys.sort();
  return {
    effective: { ...described.effective, [key]: valid ? raw : AUTO_ARCHIVE_BACKFILL_CONFIG.default },
    origins: { ...described.origins, [key]: raw === undefined ? "default" : valid ? "preset" : "sanitized" },
    unconfiguredKeys,
  };
}
/**
 * 校验并规整页面提交的 patch。
 *
 * 两条硬规则（WS-UIAUDIT B5/B6）：
 *   · 数字字段：空串 / 空白 / null **不是 0** —— 直接报错，绝不静默写成 0（`Number("")===0` 的坑）。
 *     非十进制字面量（`0x10`、`1e3`、`true`）也拒。
 *   · 白名单外的键**不静默丢**：这里仍然只是收集到 `skipped`（纯函数好测），
 *     真正「不许静默」由 `saveConfig`（默认 strictKeys）与路由的 400 保证。
 */
/**
 * 校验并规整页面提交的 patch。
 *
 * 两条硬规则（WS-UIAUDIT B5/B6）：
 *   · 数字字段：空串 / 空白 / null **不是 0** —— 直接报错，绝不静默写成 0（`Number("")===0` 的坑）。
 *     非十进制字面量（`0x10`、`1e3`、`true`）也拒。
 *   · 白名单外的键**不静默丢**：收集到 `skipped`（纯函数好测），真正「不许静默」由 `saveConfig`
 *     与路由的 400 保证。
 *
 * ★ A2-4：规则与中文文案已搬到 R15（`config-schema.validatePatch`），这里只保留导出名与返回形状。
 */
function sanitizeSchemaPatch(patch) {
  return validatePatch(patch);
}

export function sanitizePatch(patch) {
  const key = AUTO_ARCHIVE_BACKFILL_CONFIG.key;
  if (!Object.prototype.hasOwnProperty.call(Object(patch), key)) return sanitizeSchemaPatch(patch);
  const rest = { ...(patch ?? {}) };
  const raw = rest[key];
  delete rest[key];
  const result = sanitizeSchemaPatch(rest);
  let value;
  if (typeof raw === "boolean") value = raw;
  else if (raw === "true" || raw === "false") value = raw === "true";
  else throw new Error(`${AUTO_ARCHIVE_BACKFILL_CONFIG.label} 必须是 true / false（收到 ${JSON.stringify(raw)}）`);
  return { patch: { ...result.patch, [key]: value }, skipped: result.skipped };
}
/**
 * 把 patch 写进 preset（带轮转备份；含密钥时不落明文备份）；返回改动清单 + 生效值。
 *
 * `strictKeys`（默认开） = WS-UIAUDIT B6 的修法：白名单外的键**不许静默丢弃**。
 * 抛出的错误对象上挂 `.skipped`，路由据此回 400 并把键名带回给页面 ——
 * 这样「提交了不支持的键」在现有页面（`client.js` 只渲染 `error` 文本）里也一定看得见。
 * 只有显式传 `{strictKeys:false}` 才退回旧行为（保留给离线批处理，仓库内无调用方）。
 */
export function saveConfig(patch, options = {}) {
  const home = options.home ?? resolveHome();
  const { patch: clean, skipped } = sanitizePatch(patch);
  if (skipped.length > 0 && options.strictKeys !== false) {
    const error = new Error(`不支持的配置键：${skipped.join("、")}（只有 ${Object.keys(DEFAULTS).length} 个已知键可以通过页面写入，这些键一个都没写）`);
    error.skipped = skipped;
    throw error;
  }
  for (const key of Object.keys(clean)) {
    // ★ T62：`label` 在本文件从未定义。这里要打印的是**键名**（不是值），直接用 `key` 即可。
    if (SECRET_KEY_RE.test(key)) throw new Error(`含密钥的键不允许通过页面写入：${key}`);
  }
  const presets = findPresetFiles(home).filter((p) => p.text.includes(ENTRY_ID));
  if (presets.length === 0) throw new Error(`没有找到含 ${ENTRY_ID} 的 preset（先跑 install）`);
  const changed = [];
  const pruned = [];
  let backup = null;
  let backupSkipped = null;
  let lastConfig = null;
  for (const preset of presets) {
    const parsed = parseEngineBlock(preset.text);
    if (parsed === null) continue;
    const next = { ...parsed.config, ...clean };
    lastConfig = next;
    const block = renderEngineBlock(next, parsed.indent, parsed.commentLines);
    const text = preset.text.replace(parsed.raw, block);
    if (text === preset.text) continue;
    // 密钥面：源文件里已有密钥样式 ⇒ 不复制整份文件（否则每个备份都是明文副本）。
    // 新块里出现源文件没有的密钥样式 ⇒ 直接拒绝写（防止页面把密钥带进来）。
    const secretInSource = findSecretLike(preset.text);
    const secretInNew = findSecretLike(block).filter((key) => !secretInSource.includes(key));
    if (secretInNew.length > 0) {
      throw new Error(`拒绝写入疑似密钥（${secretInNew.join("、")}）：密钥不得进 preset，也不得进备份`);
    }
    if (secretInSource.length > 0) {
      backupSkipped = {
        file: preset.file,
        keys: [...new Set(secretInSource)],
        reason: "preset 含疑似密钥，已跳过明文备份（旧备份也不会被这份密钥覆盖）",
      };
    } else {
      // 同一毫秒内多次保存（或一次保存命中多个 preset）时也不能互相覆盖。
      const stamp = `${Date.now()}`;
      let candidate = `${preset.file}${BACKUP_MARK}${stamp}`;
      let n = 1;
      while (nodeFs.existsSync(candidate)) {
        n += 1;
        candidate = `${preset.file}${BACKUP_MARK}${stamp}-${n}`;
      }
      backup = candidate;
      nodeFs.copyFileSync(preset.file, backup);
      pruned.push(...pruneBackups(preset.file, options.backupKeep ?? BACKUP_KEEP));
    }
    nodeFs.writeFileSync(preset.file, text, "utf8");
    changed.push(preset.file);
  }
  const described = describeConfig(lastConfig ?? {});
  return {
    changed,
    skipped,
    backup,
    backupSkipped,
    prunedBackups: pruned,
    restartRequired: changed.length > 0,
    // 写完之后「引擎会拿到的生效值」（关闭缺口 B4：页面据此显示真实生效值，而不是文件里有没有）
    effectiveConfig: described.effective,
    configOrigins: described.origins,
    unconfiguredKeys: described.unconfiguredKeys,
  };
}

/**
 * 1.17.1：用户层 patch 遮蔽引擎时，自动在**进程退出时**把 preset 行登记到机器级
 * `$DSH_HOME/cordis.patch.yml`（宿主最后应用的一层，profile 层盖不掉它）。
 *
 * 为什么放在退出时：home 层是**启动装配时**读取的，运行中写只会触发热重载（本机事故）；
 * 退出时同步写一个小文件，不改运行中的树。下次启动即接管 —— 用户不需要跑任何命令。
 */
let homePatchHealScheduled = false;
function scheduleHomePatchHeal(ctx) {
  if (homePatchHealScheduled) return;
  homePatchHealScheduled = true;
  if (String(process.env.DSH_GOKIFU_NO_HEAL ?? "") === "1") return;
  if (isTestRuntime()) return;
  const home = String(process.env.DSH_HOME ?? "").trim() !== "" ? process.env.DSH_HOME : nodePath.join(nodeOs.homedir(), ".dsh");
  const profile = String(process.env.DSH_PROFILE ?? "desktop");
  // 启动时先算一次：需要的话在日志里说清「下次启动生效」，其余情况完全安静。
  let pending = false;
  try {
    const profilePatch = nodePath.join(home, "profiles", profile, "cordis.patch.yml");
    const homePatch = nodePath.join(home, "cordis.patch.yml");
    const profileText = nodeFs.existsSync(profilePatch) ? nodeFs.readFileSync(profilePatch, "utf8") : "";
    const homeText = nodeFs.existsSync(homePatch) ? nodeFs.readFileSync(homePatch, "utf8") : "";
    const plan = planHomePatch(profileText, homeText);
    pending = plan.needed;
    if (pending) {
      ctx?.logger?.info?.(`[gokifu-compact] 用户层 patch 遮蔽了引擎（${plan.ids.join(", ")}）；已登记，退出后写入机器级 patch，下次启动生效`);
    }
  } catch {
    pending = false;
  }
  process.once("exit", () => {
    const result = healHomePatch({ home, profile });
    if (result.wrote) {
      try {
        process.stderr.write(`[gokifu-compact] 已登记 ${result.ids.join(", ")} 到 ${result.path}（下次启动接管压缩引擎）
`);
      } catch {
        /* 退出钩子里绝不再抛 */
      }
    }
  });
}

/**
 * ★ C372：**路由自愈**。真机事故：插件在 GUI 进程里被热重载/卸载后，
 * `/gokifu/api` 变成 404/405，而没有任何东西会把它装回去。
 * 这里把注册包成**幂等**的 `ensureUiRoute`：已注册就直接返回；
 * 卸载（dispose）后重置标志 ⇒ 下一次探测能重新装上。
 */
let uiRouteRegistered = false;

export function ensureUiRoute(ctx) {
  if (uiRouteRegistered) return false;
  if (!ctx?.webServer || typeof ctx.webServer.register !== "function") return false;
  apply(ctx);
  return true;
}

/**
 * ★ C380：**apply 不允许「半死」**。真机事故：插件在 GUI 进程里初始化失败后，
 * `/gokifu/api` 变成 404/405 —— **面板连「我为什么坏了」都说不出来**。
 * 现在：初始化抛错时，先装一条**兜底路由**，让面板回 500 + 错误摘要（人一看就知道）。
 */
export function apply(ctx) {
  try {
    return applyInner(ctx);
  } catch (error) {
    try {
      registerFallbackRoute(ctx, error);
    } catch {
      /* 兜底都装不上，只能任它去 */
    }
    throw error;
  }
}

/**
 * ★ C380：初始化失败时的兜底路由。纯注册动作，不依赖初始化的任何状态。
 * @param {object} ctx
 * @param {unknown} error
 */
export function registerFallbackRoute(ctx, error) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== "function") return false;
  const detail = String(error?.message ?? error ?? "").slice(0, 300);
  const route = {
    kind: "prefix",
    path: "/gokifu/api",
    handler: async (req, res) => {
      const body = JSON.stringify({ ok: false, error: "面板初始化失败", detail }, null, 2);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
    },
  };
  ctx.effect(() => ctx.webServer.register(route), "gokifu-ui(兜底): /gokifu/api");
  return true;
}

function applyInner(ctx) {
  scheduleHomePatchHeal(ctx);
  // 绑定 0.0.0.0 = 本机之外也能访问。**这不构成放行理由**（task-34）：
  // 非回环 Host 仍然必须出现在 DSH_GOKIFU_ALLOWED_HOSTS 里，否则一律按不可信拒绝（fail closed）。
  // 这里的 boundAllInterfaces 只用于把 403 的文案写得更可操作。
  let boundAllInterfaces = false;
  try {
    boundAllInterfaces = String(ctx?.webServer?.host ?? "") === "0.0.0.0";
  } catch {
    boundAllInterfaces = false;
  }
  const allowedHosts = String(process.env.DSH_GOKIFU_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // ★ U1：`inject: ["webServer","llm"]` ⇒ 真实宿主里 ctx.llm 一定在；
  //   但 test/ui*.test.mjs 的假 ctx 只有 webServer，所以这里必须容忍 undefined。
  //   catalog() 再包一层：modelCatalog 本身已设计成不抛，这里是最后一道「页面不能崩」的保险。
  const llm = ctx?.llm;
  const catalog = async () => {
    try {
      return await modelCatalog(llm);
    } catch {
      return { providers: [] };
    }
  };
  const route = {
    kind: "prefix",
    path: "/gokifu/api",
    handler: async (req, res) => {
      try {
        if (req.method === "OPTIONS") return sendJson(res, 204, {});
        if (req.method !== "POST") return sendJson(res, 405, { error: "只接受 POST" });
        const trust = checkRequestTrust(req, { allowedHosts, boundAllInterfaces });
        if (!trust.ok) return sendJson(res, trust.status ?? 403, { error: trust.reason, code: trust.mode });
        if (!isJsonContentType(req.headers?.["content-type"])) {
          return sendJson(res, 415, { error: "只接受 content-type: application/json", code: "bad-content-type" });
        }
        const body = await readBody(req);
        const action = String(body.action ?? "state");
        // ★ W-D：profile 由请求体可选传入（缺省 desktop，向后兼容）。preset 发现与 health 自检
        //   必须用**同一个** profile，否则非默认 profile 的实例会报「装好了却未装」。
        const profileName = profileFromRequest(body);
        if (action === "state") {
          const home = resolveHome();
          const allPresets = findPresetFiles(home, profileName);
          const presets = allPresets.filter((p) => p.text.includes(ENTRY_ID));
          const parsed = presets.length > 0 ? parseEngineBlock(presets[0].text) : null;
          const presetConfig = parsed?.config ?? {};
          const described = describeConfig(presetConfig);
          // ★ P4：两个聚合共用一次目录扫描；解析结果按 (path, mtime, size) 命中缓存。
          const scan = scanGraphs(home);
          return sendJson(res, 200, {
            ok: true,
            // ★ W-D：带出实际用的 profile，排障时一眼看出读的是哪个（不传 = desktop，旧行为不变）。
            profile: profileName,
            version: readVersion(),
            // ★ U5：**只读缓存**（不发网络）。没有缓存/已过期 ⇒ null，页面自己决定要不要补一次检查。
            //   这样首屏的耗时与 registry 完全无关。
            update: cachedUpdate(profileName),
            // ★ B4：`config` 给的是**引擎生效值**（缺失键补默认、非法值按引擎规则净化）。
            //   页面直接渲染它就不会再把 true/semantic 显示成「未配置/空」。
            config: described.effective,
            // 文件里实际写了哪些键（诊断用；也是「哪些是用户显式设过」的事实来源）
            presetConfig,
            configOrigins: described.origins,
            unconfiguredKeys: described.unconfiguredKeys,
            defaults: uiDefaults(),
            fieldLabels: uiFieldLabels(),
            configItems: CONFIG_ITEMS,
            configFile: presets[0]?.file ?? null,
            latest: latestGraphFrom(scan),
            foldMarks: latestFoldMarksFrom(scan),
            today: todayAggregateFrom(scan),
            health: health(home, allPresets, profileName),
            // ★ U1：首屏一次拿全 —— 摘要模型下拉直接用 state.models，少一个请求。
            //   只**新增**字段：上面所有既有字段语义未动。拿不到就是 { providers: [] }。
            models: await catalog(),
          });
        }
        if (action === "update") {
          // ★ U5「检查更新」：同一个 POST 通道、同一套信任检查与 content-type 门禁（不新开路由）。
          //   失败也是 200 + ok:true + error —— 页面要能显示「检查失败」，而不是把整页打成请求错误。
          //   **这里绝不执行安装/升级**：只拼一条给人执行的命令。
          const refresh = body.refresh === true || body.refresh === 1 || body.refresh === "1" || body.refresh === "true";
          return sendJson(res, 200, await checkUpdate({ profile: profileName, refresh }));
        }
        if (action === "backfill-subagent") {
          // ★ Lead 集成（T76 的客户端/引擎实现已完成，这里补薄分支）：
          //   用户的设计 = 「补折**点一下派个子代理去补折**，可以用免费模型」。
          //   客户端发 `action:"backfill-subagent", summarizationProvider, summarizationModel`，
          //   这里把它接到引擎桥的 `runBackfillWithModel({provider, model})`（一次 startActivation，无定时器）。
          const bridge = (() => {
            try {
              return globalThis[Symbol.for("dsh-gokifu.engine")] ?? null;
            } catch {
              return null;
            }
          })();
          if (bridge === null || typeof bridge.runBackfillWithModel !== "function") {
            return sendJson(res, 503, {
              ok: false,
              code: "engine-missing",
              error: "压缩引擎不在这个进程里（插件未加载，或代码已更新但还没重载宿主）",
            });
          }
          const report = await bridge.runBackfillWithModel({
            provider: body.summarizationProvider,
            model: body.summarizationModel,
          });
          return sendJson(res, 200, report);
        }
        if (action === "backfill") {
          // ★ C260：**同一时刻只允许一次真补账**。
          //   两个标签页（或手抖双击）同时点"开始补账"，会对同一批归档会话**各 resume 一次**
          //   ⇒ 两次收尾折叠、归档状态来回切（`unarchive → resume → archive` 交叠）。
          //   面板按钮只能防单页双击，防不了多页/curl。这里是唯一的集中闸门。
          //   dryRun 不进闸门（它不 resume、不调模型，随便打）。
          const backfillDryRun = body.dryRun === true;
          // ★ C216「补做收尾」：归档那一刻**没压完**的会话，账是欠着的（宿主的压缩只对 idle agent 有效，
          //   归档会话没有 agent）。这条路把它补齐：取消归档 → resume → 收尾折叠 → 原样归档回去。
          //   dryRun:true 只报清单（不 resume、不调模型），面板上先看一眼再动手。
          const bridge = (() => {
            try {
              return globalThis[Symbol.for("dsh-gokifu.engine")] ?? null;
            } catch {
              return null;
            }
          })();
          if (bridge === null || typeof bridge.closeoutNow !== "function") {
            return sendJson(res, 503, {
              ok: false,
              code: "engine-missing",
              error: "压缩引擎不在这个进程里（插件未加载，或代码已更新但还没重载宿主）",
            });
          }
          const home = resolveHome();
          // ★ C577（第二轮复核发现）：这里原来**只看 dshHome**，忽略了用户在设置里自定义的
          //   `chess.graphDir`（引擎侧四处都用 `this.chess.graphDir`）⇒ 一旦用户改过棋谱目录，
          //   面板「补做收尾」就会列 0 条（看着像没欠账，其实扫错了目录）。
          const configuredGraphDir = (() => {
            try {
              return String(bridge?.chess?.graphDir ?? "");
            } catch {
              return "";
            }
          })();
          const root = graphRoot({ graphDir: configuredGraphDir, dshHome: home });
          const minEvents = Number.isFinite(Number(body.minEvents)) ? Number(body.minEvents) : 40;
          const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(20, Number(body.limit))) : 20;
          // ★ C261：**单个会话的硬超时也要能设**（默认 3 分钟 × 5 个 = 15 分钟挂在一个请求上，
          //   任何一侧超时都会让用户以为失败）。夹紧到 [10s, 180s]，外部脚本仍可用默认值。
          const perItemMs = Number.isFinite(Number(body.perItemMs))
            ? Math.max(10_000, Math.min(180_000, Number(body.perItemMs)))
            : undefined;
          const dryRun = body.dryRun === true;
          const sessionIds = (() => {
            try {
              return nodeFs
                .readdirSync(nodePath.join(root, "sessions"), { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
            } catch {
              return []; // 还没有任何棋谱：空清单，不是错误
            }
          })();
          const store = createPersistStore({ port: createFsPort(nodeFs), root });
          // ★ C416：**干跑与真补会连着来两次**，而 `listDebts` 要把 90+ 个图各读一遍（真机单次数秒）。
          //   这里加一个**10 秒内重用**的短缓存（键 = minEvents+limit）：
          //   人点完「检查欠账」立即点「开始补账」时，不用再扫一遍。
          const cacheKey = `${minEvents}:${limit}`;
          const cached = LIST_DEBTS_CACHE.get(cacheKey);
          const listed =
            cached !== undefined && Date.now() - cached.at < 10_000
              ? cached.value
              : (() => {
                  const value = listDebts({
                    sessionIds,
                    minEvents,
                    limit,
                    loadGraph: (id) => store.load({ id, cwd: "" }).graph,
                  });
                  LIST_DEBTS_CACHE.set(cacheKey, { at: Date.now(), value });
                  return value;
                })();

          // ★ C408：**可以指定要补哪几个**。原来只能"按 tail 降序取前 N 个"，
          //   想先试一个小会话验证通道都做不到（只能先碰最大的那个）。
          const wantedIds = Array.isArray(body.sessionIds) ? body.sessionIds.map(String).filter((x) => x !== "") : null;
          const picked = wantedIds === null ? listed.items : listed.items.filter((it) => wantedIds.includes(String(it.sessionId)));
          // ★ C529：自动补账正在补的那些会话，面板这边**跳过**（同一会话两次模型调用 = 白花钱 + 两个写者）
          // ★ C588（审核发现，**面板 dead path**）：这里原来写的是 `bridge0` —— 一个不存在的变量。
          //   只要 `bridge` 存在，这一行就抛 `ReferenceError: bridge0 is not defined`
          //   ⇒ 面板「补账」通道 100% 不可用（真机 `accept-after-restart` 报错复现）。
          //   而守卫测试用的是「源码里含有 isBackfillBusy 就算过」，拼错照样绿 —— 已在测试里改严。
          const busyIds = typeof bridge?.isBackfillBusy === "function" ? picked.filter((it) => bridge.isBackfillBusy(it.sessionId) === true) : [];
          const picked2 = picked.filter((it) => !busyIds.includes(it));
          if (busyIds.length > 0 && picked2.length === 0) {
            return sendJson(res, 409, { ok: false, code: "backfill-busy", error: `选中的 ${busyIds.length} 个会话正在自动补账，稍后再试` });
          }
          picked.length = 0;
          picked.push(...picked2);
          if (wantedIds !== null && picked.length === 0) {
            return sendJson(res, 400, { ok: false, error: "指定的 sessionIds 都不在待补清单里（先用 dryRun 看清单）", due: listed.due });
          }
          // ★ C417：**回显实际生效的参数**。官方 Responses API 文档写得很直白：
          //   「Unsupported parameters are silently ignored and do not cause errors」。我们自己的接口䕺也一样 ——
          //   参数没生效时调用方不可能从响应里看出来（C408 那次就差点静默跑 20 个）。
          //   并一份 `applied` 回去，“你要的”和“真正生效的”一目了然。
          const applied = {
            sessionIds: wantedIds,
            limit: wantedIds === null ? limit : picked.length,
            minEvents,
            selected: picked.length,
          };
          if (dryRun) {
            // ★ C392：干跑要**提前告诉你哪几个会超时**。
            //   真机 p90 19s × 6 段 = 114s > `closeoutTimeoutMs`（90s）—— 点下去才发现白跑，
            //   代价是一次模型调用。所以在 dryRun 里把风险名单一并返回。
            const warnings = (() => {
              try {
                const perItemMs = Number(body.perItemMs);
                const timeoutMs = Number.isFinite(perItemMs) && perItemMs > 0 ? Math.max(10_000, Math.min(180_000, perItemMs)) : 90_000;
                const p90 = (() => {
                  const all = [];
                  for (const id of listed.items.map((x) => x.sessionId)) {
                    try {
                      const graph = store.load({ id, cwd: "" }).graph;
                      for (const m of graph?.foldMarks ?? []) if (Number.isFinite(m?.ms) && m.ms > 0) all.push(m.ms);
                    } catch {
                      /* 单会话读失败不影响整体 */
                    }
                  }
                  return recentFoldP90(all.map((ms) => ({ ms })));
                })();
                const risky = [];
                for (const item of listed.items) {
                  const est = Number(item.estTokens);
                  const planned = Number.isFinite(est) ? Math.max(1, Math.ceil(est / 150_000)) : 1;
                  const advice = closeoutTimeoutAdvice(planned, timeoutMs, p90);
                  if (!advice.ok) risky.push({ sessionId: item.sessionId, chunks: planned, worstMs: advice.worstMs });
                }
                if (risky.length === 0) return [];
                return [
                  `${risky.length} 个会话按 p90 估算会超过 ${Math.round(timeoutMs / 1000)}s 单会话超时（建议调大 closeoutTimeoutMs 或 closeoutMaxFoldTokens）`,
                ];
              } catch {
                return [];
              }
            })();
            return sendJson(res, 200, { ok: true, dryRun: true, scanned: listed.scanned, due: listed.due, items: picked, warnings, applied });
          }
          const controller = ctx.get("sessionController");
          const resolveAgent =
            controller && controller.agents && typeof controller.agents.resolveAgent === "function"
              ? (id) => controller.agents.resolveAgent(id)
              : null;
          if (resolveAgent === null) {
            return sendJson(res, 503, {
              ok: false,
              code: "no-session-controller",
              error: "宿主没有 sessionController —— 没法把归档会话 resume 成 live agent",
              scanned: listed.scanned,
              due: listed.due,
              items: picked,
            });
          }
          if (BACKFILL_GATE.inFlight) {
            return sendJson(res, 200, {
              ok: false,
              code: "backfill-busy",
              error: "已经有一次补账在跑 —— 等它结束（面板会显示剩余多少），别同时开第二次",
              scanned: listed.scanned,
              due: listed.due,
            });
          }
          BACKFILL_GATE.inFlight = true;
          try {
          const report = await backfillArchivedSessions({
            items: picked,
            registry: ctx.get("workspaceRegistry"),
            ...(perItemMs === undefined ? {} : { perItemMs }),
            resolveAgent,
            closeout: (agent) => bridge.closeoutNow(agent, { source: "backfill" }),
            // ★ C518：面板也要**读回图上的结局**，不许把"调用成功"当"真的折了"
            readGraph: (id) => {
              try {
                return store.load({ id, cwd: "" })?.graph ?? null;
              } catch {
                return null;
              }
            },
          });
          // ★ C426：真补完之后**必须作废清单缓存**。
          //   C416 的 10 秒缓存在这里会反噬：补完再点一次（十秒内）仍看到旧的 due 与旧清单，
          //   会以为"没补成功"。清一下就能让下一次点击拿到真实结果。
          LIST_DEBTS_CACHE.delete(cacheKey);
          return sendJson(res, 200, { ok: true, scanned: listed.scanned, due: listed.due, ...report });
          } finally {
            BACKFILL_GATE.inFlight = false; // 无论成败都释放，否则一次异常会把闸门永久焊死
          }
        }
        if (action === "models") {
          // ★ U1：单独的 models 动作（页面切换/刷新下拉时用）。永不失败：失败路径都是空目录。
          return sendJson(res, 200, { ok: true, models: await catalog(), at: new Date().toISOString() });
        }
        if (action === "defaults") {
          return sendJson(res, 200, { ok: true, defaults: uiDefaults(), fieldLabels: uiFieldLabels(), configItems: CONFIG_ITEMS });
        }
        if (action === "save") {
          const result = saveConfig(body.patch ?? {}, { home: resolveHome() });
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (action === "health") {
          const home = resolveHome();
          // ★ W-D：health 自检按请求里的 profile 走（缺省 desktop）；preset 发现用同一个 profile，
          //   否则非默认 profile 的实例会「装好了却报未装」。返回体带出 profile 方便排障。
          const allPresets = findPresetFiles(home, profileName);
          const scan = scanGraphs(home);
          return sendJson(res, 200, {
            ok: true,
            profile: profileName,
            health: health(home, allPresets, profileName),
            latest: latestGraphFrom(scan),
            today: todayAggregateFrom(scan),
          });
        }
        return sendJson(res, 400, { error: `未知 action: ${action}` });
      } catch (error) {
        const payload = { error: String(error?.message ?? error) };
        // B6：白名单外的键必须可见 —— 键名跟着 400 回给页面。
        if (Array.isArray(error?.skipped) && error.skipped.length > 0) payload.skipped = error.skipped;
        return sendJson(res, 400, payload);
      }
    },
  };
  // ★ C332：路由**心跳**。真机教训（2026-11-02）：插件实例被热重载/卸载后，`/gokifu/api` 变成
  //   GET 404 / POST 405，而 doctor、测试、门禁全都绿 —— 面板静默死掉，没人发现。
  //   所以注册时写一份心跳、**卸载时标记关闭**，doctor 读它就能说「面板在某时刻被卸载了，重启恢复」。
  const heartbeat = routeHeartbeatFile();
  // ★ C396：**无端口的进程不许覆盖心跳**。真机事故（2026-11-03）：
  //   一个没有 web 服务的进程（pid 14088、port null）把正在服务 56319 的心跳写成了空 ⇒
  //   所有"读心跳取端口"的工具（accept-after-restart / post-restart-check / doctor）全部读到无效值。
  //   规则：`state:"open"` 且拿不到端口 ⇒ **不写**（它反正不在服务）；其它状态照写。
  const mark = (payload) => {
    try {
      if (payload?.state === "open" && (payload?.port === null || payload?.port === undefined)) return;
      nodeFs.writeFileSync(heartbeat, JSON.stringify(payload), "utf8");
    } catch {
      /* 心跳写不了不影响路由本身 */
    }
  };
  // 端口也记下来：真机上可能同时有多个 DSH 进程，光凭 pid 分不清"面板注册在哪个端口"。
  const portOf = (ctx) => {
    const p = ctx?.webServer?.port ?? ctx?.webServer?.server?.address?.()?.port;
    return Number.isFinite(Number(p)) ? Number(p) : null;
  };
  // ★ C333：心跳要能回答「**跑的是哪一版**」。真机教训：两个 DSH 进程同时存在时，
  //   光有 pid 分不清谁是谁；带上 version + buildId 就能与磁盘比，判断面板是不是旧实例。
  const stampOf = () => {
    try {
      return { version: repoVersion(), buildId: repoBuildId() };
    } catch {
      return { version: null, buildId: null };
    }
  };
  // ★ C334：`hasWebServer` —— 真机上见过「插件被加载进一个**没有 web 服务**的进程」：
  //   心跳写着 open、buildId 也对，但那个 pid 根本没监听端口，面板自然不可达。
  //   不记这一位，doctor 会把"注册了"读成"能访问"。
  const hasWebServer = Boolean(ctx?.webServer && typeof ctx.webServer.register === "function");
  // ★ C371：心跳**不能先于真正注册**。上一版在 `register()` **之前**就写 `state:"open"` ——
  //   真机上真的遇到了：心跳写着 open、doctor 报"已注册"，而 `/gokifu/api` 实测 **405（路由不存在）**。
  //   现在：注册**成功之后**才写 open；抛错写 `state:"failed"` 并带错误摘要。
  ctx.effect(() => {
    let dispose = null;
    try {
      dispose = ctx.webServer.register(route);
    } catch (error) {
      mark({ state: "failed", at: Date.now(), pid: process.pid, port: portOf(ctx), hasWebServer, error: String(error?.message ?? error).slice(0, 160), ...stampOf() });
      throw error;
    }
    uiRouteRegistered = true;
    mark({ state: "open", at: Date.now(), pid: process.pid, port: portOf(ctx), hasWebServer, ...stampOf() });
    return () => {
      uiRouteRegistered = false;
      mark({ state: "closed", at: Date.now(), pid: process.pid, port: portOf(ctx), hasWebServer, ...stampOf() });
      if (typeof dispose === "function") dispose();
    };
  }, "gokifu-ui: /gokifu/api");
}

/**
 * ★ C332：路由心跳文件的位置（与棋谱同根，便于 doctor 只读不探网）。
 * @returns {string}
 */
export function routeHeartbeatFile(home = resolveHome()) {
  return nodePath.join(home, "chess-context", "ui-route.json");
}

/**
 * 心跳判定的**结论词表**（读侧唯一出口，见 {@link judgeRouteHeartbeat}）。
 *
 * 为什么要把它做成显式的四个词：`closed` 有两种完全相反的含义 ——
 *   · 进程还活着、面板被正常卸载 ⇒ 面板**未在服务**（`not-serving`，可以下结论）；
 *   · 写心跳的那个进程**已经退出** ⇒ 这条心跳是**遗嘱**，它对现状一字不知 ⇒ **无法判断**（`unknown`）。
 * 旧实现把两者混成一句话（`state==="open" ? 在服务 : 不可用`），于是 2026-11-05 真机上
 * 「pid 22508 已退出、64535 无监听，真正活着的是另一个 pid」被读成「面板死了」。
 */
export const ROUTE_HEARTBEAT_VERDICT = Object.freeze({
  /** 心跳说 open，且记录的 pid 仍存活 —— 面板在服务。 */
  SERVING: "serving",
  /** 记录的 pid 仍存活，但它自己说 closed/failed —— 面板未在服务（**可以**下结论）。 */
  NOT_SERVING: "not-serving",
  /** 记录的 pid 已不存在（或没有可用 pid）—— **无法判断**，不是「不可用」。 */
  UNKNOWN: "unknown",
  /** 文件不存在 / 损坏 —— 明确的缺失态（不抛、也不猜）。 */
  MISSING: "missing",
});

/**
 * ★ T5（2026-11-05）：pid 还活着吗？—— 只探测，不发信号。
 *
 * 真机事实（2026-11-05 01:45）：`ui-route.json` 写着 `{state:"closed", pid:22508, port:64535}`，
 * 而 22508 早已退出、64535 无监听；真正活着的 DSH 是另一个 pid、面板在别的端口。
 * 于是所有「只读心跳、把 state 当结论」的工具（doctor / accept-after-restart / panel-probe）
 * **把活着判成了死了**。根因不在 state，在于**没验这份心跳是谁留下的**。
 *
 * 语义与 `scripts/post-restart-check.mjs:pidAlive()` 一致（src 不许反向依赖 scripts，各留一份）：
 *   · `true`  —— 进程存在（`EPERM` = 存在但没权限看，也算活着）
 *   · `false` —— 进程不存在（`ESRCH`）
 *   · `null`  —— 无法判断（pid 不是正整数 / 平台不支持）
 *
 * @param {unknown} pid
 * @returns {boolean|null}
 */
export function pidAlive(pid) {
  // ★ C604（集成去重）：**存活判定只有一份**，在 `src/rooms/build-stamp.mjs` 的 `processIsAlive`。
  //   这里原来是第二份实现（同样 `process.kill(pid,0)` + EPERM/ESRCH 分支）。
  //   两份判据迟早漂移（T4/T5 两条并行线就各自写了一份），所以改成薄委托：
  //   build-stamp = 「读文件 + 判定 state」，ui.mjs = 「把判定渲染成面板文案」。
  // 三态契约（build-stamp 的 `processIsAlive` 是二态）：非法 pid 必须回 `null`（无法判断），
  // 不能回 `false` —— 那会让「没有 pid 的老格式心跳」被误判成「进程已死」。
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  return processIsAlive(n);
}

/**
 * 心跳的**状态判定**（纯函数，不读盘）：把「文件里写了什么」+「pid 还在不在」变成一句人话。
 *
 * 三种必须分开的形状：
 *   ① pid 活着 + `state:"closed"` ⇒ `stale:false` / `verdict:"not-serving"` —— 正常关闭，**照旧**；
 *   ② pid 已退出                  ⇒ `stale:true`  / `verdict:"unknown"`   —— **无法判断**，
 *      绝不能说成「面板不可用」：说话的那个进程已经不在了；
 *   ③ 没有可用 pid（老格式）      ⇒ `alive:null` / `verdict:"unknown"`   —— 同样不下结论。
 *
 * @param {object} heartbeat 已解析的心跳对象
 * @returns {{present:boolean, state:string, pid:number|null, alive:boolean|null, stale:boolean, serving:boolean, verdict:string, text:string, error:string|null}}
 */
export function judgeRouteHeartbeat(heartbeat) {
  const hb = heartbeat !== null && typeof heartbeat === "object" && !Array.isArray(heartbeat) ? heartbeat : {};
  const rawPid = Number(hb.pid);
  const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
  const alive = pid === null ? null : pidAlive(pid);
  const stale = alive === false;
  const state = String(hb.state ?? "?");
  const at = Number.isFinite(Number(hb.at)) ? new Date(Number(hb.at)).toISOString() : null;
  const port = hb.port === null || hb.port === undefined ? null : Number(hb.port);
  const serving = state === "open" && alive === true;

  let verdict;
  let text;
  if (stale) {
    // 心跳的**主人**已经不在了：它写下的 closed 只说明「它退出时关了」，不说明现在没有面板。
    verdict = ROUTE_HEARTBEAT_VERDICT.UNKNOWN;
    text = `无法判断面板是否在服务：心跳记录的 pid ${pid} 已不存在（${at ?? "?"} 的遗留心跳，state=${state}）`;
  } else if (alive === null) {
    verdict = ROUTE_HEARTBEAT_VERDICT.UNKNOWN;
    text = `无法判断面板是否在服务：心跳没有可用的 pid（state=${state}）`;
  } else if (serving) {
    verdict = ROUTE_HEARTBEAT_VERDICT.SERVING;
    text = `面板在服务（pid ${pid}${port === null ? "" : `，端口 ${port}`}）`;
  } else if (state === "closed") {
    verdict = ROUTE_HEARTBEAT_VERDICT.NOT_SERVING;
    text = `面板未在服务（pid ${pid} 仍存活，state=closed${at === null ? "" : `，${at} 标记关闭`}）`;
  } else if (state === "failed") {
    verdict = ROUTE_HEARTBEAT_VERDICT.NOT_SERVING;
    text = `面板未在服务（pid ${pid} 仍存活，注册失败：${String(hb.error ?? "无错误信息").slice(0, 160)}）`;
  } else {
    verdict = ROUTE_HEARTBEAT_VERDICT.UNKNOWN;
    text = `无法判断面板是否在服务（pid ${pid} 存活，但 state=${state} 不认识）`;
  }

  return { present: true, state, pid, alive, stale, serving, verdict, text, error: hb.error ?? null };
}

/**
 * ★ T5：读 `ui-route.json` —— **先验 pid 存活，再谈 state**。
 *
 * 这是心跳的**唯一**读侧入口：任何「面板在不在服务」的结论都必须经由它，否则就会重演
 * 2026-11-05 的误判（死 pid 的遗嘱被当成现状）。缺文件 / 半截 JSON / 合法但非对象
 * 一律**不抛**，返回明确的缺失态（`state:"missing" | "corrupt" | "unreadable"`、`verdict:"missing"`）。
 *
 * @param {string} [home]
 * @returns {{file:string, present:boolean, state:string, pid:number|null, alive:boolean|null, stale:boolean, serving:boolean, verdict:string, text:string, error:string|null, heartbeat:object|null}}
 */
export function readRouteHeartbeat(home = resolveHome()) {
  const file = routeHeartbeatFile(home);
  const missing = (state, error, text) => ({
    file,
    present: false,
    state,
    pid: null,
    alive: null,
    stale: false,
    serving: false,
    verdict: ROUTE_HEARTBEAT_VERDICT.MISSING,
    text,
    error: error ?? null,
    heartbeat: null,
  });

  let text;
  try {
    text = nodeFs.readFileSync(file, "utf8");
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 160);
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return missing("missing", null, `没有可用心跳：${file} 不存在`);
    }
    return missing("unreadable", message, `没有可用心跳：${file} 读不了（${message}）`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 160);
    return missing("corrupt", message, `没有可用心跳：${file} 不是合法 JSON（${message}）`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    const kind = payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload;
    return missing("corrupt", `解析结果不是对象（${kind}）`, `没有可用心跳：${file} 解析结果不是对象（${kind}）`);
  }

  return { file, ...judgeRouteHeartbeat(payload), heartbeat: payload };
}

function readVersion() {
  try {
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "..", "package.json"), "utf8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
