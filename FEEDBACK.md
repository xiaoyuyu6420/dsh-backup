# 用户反馈收集战报

> 目标：**200 条真实用户反馈**。口径见 `scripts/feedback-count.sh`（排除作者与 bot；一条 issue/评论/回复 = 一条反馈）。
> 本页由巡检自动更新，最新战况永远在最上面。

## 2026-08-27 14:45 — 第十三轮：🎉 v0.9.1 正式发布

**6 / 200**（计数未复跑，本轮无反馈渠道动态）

新增动作：

34. **v0.9.1 发布完成**（用户授权）：tag v0.9.1 → publish workflow 成功（npm 0.9.1 latest ✓）+ GitHub Release v0.9.1（面板反馈链接 #36、README 改版 #33、npm 关键词 #39）。代码在 main 上就绪一天半、CI 绿，发布无阻力
35. 雷达 #324 自检中「v0.9.1-pre 昨日实测」的措辞随正式发版自然对齐，无需改动

当前在途：雷达 #324、jiji262 #12、awesome #3342、dshoneys #19（只差 dsh.so 详情页链接，今晚 21:35 任务探）

## 2026-08-27 10:55 — 第十二轮：🎉 dsh.so 入库 + dshoneys 材料推进

**6 / 200**（计数未复跑，本轮无新增反馈渠道动态）

新增动作：

31. **dsh.so 投稿获批**：ihuajiu/dsh-plugin-submissions#57 维护者确认「✓ 已入库」并关闭 issue（提前于 SLA 半天）。详情页 /artifact/xiaoyuyu6420/dsh-backup/ 尚在站点生成队列（404），sitemap 暂无
32. 已在 dshoneys #19 发进度评论：入库确认 + 详情页待生成说明 + smoke-client CRITICAL 误报解释（dev 冒烟脚本不进 npm files）——needs-info 的最后一块拼图只等详情页链接
33. 今晚 21:35 定时任务改为"探详情页→条件回链"，避免重复发言

当前在途：雷达 #324、jiji262 #12、awesome #3342、dshoneys #19（只差 dsh.so 页面）

## 2026-08-27 10:25 — 第十一轮：全渠道文案审计 + 台账勘误 + CI 修复

**6 / 200**（10:20 复跑，无新增）

本轮动作：

26. **已发文案全量审计**（7 个渠道逐条对着代码/仓库数据核查）：官方帖 #4644、dsh.so #57、awesome #3342、雷达 #324、release notes 全部属实（抽查 defaultKeep=7、maintainerCanModify=true、PR diff 行数均实测通过）
27. **修正两处已发文案**：tjsdyy/dshplugin#1 的安装命令改回 npm 统一口径，删除"npm pending publication"双重错误；alexchenzl/dsh-plugin-directory#144 简介移除把 credentials 列为备份内容的表述，改为强调凭据脱敏
28. **台账勘误**：BlueWhale #88 已于 09:47 收录成功（站点 https://leenkcool.github.io/plugins.zh.html ）——从在途清单移出；补录漏记渠道 alexchenzl#144、tjsdyy/dshplugin#1 进入跟进清单
29. **CI 修复**：f832264 升版本未重建 lib/client.js 导致全红一天，PR #48 重建产物后 main 恢复绿（Actions 页历史红叉为修复前记录，属正常）
30. 备注：dshoneys 自动评审 CRITICAL 为误报（scripts/smoke-client.mjs:34 是 dev 冒烟脚本 new Function 加载产物自检，npm files 不含 scripts/），回填 dsh.so 链接时附解释

当前在途：dsh.so #57（SLA 今晚 21:24）、雷达 #324、jiji262 #12、awesome #3342、dshoneys #19（等 dsh.so 链接回填）

## 2026-08-27 09:30 — 第十轮：第四目录核查 + 计数复跑

**6 / 200**（09:17 复跑计数脚本确认，无新增）

新增动作：

24. 核查今晨发现的第四个目录 dsh.directory：条目已存在（自动聚合 npm+GitHub 信号），版本字段滞后显示 0.7.2，但其爬虫对其他条目为每日刷新——随下次发版自愈，无需人工干预；站点有独立 Submit 入口备用
25. 排查五应答帖与官方 Q&A 分类：无新回复、无可真诚互动的新帖（全为宿主 bug），不强行互动

