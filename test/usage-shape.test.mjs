/**
 * usage-shape.test.mjs —— T49-R07「写侧补键」守卫（2026-11-05）
 *
 * 缺陷（真机量化见 `scripts/usage-shape-audit.mjs`）：
 *   `src/rooms/offline-fold.mjs` 的 `normalizeUsage` 是 7 个读取点共享的形状定义，它的
 *   `cached` 那一行只 pick `cachedTokens` → `prompt_tokens_details.cached_tokens`，
 *   **不认宿主引擎给的 `cacheReadTokens`**。于是引擎那条路的缓存命中量在**落盘时被丢成 null**：
 *   真机 `pressure` 折痕 92/125 有值，`archive-offline` 折痕只有 3 条有值（另外 464 条由
 *   恒等式反证"确实有命中"，说明数字是被丢的，不是"没命中"）。
 *   这就是面板「命中率 0%」的**写侧**根因（读侧的 `Number(null) === 0` 由 T49 修）。
 *
 * 这组用例钉四件事：
 *   ① 三种形状（`cacheReadTokens` / `cachedTokens` / `prompt_tokens_details.cached_tokens`）都读得出来；
 *   ② **三者并存时取 `cacheReadTokens`**（把 pick 顺序钉死，防止以后被"顺手重排"改回去）；
 *   ③ **全缺失 ⇒ null**，不是 0（「不知道」≠「没命中」）；**明确给 0 时仍是 0**；
 *   ④ 与读侧（`fold-quality.mjs` 的 C547 归一化）**同一口径**，且重试累加不丢命中量。
 *
 * 全部是纯函数，不联网、不调模型、不写盘、不读真机数据。
 */
import { normalizeUsage, sumFoldUsage } from "../src/rooms/offline-fold.mjs";
import { normalizeUsage as readSideNormalizeUsage } from "../src/rooms/fold-quality.mjs";

export const tests = {};

/* ───────────────────────────── 夹具：三种真实形状 ───────────────────────────── */

/** ① 宿主引擎（Assembler）形状 —— 就是被丢掉的那个。 */
const HOST = { inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cacheReadTokens: 19584 };
/** ② 我们早期归一化自己写的形状（旧 mark 里的键名）。 */
const LEGACY = { inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cachedTokens: 19584 };
/** ③ provider 原始响应形状（脚本 `archive-fold.mjs` 那条路）。 */
const RAW = {
  prompt_tokens: 2158 + 19584,
  completion_tokens: 257,
  total_tokens: 21999,
  prompt_tokens_details: { cached_tokens: 19584 },
};

/* ───────────────────────────── ① 三种形状都读得出 ───────────────────────────── */

tests["R07-① 宿主形状：cacheReadTokens 必须读得出来（旧链在这里丢成 null）"] = (t) => {
  const n = normalizeUsage(HOST);
  t.eq(n.cacheReadTokens, 19584, "`cacheReadTokens` 是宿主归一后的名字，必须进 cached 的 pick 链");
  t.eq(n.inputTokens, 2158, "未命中输入照旧");
  t.eq(n.outputTokens, 257, "输出照旧");
  t.eq(n.totalTokens, 21999, "总计照旧（命中量不参与 total 的兜底计算）");
  // 恒等式：宿主口径 inputTokens 只含未命中 ⇒ total = miss + hit + out（C361 真机自证）
  t.eq(n.inputTokens + n.cacheReadTokens + n.outputTokens, n.totalTokens, "补键之后恒等式仍然成立");
};

tests["R07-① 旧 mark 形状：cachedTokens 仍读得出（补键不许把老路踩坏）"] = (t) => {
  t.eq(normalizeUsage(LEGACY).cacheReadTokens, 19584, "`cachedTokens` 必须还在链上");
};

tests["R07-① provider 原始形状：prompt_tokens_details.cached_tokens 仍读得出"] = (t) => {
  const n = normalizeUsage(RAW);
  t.eq(n.cacheReadTokens, 19584, "嵌套键必须还能读（脚本那条路全靠它）");
  t.eq(n.inputTokens, 21742, "`prompt_tokens` 是含命中的总输入 —— 归一化不改它的原样");
  t.eq(n.totalTokens, 21999, "`total_tokens` 照旧");
};

/* ───────────────────────────── ② 三者并存：钉死顺序 ───────────────────────────── */

tests["R07-② 三者并存 ⇒ 取 cacheReadTokens（宿主归一后的名字最可信）"] = (t) => {
  const all = { inputTokens: 100, outputTokens: 5, totalTokens: 1105, cacheReadTokens: 1000, cachedTokens: 2000, prompt_tokens_details: { cached_tokens: 3000 } };
  t.eq(normalizeUsage(all).cacheReadTokens, 1000, "缓存命中量三者并存时必须取 cacheReadTokens");
};

