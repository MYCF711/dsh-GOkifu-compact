# dsh-GOkifu-compact · 项目规范

## 这是什么
DSH（DeepSeek Harness）的上下文压缩后端插件。核心不是「把历史缩成一段摘要」，
而是「把历史存成一张可回溯、可判重、带失败记忆的棋谱 DAG」，并为模型每轮重建
一份极小的热上下文（根目标 + 当前路径 + 已知失败边清单）。

## 硬规则（会改变行为的）
- **不改 DSH 安装目录**（`D:\DeepSeek Harness\resources\`）。插件经官方 profile 通道安装。
- **动 profile 前先备份**：`profiles/<name>/cordis.patch.yml`、`package.json` 各留
  `.bak-before-chess-context-<ts>`。
- **不删除任何非本会话创建的文件**；要清只进 `.trash/<date>/`。
- 提交前必须跑：`node test/run.mjs`（全部单测）+ `node test/verify-install.mjs`（挂载校验）。
- 不把任何密钥写进代码或文档。本插件不需要密钥。
- **npm 只发稳定版**（`x.y.z`，不带 `-rc` / `-beta` / `-stage` 后缀）；预发布只走 GitHub tag / Release。
- 压缩后端**只能是单实例**：挂载本插件时必须 disable `@deepseek-ai/dsh-compaction-basic`，
  否则两个 `ctx.compaction` 冲突。

## 怎么跑
```bash
# 单测（纯 Node，无需 DSH）
node test/run.mjs

# 从 asar 取官方包对照
node /d/主工作区/archive/bili/read-asar.mjs "D:\DeepSeek Harness\resources\app.asar" --list

# 装到 desktop profile（先备份！）
cd "D:/DeepSeek Harness/home/profiles/desktop" && cp -a cordis.patch.yml "cordis.patch.yml.bak-before-chess-context-$(date +%s)" && cp -a package.json "package.json.bak-before-chess-context-$(date +%s)"
```

## 已知陷阱
- `dsh-compaction-basic` 的 `summarize()` 是**唯一官方认可的子类钩子**；`compactRegion` 的
  事务（锁、稳定性校验、工具对平衡）不要自己重写 —— 继承它，覆盖策略层。
- 压缩每次都会把「上一次的 checkpoint 消息」再摘要一遍 → 保留率几何衰减（ρ^k）。本插件
  必须改成**增量 fold**（只压上一个 checkpoint 之后的内容），这是相对官方实现的核心修复。
- `cordis.patch.yml` 的 patch 打不中目标时**只 warning 不报错**（dsh-app-boot）。改完必须
  用 `dsh --dump-config` 或启动日志核对。
- `complete: true` 的 section 会整体替换 sections，吞掉其它段 —— 本插件不使用 section。

## 目录约定
```
src/      引擎与规则（纯函数优先，便于单测）
test/     单测 + 挂载校验，全部可脱离 DSH 跑
docs/     方案书 / 计划表 / 任务书 / 测绘报告 / 市场对标
evidence/ 实测证据（token 数字、日志片段、压缩前后对照）
```