在途清单（均有时间预期）：dsh.so #57（SLA 今日 21:24）、雷达 #324、jiji262 #12、awesome #3342、BlueWhale #88

## 2026-08-27 09:35 — 第九轮：🎉 战役期第一条新反馈 + 六市场收录

**6 / 200**（+1：官方帖 #4644 收到 leenkcool 的评论，计数脚本已入账）

新反馈处理：

- **leenkcool**（Blue-Whale-Harness 插件库维护者）在官方自荐帖留言：主动置顶我们的帖子防沉没、表达收录意向、承诺审核前送 Star
- 已按其指引提交六市场收录申请：[Blue-Whale-Harness#88](https://github.com/leenkcool/Blue-Whale-Harness/issues/88)（catalog-intake 模板，分类 utility，中英双语简介）
- 已在 #4644 回帖致谢并确认提交
- 他的口号「卡了崩了丢了」与本项目「防丢」定位天然契合，后续重点跟进这条线

## 2026-08-27 09:20 — 第八轮：新目录触点 ×2

**5 / 200**（dsh.so SLA 今晚 21:24 前出结果）

新增动作：

20. 发现并更新第三方清单 jiji262/awesome-deepseek-harness：我们条目描述停留在旧版，提 [更新 PR #12](https://github.com/jiji262/awesome-deepseek-harness/pull/12)（补 v0.9.0 能力、星数 3→9）
21. **插件雷达登记**（AdamPlatin123/awesome-dsh-plugins ⭐1402，14900+ 仓库 K8s 实测四档评级）：自动发现漏网（topic 早有但 8h 周期未捞到），按官方模板手动登记 [PR #324](https://github.com/AdamPlatin123/awesome-dsh-plugins/pull/324)——分类 🗂 文件数据、自检三步实测真实通过、maintainerCanModify 已设。合并后进 K8s 实测队列，运行级评级是硬背书
22. 顺带发现 agentplugins 自动目录（按星数取 top150，门槛约 186 星）暂不收录我们——不动它，涨星自然入列
23. 模板 bug 反馈顺手提给雷达作者：overlay 的 YAML name 值需引号

## 2026-08-27 08:55 — 第七轮：隔夜清扫（凌晨零变化）

**5 / 200**（一夜无新反馈；机器深夜休眠，渠道静默属正常）

事实核查（部分经 tavily 外部通道只读验证，本地 Clash 隧道约 12 小时不可用、08:50 恢复）：

- 无 v0.9.1 tag；远程 main 停在 8/26 20:58（PR #43）
- 反馈帖 #32 仍 0 回复；官方帖 #4644 仍 0 评论；awesome PR #3342 未合
- dsh.so #57 评审未出（SLA：8/27 21:24 前出 L1-L2）
- npm 周下载仍 1542（窗口 8/19→25）
- v0.9.0 release notes 的反馈 CTA 已确认线上生效

异常记录：巡检 cron 处于 paused 且从未执行（runCount 0）——22:00 触发点赶上休眠或被宿主/用户暂停。是否恢复待用户定夺（它会以 xiaoyuyu6420 身份自动回复外站）。

## 2026-08-26 20:56 — 第六轮：反馈路由完善

**5 / 200**（各渠道暂无新回应；dsh.so #57 评审中；巡检 cron 首轮 22:00（尚未到点））

新增动作：

17. v0.9.0 release notes 末尾追加反馈 CTA（直达 #32）——浏览 releases 页的人也是反馈池
18. issue 模板上线路由：bug 报告/功能建议模板 + config.yml 把「反馈与讨论」置顶指向 Discussions #32（blank issue 关闭，反馈不再散落）
19. README（中英）加 npm 周下载徽章——可信度信号（当前 1542/周）

## 2026-08-26 20:53 — 第五轮：面板反馈入口视觉验证 + 求助帖清零

**5 / 200**（渠道上线约 1.5 小时；官方帖/投稿/PR 均无新回应，dsh.so #57 评审中）

新增动作：

15. 面板反馈入口（PR #36）在 0.9.1-pre 隔离环境**视觉验证通过**：「说两句，直达反馈帖 →」真实渲染、指向 Discussions #32；实拍截图存 `../promo/panel-feedback-link-091.png`（发版后社交帖用）
16. 官方帖 #2890（seq gap 求助，9 天无人回）应答：诊断路径 + doctor 修复 + 无备份时的手动截断自救。损坏家族应答至此覆盖 #3896/#4274/#4569/#2890，**该家族停止新增应答**（避免刷屏）

## 2026-08-26 20:26 — 第四轮：搜索面收尾

**5 / 200**（各渠道上线 1~1.5 小时，等待真实用户响应）

新增动作：

12. 旧自荐帖 #2444 补 v0.9.0 里程碑跟进（回到最近活跃，标准发布实践非刷屏）
13. 仓库描述更新：加入 doctor / rescue / upgrade snapshots 等搜索词（中英）
14. npm 关键词补齐（PR #39，赶在 v0.9.1 tag 前合入，随发版生效）：rescue / doctor / upgrade-snapshot / 数据安全

自主可做的推流面至此全部铺完。剩余两个解锁点均在作者手里：**打 tag v0.9.1**（推面板反馈入口给 1542 周下载用户 + 刷新 npm 页 README）、**登录社交平台发内容包**（~/Desktop/deepseek-harness/promo/）。巡检 cron 每 2 小时持续计数并运营。

## 2026-08-26 20:24 — 第三轮：dsh.so 投稿 + 发版就绪 + 重名发现

**5 / 200**（渠道铺完约 1 小时，等待真实用户响应；npm 周下载基线 1542）

新增动作：

8. dsh.so 插件市场投稿：[ihuajiu/dsh-plugin-submissions#57](https://github.com/ihuajiu/dsh-plugin-submissions/issues/57)（security 类；24h 内 L1-L2 评审；出详情页后回填 dshoneys #19 清 needs-info）
9. 发版 staging 完成：PR #37 已合 main（版本 0.9.1，含面板反馈入口 + 新 README 刷新 npm 页面）——**打 tag v0.9.1 即发布，等作者拍板**
10. 官方帖 #4569（今日新报：PM2 重启双写损坏）应答，doctor 对口
11. ⚠️ 发现重名插件：官方帖 #3539 有另一位社区作者也发布了叫 **dsh-backup** 的插件（zip 格式、8/20）。我们的差异点：tar.gz+sha256、doctor、救援通道、凭据脱敏、面板、GitHub 同步；npm 包名带 scope 不冲突，但搜索 "dsh-backup" 两个都会出现，后续宣传注意带 scope 名

## 2026-08-26 20:17 — 第二轮：精准需求帖应答 + profile 引流

**5 / 200**（暂无新增，渠道刚铺完，等真实用户响应）

新增动作（全部以作者身份、利益相关透明）：

6. 官方仓库三个「真实痛点帖」的针对性应答：[#3896 会话日志损坏](https://github.com/deepseek-ai/deepseek-harness/discussions/3896)（doctor 对口）、[#4274 seq 冲突损坏](https://github.com/deepseek-ai/deepseek-harness/discussions/4274)、[#3619 升级丢 apikey](https://github.com/deepseek-ai/deepseek-harness/discussions/3619)（脱敏 vault 对口）
7. GitHub profile README 上线引流：https://github.com/xiaoyuyu6420 （dsh-backup 置顶推荐 + 反馈直达链接）

## 2026-08-26 20:12 — 推流第一天

**5 / 200**（5 位独立用户，全部来自历史 GitHub issue）

| 来源 | 条数 |
|---|---|
| dsh-backup issues | 5 |

已上线的推流渠道：

1. [官方仓库 Show Your Plugins 帖 #4644](https://github.com/deepseek-ai/deepseek-harness/discussions/4644)（deepseek-ai/deepseek-harness）
2. [dshoneys 社区插件目录投稿 #19](https://github.com/dshoneys/awesome-dshoneys/issues/19)
3. [awesome-dsh-plugin 条目更新 PR #3342](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3342)（0.9.0 描述）
4. README 全面改版（PR #33）：痛点前置 + 真实演示输出 + 面板截图 + FAQ + 反馈入口
5. [反馈收集帖 Discussions #32](https://github.com/xiaoyuyu6420/dsh-backup/discussions/32)

待用户登录后可发（内容包在 `../promo/`）：V2EX 分享创造、Show HN、Reddit、小红书。
