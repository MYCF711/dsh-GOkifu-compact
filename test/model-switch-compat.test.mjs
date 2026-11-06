import nodeFs from "node:fs";
import nodePath from "node:path";
import { load, makeCtx, makeSession, readGraph } from "./engine-harness.test.mjs";
import { evaluateManifest, satisfies } from "./verify-install.mjs";

export const tests = {};

const OLD = Object.freeze({ provider: "p", model: "m", maxTokens: 4096 });
const NEW = Object.freeze({ provider: "next-provider", model: "next-model", maxTokens: 0 });
const HEADER = { config: { ...NEW } };

function seed(session, count = 19) {
  for (let i = 0; i < count; i += 1) {
    session.push("user/message", { source: { kind: "prompt" }, content: [{ type: "text", text: "x" }] });
  }
}

function stopBackfill(engine) {
  if (engine._autoBackfill) {
    clearTimeout(engine._autoBackfill.first);
    clearInterval(engine._autoBackfill.timer);
  }
  engine.chess.autoBackfill = false;
}

function headerScaledMeter(ctx, calls, scale) {
  const measure = ctx.tokenMeter.measure.bind(ctx.tokenMeter);
  ctx.tokenMeter.measure = (session, header) => {
    calls.push(header?.config ? { ...header.config } : null);
    const base = measure(session);
    if (!header) return base;
    const totalTokens = Math.floor(base.totalTokens * scale);
    return { ...base, totalTokens, surfaceTokens: totalTokens };
  };
}

tests["DSH caret declarations stay valid for the RC1 compatibility probe"] = (t) => {
  const manifest = JSON.parse(nodeFs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  t.eq(manifest.engines.dsh, "^0.2.0-rc.2");
  for (const name of ["@deepseek-ai/dsh-compaction", "@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-session"]) {
    t.eq(manifest.peerDependencies[name], "^0.2.0-rc.2", name);
  }
  t.eq(manifest.peerDependencies["@deepseek-ai/schemastery"], "^3.18.4");
  t.ok(satisfies("0.2.2-rc.1", manifest.engines.dsh), "RC1 must satisfy the prerelease-aware range");
  t.ok(!satisfies("0.3.0-rc.0", manifest.engines.dsh), "the next minor prerelease must remain excluded");
  const accepted = evaluateManifest(manifest, { hostVersion: "0.2.2-rc.1" });
  t.ok(accepted.ok, JSON.stringify(accepted));
  const pinned = evaluateManifest({
    ...manifest,
    peerDependencies: { ...manifest.peerDependencies, "@deepseek-ai/dsh-llm": "0.2.0-rc.2" },
  }, { hostVersion: "0.2.2-rc.1" });
  t.ok(!pinned.ok && pinned.rangeProblems.length > 0, "a pinned old peer must fail closed");
};

tests["RC1 model-switch folds through planFold and measures the proposed header"] = async (t) => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-model-switch-success" });
  seed(session);
  const firstPlainSeq = session.surface.nodes[1];
  const calls = [];
  let engine;
  const ctx = makeCtx({ window: 200_000, measureTotal: () => engine.compactCalls.length > 0 ? 10_000 : 300_000 });
  headerScaledMeter(ctx, calls, 0.5);
  engine = new Engine(ctx, {
    graphDir: nodePath.join(graphDir, "model-switch-success"),
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    firstFoldRatio: 0,
    compactionRetries: 0,
    tier2After: 0,
  });
  stopBackfill(engine);
  const result = await engine.compactPressure({ session, options: { ...OLD } }, HEADER, undefined, true);
  t.ok(result !== null && result !== undefined, "model-switch must produce a fold");
  t.eq(engine.compactCalls.length, 1);
  t.eq(engine.compactCalls[0].start, firstPlainSeq, "fold must retain incremental planFold range selection");
  t.ok(calls.some((config) => config?.provider === NEW.provider && config?.model === NEW.model), "proposed header must reach tokenMeter.measure");
  const graph = engine.graphs.get(session.id);
  t.eq(graph.foldCount, 1);
  t.eq(graph.foldMarks.at(-1).trigger, "model-switch");
  t.eq(graph.lastFoldTotalTokens, 5_000, "accepted switch keeps next-header accounting");
};

