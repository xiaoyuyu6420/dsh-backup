# dsh-backup 0.14.4 · Windows 备份恢复措施与目录排除修复

本版发布 [PR #141](https://github.com/xiaoyuyu6420/dsh-backup/pull/141) 的修复，基于合并提交 `28418b3`。归档格式和宿主版本声明不变。

## 修复内容

- Windows 备份进程以 `3221225477 / 0xC0000005` 退出时，结束原进程树、删除未完成归档，再通过宿主管理的 Node 启动器运行同一个 tar，最多重试一次。
- 启动器保留原参数、工作目录和宿主处理后的环境；子进程仍受 Windows Job 管理。用户取消及其他错误不触发重试；失败归档不会发布校验边车或轮换掉旧备份。
- 失败诊断补充十六进制退出码、程序路径和已写入字节数，stderr 为空时明确标注。
- 修复 Windows GNU tar 对含方括号等字符的备份目录排除失效，避免将内部备份目录和 vault 再次打包。

## 已验证与限制

- Windows Server 2025（10.0.26100）、Node 24.22.0、真实 DSH subprocess-local 0.2.1-rc.3 的 `windows-job`、GNU tar 1.35：3308 MiB 数据及 54000 个小文件，五种启动路径均生成约 3.47 GB 归档。文件清单、排除规则、Unicode 文件名、解包后的样本 SHA-256、访问冲突故障注入后的恢复、取消孙进程均通过。[测试证据](https://github.com/xiaoyuyu6420/dsh-backup/actions/runs/42735458629)。
- Node 20/22 CI 通过；恢复与启动器测试 18 项、安全与恢复回归 27 项。
- 最新 DSH 0.2.2-rc.1 的 Linux 真实宿主集成 71/71 通过。
- **原用户的 Windows 11 GNU tar 崩溃没有复现，底层根因和原机器上的修复效果仍待确认。** 故障注入验证的是恢复机制，不等于复现现场故障。
- 未验证完整 Windows TUI、macOS、真实云同步或人工浏览器操作。测试全部使用合成数据。

## 安装

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@0.14.4
```

安装后若面板仍显示旧版本，请重启 DSH。
