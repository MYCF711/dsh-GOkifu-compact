/**
 * bench-cli.test.mjs —— 成本基线门禁的「默认不写盘」与解析契约（2026-11-02，C85）
 *
 * 背景：`test/bench.mjs` 每次跑都会写 `evidence/bench-N.json` —— 于是每跑一轮门禁，工作树就脏一次
 * （本会话连续几十轮都要 `git checkout -- evidence/bench-2000.json`）。C65 已经给 `live-folds`
 * 立过同一条纪律：**测试/诊断脚本默认不许写仓库**。
 *
 * 这里把新契约钉住：
 *   ① `node test/bench.mjs 200` 默认不写文件，且摘要行带档位；
 *   ② `--write` 才写（测完删除，不留工件）；
 *   ③ `bench-repro` 默认不改 `evidence/bench-2000.json`，且从 stdout 拿到档位（不再依赖证据文件是否最新）。
 */

import { execFileSync } from "node:child_process";
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const BENCH = nodePath.join(REPO, "test", "bench.mjs");
const BENCH_REPRO = nodePath.join(REPO, "scripts", "bench-repro.mjs");
const EVIDENCE_200 = nodePath.join(REPO, "evidence", "bench-200.json");
const EVIDENCE_2000 = nodePath.join(REPO, "evidence", "bench-2000.json");

export const tests = {};

const sha = (file) => (nodeFs.existsSync(file) ? nodeCrypto.createHash("sha256").update(nodeFs.readFileSync(file)).digest("hex") : null);

function run(script, args = []) {
  return execFileSync(process.execPath, [script, ...args], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

tests["C85-1 bench 默认不写盘：不产生 evidence/bench-200.json，摘要行必须带档位"] = (t) => {
  const before = nodeFs.existsSync(EVIDENCE_200);
  const out = run(BENCH, ["200"]);
  t.eq(nodeFs.existsSync(EVIDENCE_200), before, "默认不许创建/保留 evidence/bench-200.json");
  t.includes(out, "不写盘", "要明确告诉用户「没写盘」");
  t.eq(/档位 L\d+/.test(out), true, `摘要行必须带档位（bench-repro 靠它解析）：\n${out.slice(-200)}`);
};

tests["C85-2 --write 才写盘（测完删除工件）"] = (t) => {
  try {
    run(BENCH, ["200", "--write"]);
    t.eq(nodeFs.existsSync(EVIDENCE_200), true, "--write 必须写 evidence/bench-200.json");
  } finally {
    nodeFs.rmSync(EVIDENCE_200, { force: true });
  }
};

tests["C85-3 bench-repro 默认不改证据文件，且能从 stdout 解析档位（无 DRIFT）"] = (t) => {
  const before = sha(EVIDENCE_2000);
  const out = run(BENCH_REPRO);
  t.eq(sha(EVIDENCE_2000), before, "bench-repro 默认不许改 evidence/bench-2000.json");
  t.includes(out, "hot-list tokens:", "要打印 tokens");
  t.eq(/tier=L\d+/.test(out), true, `档位必须来自 stdout：\n${out}`);
  t.includes(out, "failure-retention: 8 / 8", "失败保留必须报 8/8");
};