tests["RC1 model-switch retries use exact target policy including explicit zero"] = async (t) => {
  const { Engine, graphDir } = await load();
  const matrix = [
    { name: "target-two", global: 0, policies: [{ provider: NEW.provider, model: NEW.model, compactionRetries: 2 }], expected: 3 },
    { name: "target-zero", global: 2, policies: [{ provider: NEW.provider, model: NEW.model, compactionRetries: 0 }], expected: 1 },
    { name: "fallback", global: 2, policies: [{ provider: "other-provider", model: NEW.model, compactionRetries: 0 }], expected: 3 },
    { name: "fallback-empty", global: 2, policies: [], expected: 3 },
  ];
  for (const definition of matrix) {
    const session = makeSession({ id: `sess-model-switch-retries-${definition.name}` });
    const ctx = makeCtx({ window: 100_000, measureTotal: () => 90_000 });
    const engine = new Engine(ctx, {
      graphDir: nodePath.join(graphDir, `model-switch-retries-${definition.name}`),
      auto: false,
      thresholdRatio: 0.5,
      firstFoldRatio: 0,
      headroomTokens: 0,
      retainRatio: 0.1,
      compactionRetries: definition.global,
      modelPolicies: definition.policies,
      tier2After: 0,
    });
    stopBackfill(engine);
    engine.config = { ...engine.config, compactionRetries: definition.global, modelPolicies: definition.policies };
    const attempts = [];
    engine.compactIfNeeded = async (_agent, trigger, _signal, options) => {
      attempts.push({ trigger, options });
      return { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1] };
    };
    let error = null;
    try {
      await engine.compactPressure({ session, options: { ...OLD } }, HEADER, undefined, true);
    } catch (caught) {
      error = caught;
    }
    t.eq(attempts.length, definition.expected, definition.name);
    t.ok(String(error?.message ?? error).includes(`after ${definition.expected} compaction attempts`), `${definition.name}: ${String(error)}`);
    for (const attempt of attempts) {
      t.eq(attempt.trigger, "model-switch", definition.name);
      t.eq(attempt.options.header.config.provider, NEW.provider, definition.name);
      t.eq(attempt.options.spec.thresholdTokens, 50_000, definition.name);
      t.eq(attempt.options.spec.retainTokens, 10_000, definition.name);
    }
  }
};

tests["RC1 first model-switch growth gate compares committed-route tokens"] = async (t) => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-model-switch-growth-units" });
  seed(session);
  let total = 100_000;
  const ctx = makeCtx({ window: 200_000, measureTotal: () => total });
  headerScaledMeter(ctx, [], 2);
  const engine = new Engine(ctx, {
    graphDir: nodePath.join(graphDir, "model-switch-growth-units"),
    auto: false,
    growthFloorTokens: 50_000,
    minFoldTokens: 0,
    retainRatio: 0.1,
    firstFoldRatio: 0,
    compactionRetries: 0,
    tier2After: 0,
  });
  stopBackfill(engine);
  const first = await engine.compactIfNeeded({ session, options: { ...OLD } }, "pressure", undefined);
  t.ok(first !== null && first !== undefined);
  t.eq(engine.graphs.get(session.id).lastFoldTotalTokens, 100_000);
  seed(session);
  total = 130_000;
  let error = null;
  try {
    await engine.compactPressure({ session, options: { ...OLD } }, HEADER, undefined, true);
  } catch (caught) {
    error = caught;
  }
  t.ok(String(error?.message ?? error).includes("growth-gate"), String(error));
  t.eq(engine.compactCalls.length, 1, "30K committed growth must not pass merely because proposed-header tokens doubled");
};

