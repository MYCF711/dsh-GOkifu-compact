## 这个 PR 修/加了什么



## 根因（修 bug 必填）



## 验证

```bash
node test/run.mjs                        # 必须串行：并发会抢 test/.harness ⇒ 假红
node scripts/boundary-audit.mjs          # 越界线索必须 0 条
node scripts/sync-doc-numbers.mjs --check # 加了测试 ⇒ 这里会点名「文件:行号」
```

- [ ] 新增/修改了测试（修 bug 时**必须**有一条会红的用例，否则下一个人会改回去）
- [ ] **加了测试 ⇒ 跑了 `node scripts/sync-doc-numbers.mjs --write`**
      （`passed` 数变了，C167 / C172 / C485 三条守卫会红；手改文档会被下一次 `--write` 覆盖）
- [ ] 改了 `README.md` / `QUICKSTART.md` 里教的命令 ⇒ 命令真实存在（`docs-commands` 门禁会拦）
- [ ] 改了模型可见文本（热清单 / 摘要指令）⇒ 没写进行动指导（`boundary-audit` 6 条规则）
- [ ] 改了 `cordis.patch.yml` ⇒ 它是**生成物**，由 `node scripts/make-presets-override.mjs --write` 重生成
- [ ] 版本号一致（`package.json` / README 版本行 / `CHANGELOG.md`）

## 影响面

- 是否改变压缩默认行为：
- 是否影响已落盘的 `graph.json` / `graph.json.delta.jsonl` 格式：
- 是否需要重启 DSH 才生效（**服务端 `src/**` 改动必须重启**；客户端 `lib/client.js` 刷新即可）：
