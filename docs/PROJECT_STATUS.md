# 项目状态快照

**最新自然事实截至2026-09-21 07:53（上海时间）**：当前f5包已于05:52和07:52完成两个不同自然时段的有效发布，自然预测分项2/2通过；07:19巡检后完整成熟配对仍1/20、waiting。自然备份/恢复、通知、用户页面体验和方法效果仍分别待验。[自然核验报告](https://github.com/He1met/market-forecast-viewer/issues/15#issuecomment-5753680162)。

[07:53本批增量](MATERIALS_INCREMENT_20260921_0753.md)包含06:18、07:19巡检及第二期预测，两附件已于08:28:45独立审查后公开，完整下载SHA/大小和匿名访问均通过。[05:53上批](MATERIALS_INCREMENT_20260921.md)已验收关闭，原八附件不改写。以下保留较早采集层次，均按各自时间理解。

部署采集于2026-09-21 03:29，调度修正核实于03:54，自然巡检截至04:18，备份身份修正截至04:31（上海时间）；此页是有时间标记的快照，不是实时监控。

| 项目 | 已核实状态 |
| --- | --- |
| GitHub业务实现基线 | `27ee30632a28230cbaa3bb5609841906763d3dc4`，PR #37已合并；资料工具/状态页另见[PR #41](https://github.com/He1met/market-forecast-viewer/pull/41)，不代表再次切换业务包 |
| 正式安装包 | `f5a0cc24ff05883775e4c4768b08a29f320f7d98b42b764f5d4c9c7af817f21e`，来自上述main |
| 页面服务 | 本机5178健康检查通过 |
| 定时任务 | 四任务ACTIVE；03:49预测因旧包身份提示在入口前停止，03:54修正三个业务任务提示，模型/频率不变；04:18新包自然巡检通过，预测/备份仍待新成功 |
| 本次修复 | CLI兼容、完整备份性能、未调用候选的准确展示 |
| 完整恢复验证 | 切换前10802文件、追加判定记录后10813文件逐字校验通过 |
| 当前资料交付 | Issue #40：六个实际附件已于05:08全部下载校验通过并公开，共1,087,127,379字节；源码与文档的审查/合并记录见[PR #41](https://github.com/He1met/market-forecast-viewer/pull/41) |

PR #41已合并为资料代码基线`3925f6e7da5fc184d153524298c26e0d4f979fc1`，Issue #40首次交付已独立验收关闭；Issue #42已独立验收、PR #43已合并为资料基线`d9d260c4c5df5c2e8804a0bad2a9de478737ff87`；当前[Issue #44](https://github.com/He1met/market-forecast-viewer/issues/44)同步07:53这批材料与状态。资料代码和正式安装包版本不同，不代表需要再次切换业务包。

依据：[PR #37](https://github.com/He1met/market-forecast-viewer/pull/37)、[正式部署报告](https://github.com/He1met/market-forecast-viewer/issues/39#issuecomment-5752101950)、[独立复核与原调度恢复](https://github.com/He1met/market-forecast-viewer/issues/39#issuecomment-5752109550)。

03:49停止轮没有调用业务入口或模型，没有补跑旧时段。任务ACTIVE本身不能证明业务恢复。之后每次切换须同时核对任务提示、current指针和封存manifest的当前身份。[遗漏及修正记录](https://github.com/He1met/market-forecast-viewer/issues/39#issuecomment-5752269860)。

## 模型、频率与研究进度

- 正式预测使用 `gpt-6-astra / medium`，每两小时一次（上海时间奇数小时47分）；F1候选每天01:47登记比较机会。开发任务每小时00分，巡检每小时17分，备份每天04:27。任务配置时间与实际自然触发结果分开记录。
- 当前比较方案 `dcb11642-f665-4a4f-955d-fdb4ab8de4e9`：F0不使用反馈，F1使用反馈，其他模型和设置相同。至少20个完整成熟配对，最多30个已结束机会，主要指标改善门槛5%，及时有效比例门槛90%。20是可比较样本数量门槛，不是等待20个日历日就自动验收。
- 03:39正式数据快照内，最近一次研究判定来自03:18巡检：登记2次、启动1次、结束1次、完整成熟配对0，结论仍等待。该记录属于旧721包；新包修复后还需自然巡检更新，不能把旧判定当作修复后的最新效果。
- 同一快照的历史正式预测索引共32期，27期有效发布、5期失败，15期已核实24小时成熟；最近成功发布时间为9月20日23:52:47。它们横跨历史安装包，不算新f5包的自然成功记录。最新任务记录仍含旧包预测失败、巡检部分完成和自然备份超时，维护时人工备份通过没有覆盖这些失败。

04:18新包 `f5a0cc24` 的自然巡检 `cdf4c4c8-9b5a-4868-bd1a-a6bbae4c2686` 已完成，10项结果核对全部通过，未解决项为空。旧未调用候选被正确排除评分，历史预测失败仍保留。[自然巡检报告](https://github.com/He1met/market-forecast-viewer/issues/39#issuecomment-5752418721)。该轮研究判定仍为登记2、启动1、结束1、完整成熟配对0；缺报提示和待发送通知不等于预测已恢复或通知已送达。

这些数值来自带时间的固定资料快照和单独的04:18巡检补充，后续新增运行材料按增量归档；不为更新展示而额外调用模型。

04:29–04:30自然备份未进入业务入口，原因是shell未传任务身份。04:31监督侧补充了官方当前任务元数据唯一匹配规则；不从标题或旧记录猜身份，不改全局环境，未补跑该次备份。[停止及修正记录](https://github.com/He1met/market-forecast-viewer/issues/39#issuecomment-5752482635)。此项晚于固定材料采集边界，原证据进入后续增量。

## 仍待验证

以下任务职责以各自注明的交付时点为准；#40/#42已关闭，#44为当前材料批次。Issue开放不等于代码尚未开发，也不等于都在等待用户批准。

| 对应任务 | 下一步 | 负责方 |
| --- | --- | --- |
| [#12](https://github.com/He1met/market-forecast-viewer/issues/12)、[#13](https://github.com/He1met/market-forecast-viewer/issues/13)、[#32](https://github.com/He1met/market-forecast-viewer/issues/32) | 在当前页面操作历史切换、图表、概率、依据与结果；具体位置见[页面验收清单](CURRENT_ACCEPTANCE.md#页面可操作项目) | 用户反馈实际体验；发现问题由实施侧修复 |
| [#34](https://github.com/He1met/market-forecast-viewer/issues/34) | 保留已通过的工程与维护恢复证据，继续核对自然备份及恢复 | 原频率任务运行，监督侧核验 |
| [#36](https://github.com/He1met/market-forecast-viewer/issues/36)、[#38](https://github.com/He1met/market-forecast-viewer/issues/38)、[#39](https://github.com/He1met/market-forecast-viewer/issues/39) | PR #37修复已合并、部署；按实际部署和后续自然回执完成对应工程归档 | 监督侧核对并管理关闭，不要求用户重复做代码审查 |
| [#44](https://github.com/He1met/market-forecast-viewer/issues/44) | 07:53材料增量审查、发布与文档交付；此前#40/#42已验收关闭 | 实施侧交付，监督侧独立核验 |
| [#10](https://github.com/He1met/market-forecast-viewer/issues/10)、[#15](https://github.com/He1met/market-forecast-viewer/issues/15) | 汇总页面、自然运行、通知和反馈比较各项验收 | 监督侧管理；用户负责页面体验和通知确认 |

- 当前f5包两个不同自然时段发布分项已于07:52通过（2/2）；后续各轮仍按真实收据核验，不代表永远成功。
- 自然备份、自然恢复、通知可见性，以及当前页面的用户操作验收。
- F0/F1方法效果：原20个完整成熟配对、最多30个已结束机会的规则不变。登记、实际调用、完整成熟配对和最终决定分开统计，未调用不计成功配对。
- 首次资料附件交付及远端校验已完成，见[材料索引](PUBLIC_MATERIALS.md)；后续新增运行证据按实质变化增量同步。

工程部署成功不代表预测准确、盈利或可以交易。历史失败保留，没有补跑旧时段；旧721包不支持新增判定记录，不能带新记录恢复旧包业务。