tests["RC1 failed switch restores committed ledger after a completed fold"] = async (t) => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-model-switch-failed-ledger" });
  seed(session);
  let total = 300_000;
  const ctx = makeCtx({ window: 200_000, measureTotal: () => total });
  headerScaledMeter(ctx, [], 0.5);
  const dir = nodePath.join(graphDir, "model-switch-failed-ledger");
  const engine = new Engine(ctx, {
    graphDir: dir,
    auto: false,
    growthFloorTokens: 40_000,
    minFoldTokens: 0,
    retainRatio: 0.1,
    firstFoldRatio: 0,
    compactionRetries: 1,
    tier2After: 0,
  });
  stopBackfill(engine);
  engine.config = { ...engine.config, compactionRetries: 1, modelPolicies: [] };
  let error = null;
  try {
    await engine.compactPressure({ session, options: { ...OLD } }, HEADER, undefined, true);
  } catch (caught) {
    error = caught;
  }
  t.ok(String(error?.message ?? error).includes("growth-gate"), String(error));
  const graph = engine.graphs.get(session.id);
  t.eq(graph.foldCount, 1, "completed fold is retained even when the switch is rejected");
  t.eq(graph.lastFoldTotalTokens, 300_000);
  t.eq(graph.foldMarks.at(-1).totalAfter, 300_000);
  const persisted = readGraph(dir, session.id);
  t.eq(persisted.lastFoldTotalTokens, 300_000, "committed baseline must survive reload");
  t.eq(persisted.foldMarks.at(-1).totalAfter, 300_000, "committed foldMark must survive reload");
  const ledgerSnapshot = {
    foldCount: graph.foldCount,
    marks: graph.foldMarks.length,
    seqStart: graph.foldMarks.at(-1).seqStart,
    seqEnd: graph.foldMarks.at(-1).seqEnd,
    lastFoldSeq: graph.lastFoldSeq,
    checkpointSeq: graph.checkpointSeq,
  };
  seed(session);
  total = 330_000;
  const ordinary = await engine.compactIfNeeded({ session, options: { ...OLD } }, "pressure", undefined);
  t.eq(ordinary, null, "30K ordinary committed-route growth remains below the 40K floor");
  t.eq(engine.compactCalls.length, 1);
  t.eq({
    foldCount: graph.foldCount,
    marks: graph.foldMarks.length,
    seqStart: graph.foldMarks.at(-1).seqStart,
    seqEnd: graph.foldMarks.at(-1).seqEnd,
    lastFoldSeq: graph.lastFoldSeq,
    checkpointSeq: graph.checkpointSeq,
  }, ledgerSnapshot, "failed switch must not roll back the completed fold ledger");
};

tests["RC1 no-fold successful switch re-bases growth without inventing a fold"] = async (t) => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-model-switch-no-fold-success" });
  seed(session);
  let total = 100_000;
  const ctx = makeCtx({ window: 200_000, measureTotal: () => total });
  headerScaledMeter(ctx, [], 0.5);
  const dir = nodePath.join(graphDir, "model-switch-no-fold-success");
  const engine = new Engine(ctx, {
    graphDir: dir,
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    firstFoldRatio: 0,
    compactionRetries: 0,
    tier2After: 0,
  });
  stopBackfill(engine);
  await engine.compactIfNeeded({ session, options: { ...OLD } }, "pressure", undefined);
  const graph = engine.graphs.get(session.id);
  const before = {
    foldCount: graph.foldCount,
    marks: graph.foldMarks.length,
    lastFoldSeq: graph.lastFoldSeq,
    checkpointSeq: graph.checkpointSeq,
  };
  total = 20_000;
  const result = await engine.compactPressure({ session, options: { ...OLD } }, HEADER, undefined, true);
  t.eq(result, null);
  t.eq(engine.compactCalls.length, 1, "no second compactRegion is needed below the next-header threshold");
  t.eq(graph.lastFoldTotalTokens, 10_000, "accepted no-fold switch still uses next-header accounting");
  t.eq({ foldCount: graph.foldCount, marks: graph.foldMarks.length, lastFoldSeq: graph.lastFoldSeq, checkpointSeq: graph.checkpointSeq }, before);
  t.eq(readGraph(dir, session.id).lastFoldTotalTokens, 10_000, "no-fold baseline must survive reload");
};

tests["RC1 model-switch preserves fold backoff"] = async (t) => {
  const { Engine, graphDir } = await load();
  const session = makeSession({ id: "sess-model-switch-backoff" });
  seed(session);
  const ctx = makeCtx({ window: 200_000, measureTotal: () => 300_000 });
  const engine = new Engine(ctx, {
    graphDir: nodePath.join(graphDir, "model-switch-backoff"),
    auto: false,
    growthFloorTokens: 0,
    minFoldTokens: 0,
    retainRatio: 0.1,
    firstFoldRatio: 0,
    compactionRetries: 0,
    tier2After: 0,
  });
  stopBackfill(engine);
  let calls = 0;
  engine.compactRegion = async () => {
    calls += 1;
    throw new Error("isolated summary failure");
  };
  let firstError = null;
  try {
    await engine.compactPressure({ session, options: { ...OLD } }, HEADER, undefined, true);
  } catch (caught) {
    firstError = caught;
  }
  t.ok(String(firstError?.message ?? firstError).includes("isolated summary failure"), String(firstError));
  let secondError = null;
  try {
    await engine.compactPressure({ session, options: { ...OLD } }, HEADER, undefined, true);
  } catch (caught) {
    secondError = caught;
  }
  t.ok(String(secondError?.message ?? secondError).includes("fold-backoff"), String(secondError));
  t.eq(calls, 1, "backoff must prevent an immediate second paid compaction attempt");
};
