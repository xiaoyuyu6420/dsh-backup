# dsh-backup 0.14.2 · 复核修复版

## 一句话

对 0.14.0/0.14.1 做了两轴(规范 + 规格)独立复核,本版修掉复核发现的问题:**加密不再整包入内存、写盘改为临时文件后原子替换**,并补齐文案/契约/守门测试。

## 修了什么

**数据安全(最高优先级)**

- 加密与解密改为**分块流式**(`encryptFile` / `decryptFile`),归档不再整包入内存 —— 大归档不再撞 Buffer 上限。
- 写盘一律「先写临时文件 → `rename` 原子替换」:加密时明文原件在替换成功前完好;中途崩溃/OOM 只会留下完整明文或完整密文,**不会出现半截密文**。解密失败会删掉半截明文再抛人话报错。
- 恢复侧解密同样流式,不再先 `readFile` 整包密文。
- 回归断言(新增 7 条):无 `.enc-*.tmp` 残留、边车 `ciphertextSize` 与实际密文一致、口令错误后无 `.decrypt-*` 半截明文、6MB 多块往返一致。

**契约与守门**

- `setGithubToken` 补上客户端 descriptor —— 面板早就在调它(`src/tab.jsx` 的 GitHub token 输入),但没有 descriptor,实际是断链。
- 新增**反向断言**:面板调用的每个方法都必须在 descriptors 里(此前只断言 descriptor ⊆ panel,#97 的镜像面没守住)。
- `redactSyncChannel` 补花括号:此前 `out.username` / `out.passwordSet` 会无条件执行,导致 s3 / gist 通道在 `syncStatus` 里出现假的 `passwordSet: false`。
- 移除生产路径里的测试故障注入钩子(`DSH_BACKUP_IMPORT_FAIL`,无任何测试使用)。

**诚实的文案**

- 聊天记录导入的中英文案补上 Codex(`Claude Code / Codex`,路径含 `~/.codex/sessions`)。
- 导入预览不再承诺「界面上逐项选择覆盖」(面板实际固定「保留本机」);改为如实写「默认保留本机,不改动已有文件」。
- README / 对齐文档把多通道同步写清为**单向推送**(跨机恢复走 GitHub 通道拉取或 ZIP 导入),并标注 Gist 单文件 10MB 上限。
- About 卡补「反馈问题」入口(直接开 issue)。
- `rescue sessions repair --fix --map` 会改写会话 header 的 `cwd`(动用户日志),现在必须显式加 `--yes` 才执行,不加时拒绝并零写入。
- `scripts/acceptance-notes.md` 里陈旧的验收数字(578/66、411/32)同步为当前值。

## 验收

| 套件 | 结果 |
|---|---|
| smoke(宿主零依赖桩) | 596/596(Windows 583) |
| settings | 47/47 |
| client bundle | 62/62(44 个端点) |
| 真机 e2e(DSH 0.2.1-rc.2,从打包产物安装) | 70/70 |

## 装

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@0.14.2
```

## 复核中确认但**本版未动**的项

- 多通道同步仍是**单向推送**(WebDAV / S3 / Gist 无 pull/restore;只有 GitHub 通道能拉取)。要不要补拉取能力,是功能决策,不是补丁。
- 配置导入的「逐项决策 / 路径 remap / 市场节段选择」后端支持、面板未接 → 本版只把文案改诚实,没做界面。
- 若干坏味道(重复的 zip 头解析、三处存档名→日期解析、`BackupTab` 1400 行十类职责)按重构处理,不放进补丁版。
