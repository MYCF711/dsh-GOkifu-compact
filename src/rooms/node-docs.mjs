/**
 * node-docs.mjs —— `nodes/<id>.md` 与 `graph.json` 的一致性（2026-11-02，C110）
 *
 * 为什么：热清单省略行会写 `… 另有 N 条，见 nodes/<id>.md`（交给模型自己去查）。
 * 如果那个文件**不存在**，这条指针就是**空承诺** —— 比不写还糟，因为模型会去读、然后读到 ENOENT。
 *
 * 另一方向（文件比节点多）只是**陈旧工件**：节点被回滚/删除后 md 没清。它不会误导阅读
 * （热清单只引用图里存在的节点），但值得计数，因为数量持续增长说明有路径在「写了不删」。
 */

/**
 * @param {{graphNodes:string[], files:string[]}} args
 *   `files` 是 `nodes/` 目录里的**文件名**（可带 `.md`）
 * @returns {{missing:string[], orphan:string[]}}
 */
export function nodeDocStats({ graphNodes = [], files = [] } = {}) {
  const ids = new Set(graphNodes.map((id) => String(id)));
  const have = new Set(files.map((name) => String(name).replace(/\.md$/i, "")));
  const missing = [];
  const orphan = [];
  for (const id of ids) if (!have.has(id)) missing.push(id);
  for (const name of have) if (!ids.has(name)) orphan.push(name);
  missing.sort();
  orphan.sort();
  return { missing, orphan };
}

/** 把统计压成一句给人看的话（doctor 一行）。 */
export function nodeDocVerdict({ missing = [], orphan = [] } = {}) {
  if (missing.length === 0 && orphan.length === 0) return { level: "ok", detail: "" };
  if (missing.length > 0) {
    return {
      level: "warn",
      detail: `${missing.length} 个节点缺 nodes/<id>.md（热清单省略行指向它们 ⇒ 空指针）：${missing.slice(0, 5).join(", ")}`,
    };
  }
  return { level: "ok", detail: `${orphan.length} 个陈旧 md（节点已不在图里；不影响引用，仅计数）` };
}
