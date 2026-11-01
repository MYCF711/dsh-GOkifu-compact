/**
 * ui.mjs —— 「上下文压缩」详情页的 host 半（HTTP 路由 + 状态/配置读写）
 *
 * 为什么需要 host 半：引擎挂在 **agent preset 的 compaction group（isolate realm）** 里，
 * 浏览器页面摸不到它；而配置又写在 preset 的 `cordis.patch.yml`（磁盘文件）。
 * 所以页面只做 UI，数据由这里通过 `ctx.webServer` 的具名路由提供：
 *
 *   POST /gokifu/api  {action:"state"|"save"|"health"|"defaults", patch?, sessionId?}
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
import { parseEngineBlock, renderEngineBlock, ENTRY_ID, PKG_NAME } from "./rooms/preset-format.mjs";
// ★ A2-4（2026-10-30）：默认值/中文名/净化规则全部来自 R15（config-schema），页面不再各留一份。
import { configDefaults, fieldLabels, describeConfig as describeConfigFromSchema, validatePatch } from "./rooms/config-schema.mjs";

/**
 * 本文件所在目录（真实路径）。
 *
 * 为什么不用 `new URL(import.meta.url).pathname`：pathname 是**百分号编码**串
 * （`/D:/%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA/…`），拼出来的路径在磁盘上不存在 ⇒
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

/** 与 engine.mjs 的 Config 保持一致的默认值（页面用来显示「默认」）。 */
/** 与 R15（config-schema）保持一致的默认值（页面用来显示「默认」）。 */
export const DEFAULTS = Object.freeze(configDefaults());
function resolveHome() {
  return process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "DeepSeek Harness", "home");
}

/** 读 profile 的 `dsh.profile.bundles[]`；任何异常都当成「没有」（发现函数不许抛）。 */
function readProfileBundles(profileDir) {
  const file = nodePath.join(profileDir, "package.json");
  try {
    if (!nodeFs.existsSync(file)) return [];
    const pkg = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    const bundles = pkg?.dsh?.profile?.bundles;
    return Array.isArray(bundles) ? bundles.filter((b) => typeof b === "string" && b.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** 读文本；不存在 / 不是文件 / 读失败 ⇒ null（发现函数不许抛）。 */
function readTextOrNull(file) {
  try {
    return nodeFs.existsSync(file) ? nodeFs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

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
const GRAPH_CACHE_MAX = 2000;

/** 目录扫描：{root, files:[{dir,file,mtimeMs,size}]}（不读文件内容）。 */
function collectGraphFiles(home = resolveHome()) {
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

/** 每个文件的聚合摘要缓存（key = 绝对路径 + mtimeMs + size）。 */
function graphSummary(entry) {
  const cached = GRAPH_CACHE.get(entry.file);
  if (cached !== undefined && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) return cached;
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
      nodes: Object.keys(g.nodes ?? {}).length,
      edges: Object.keys(g.edges ?? {}).length,
    };
  } catch {
    summary = null; // 坏图：缓存「坏」这个事实，别每次重读
  }
  const row = { mtimeMs: entry.mtimeMs, size: entry.size, summary };
  if (GRAPH_CACHE.size >= GRAPH_CACHE_MAX) GRAPH_CACHE.clear();
  GRAPH_CACHE.set(entry.file, row);
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
  const best = scan.files.reduce((acc, file) => (acc === null || file.mtimeMs > acc.mtimeMs ? file : acc), null);
  if (best === null) return null;
  const summary = graphSummary(best).summary;
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
    nodes: summary.nodes,
    edges: summary.edges,
  };
}

/** 今天的 fold 汇总（按 foldMarks.at，不按文件 mtime）。 */
export function todayAggregateFrom(scan) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let folds = 0;
  let shadowed = 0;
  const sessions = new Set();
  let totalSessions = 0;
  let totalFailures = 0;
  for (const file of scan.files) {
    totalSessions += 1;
    const summary = graphSummary(file).summary;
    if (summary === null) continue;
    const marks = summary.foldMarks.filter((mark) => (mark.at ?? 0) >= from);
    if (marks.length > 0) {
      folds += marks.length;
      sessions.add(file.dir);
      shadowed += marks.reduce((sum, mark) => sum + (mark.shadowedTokens ?? 0), 0);
    }
    totalFailures += summary.failures;
  }
  return { folds, shadowed, sessions: sessions.size, totalSessions, totalFailures };
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

/** 给一个 promise 套时间上限；超时按「拿不到」处理（调用方的 catch 会接住）。 */
async function withinBudget(promise, ms = CATALOG_CALL_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        // ⚠ 不许 unref：这个 timer 就是「保证一定会 settle」的那一半。
        //   unref 掉之后，如果宿主调用恰好不产生任何句柄（真实卡死就是这种），
        //   事件循环会先空转退出 ⇒ await 永远不返回（实测：test 里报 unsettled top-level await）。
        timer = setTimeout(() => reject(new Error("catalog call timed out")), ms);
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
export function describeConfig(presetConfig = {}) {
  return describeConfigFromSchema(presetConfig);
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
export function sanitizePatch(patch) {
  return validatePatch(patch);
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
    if (SECRET_KEY_RE.test(key)) throw new Error(`含密钥的键不允许通过页面写入：${label(key)}`);
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

export function apply(ctx) {
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
            // ★ B4：`config` 给的是**引擎生效值**（缺失键补默认、非法值按引擎规则净化）。
            //   页面直接渲染它就不会再把 true/semantic 显示成「未配置/空」。
            config: described.effective,
            // 文件里实际写了哪些键（诊断用；也是「哪些是用户显式设过」的事实来源）
            presetConfig,
            configOrigins: described.origins,
            unconfiguredKeys: described.unconfiguredKeys,
            defaults: DEFAULTS,
            fieldLabels: FIELD_LABELS,
            configFile: presets[0]?.file ?? null,
            latest: latestGraphFrom(scan),
            today: todayAggregateFrom(scan),
            health: health(home, allPresets, profileName),
            // ★ U1：首屏一次拿全 —— 摘要模型下拉直接用 state.models，少一个请求。
            //   只**新增**字段：上面所有既有字段语义未动。拿不到就是 { providers: [] }。
            models: await catalog(),
          });
        }
        if (action === "models") {
          // ★ U1：单独的 models 动作（页面切换/刷新下拉时用）。永不失败：失败路径都是空目录。
          return sendJson(res, 200, { ok: true, models: await catalog(), at: new Date().toISOString() });
        }
        if (action === "defaults") return sendJson(res, 200, { ok: true, defaults: DEFAULTS, fieldLabels: FIELD_LABELS });
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
  ctx.effect(() => ctx.webServer.register(route), "gokifu-ui: /gokifu/api");
}

function readVersion() {
  try {
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(HERE, "..", "package.json"), "utf8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