tests["R07-② 只剩后两者 ⇒ 取 cachedTokens（顺序是 cacheReadTokens → cachedTokens → 原始嵌套）"] = (t) => {
  const two = { inputTokens: 100, outputTokens: 5, totalTokens: 1105, cachedTokens: 2000, prompt_tokens_details: { cached_tokens: 3000 } };
  t.eq(normalizeUsage(two).cacheReadTokens, 2000, "没有 cacheReadTokens 时取 cachedTokens，而不是更原始的 cached_tokens");
};

tests["R07-② 顺序与读侧一致（fold-quality 的 C547 归一化同序）"] = (t) => {
  const all = { inputTokens: 100, outputTokens: 5, totalTokens: 1105, cacheReadTokens: 1000, prompt_tokens_details: { cached_tokens: 3000 } };
  // 写侧写进 mark 的 cacheReadTokens，读侧（doctor / ui.mjs 走的是 fold-quality）必须读出同一个数
  t.eq(readSideNormalizeUsage(normalizeUsage(all)).hit, 1000, "写侧落盘的那个数，读侧必须原样读到");
  t.eq(readSideNormalizeUsage(HOST).hit, 19584, "读侧本来就直接认 cacheReadTokens —— 写侧补键后两边同口径");
};

/* ───────────────────────────── ③ 缺失 ≠ 0 ───────────────────────────── */

tests["R07-③ 三种形状全缺失 ⇒ null（不是 0）"] = (t) => {
  const none = { inputTokens: 100, outputTokens: 5, totalTokens: 105 };
  const n = normalizeUsage(none);
  t.eq(n.cacheReadTokens, null, "「不知道命中多少」必须是 null —— 写成 0 就是那条 0% 假读");
  t.eq(n.cacheReadTokens === 0, false, "显式确认不是 0（Number(null) === 0 的坑）");
  t.eq(n.totalTokens, 105, "别的字段不受影响");
};

tests["R07-③ 明确给 0 ⇒ 仍是 0（provider 说没命中 ≠ 字段缺失）"] = (t) => {
  t.eq(normalizeUsage({ inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheReadTokens: 0 }).cacheReadTokens, 0, "0 是真实读数，不许被当成缺失");
  t.eq(normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } }).cacheReadTokens, 0, "原始形状同理");
};

/* ───────────────────────────── ④ 幂等 / 累加 / 反推一致 ───────────────────────────── */

tests["R07-④ 幂等：过两遍归一化器结果不变（补键让 cacheReadTokens 能往返）"] = (t) => {
  for (const [name, usage] of Object.entries({ HOST, LEGACY, RAW })) {
    const once = normalizeUsage(usage);
    const twice = normalizeUsage(once);
    t.eq(twice, once, `${name}：normalizeUsage(normalizeUsage(u)) 必须与一次相同（sumFoldUsage 会过两遍）`);
  }
};

tests["R07-④ T49 重试累加不丢命中量（sumFoldUsage 两侧都归一化）"] = (t) => {
  const sum = sumFoldUsage(HOST, HOST); // 同一条 prompt 发了两次（C522 截断重试）
  t.eq(sum.cacheReadTokens, 19584 * 2, "两次调用的命中量必须都进账 —— 旧链在这里得 null");
  t.eq(sum.inputTokens, 2158 * 2, "未命中输入照样相加");
  t.eq(sum.inputTokens + sum.cacheReadTokens + sum.outputTokens, sum.totalTokens, "累加后恒等式仍成立");
};

tests["R07-④ 反证：旧链（不含 cacheReadTokens）在这些夹具上必须给出 null/错值"] = (t) => {
  // 这条是**失败分支自检**：它证明上面那些断言真的能抓住回归 —— 把 pick 链改回旧版，
  // 宿主形状会退化成 null、三者并存会取到 2000/3000 而不是 1000，上面的用例立刻变红。
  const oldChain = (u) => {
    for (const x of [u.cachedTokens, u.prompt_tokens_details?.cached_tokens]) {
      if (x === null || x === undefined) continue;
      const n = Number(x);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  };
  t.eq(oldChain(HOST), null, "旧链读不出宿主形状（这就是写侧丢数的现场）");
  t.eq(oldChain(LEGACY), 19584, "旧链能读 cachedTokens");
  t.eq(oldChain(RAW), 19584, "旧链能读原始嵌套键");
  const all = { cacheReadTokens: 1000, cachedTokens: 2000, prompt_tokens_details: { cached_tokens: 3000 } };
  t.eq(oldChain(all), 2000, "旧链在三者并存时会取 2000 —— 与修复后的 1000 不同，顺序断言因此有效");
};
