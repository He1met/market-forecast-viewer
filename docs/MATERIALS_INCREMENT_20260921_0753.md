# 2026-09-21 07:53 增量材料

[Issue #44](https://github.com/He1met/market-forecast-viewer/issues/44)跟踪本批。业务窗口为上海时间05:53之后至07:53（含截止）；一致性快照实际采集于08:17:29，保留原修改时间，前后业务文件摘要一致，业务互斥占用约3.1秒。下列附件已在本地准备完成，尚待独立检查与公开发布，不能当作已可下载。

## 已核事实与覆盖

- 06:18、07:19两次自然巡检的原始started/result均纳入；06:18确认最新时段present、发布状态current，历史缺失仍保留。[原报告](https://github.com/He1met/market-forecast-viewer/issues/15#issuecomment-5753095880)。
- 第二期自然预测于07:52:24.887发布，两期不同自然时段的有效预测分项达到2/2。原始行情、完整模型输入/输出、尝试与发布收据、slot及派生记录均有实际对象。[唯一核验报告](https://github.com/He1met/market-forecast-viewer/issues/15#issuecomment-5753680162)。
- F0/F1完整成熟配对仍为1/20、决定waiting；登记2、启动1、结束1。实际服务模型身份仍为`not_exposed_by_jsonl`，配置名称不代替服务身份证据。自然备份/恢复、通知、用户体验及方法效果没有因此通过。

| 范围 | 本批结果 |
| --- | --- |
| 允许业务来源 | 17个根、3,256文件逐路径和原SHA比较；72新增、5变化，共2,283,618原始字节 |
| 未变业务来源 | 3,179条引用三个基础manifest；无截止版本缺失 |
| 直接相关开发材料 | 明确列出22份交付、验收与自然核验材料，21新增、1引用；实际捕获时间见development inventory，晚于业务截止 |
| 合计 | 104条内容映射、93个对象，4,825,580发布对象字节；排除/阻塞/未知均为0（仅指本批允许输入） |
| 基础关系核验 | 3,180条引用、2,711个基础对象重新核验；5个变化文件保留原件与发布件的新旧SHA |

变化文件为derivatives/latest、projections/index及forecast、last-forecast-success、ops任务状态。私密协调身份根m1-control、已迁移m1-runtime及凭证/私密安装配置不在允许输入范围。原档保留，文字与嵌套字段经净化；本批无新增图片或需要例外放行的编码内容。

开发源是本批明确的22个文件，不表示全量开发历史。快照脚本、构造脚本、采集收据和处理范围另记业务截止后的生成时间；GitHub验收回读是当前捕获，不伪装当时业务收据。源覆盖核验104/104无遗漏，基础链审计通过。

## 附件与读取关系

本地待发布附件：

| 附件 | 大小（字节） | SHA256 |
| --- | ---: | --- |
| materials-01.zip | 4,897,286 | `2412209e2a2263a9ef63f4f69f8ae459de95423bcaacf9e194b474bb4068d8f7` |
| volumes.json | 8,208 | `c196f27042000b4aa9696b1361cbf5be063c815942e4743a67c4c8329a2d89c5` |

本批manifest：`3701ca6a2902ad7f27c99f94f393ee775b35cd362593647fe7b664a238b9aa25`。总附件4,905,494字节。

读取时各组解压到独立目录，保留四份manifest：

1. 首批核心core：`48c174ec2136103021c198ec5e33bfdb3f4b16231ebd19360958382c2fbb7ed3`。
2. 首批审计audit：`c85a56423ea3043d9724ca43d17852eef945efc9c93a134f9412f53097fde75b`。两者均见[首次Release](https://github.com/He1met/market-forecast-viewer/releases/tag/materials-20260921-041032)。
3. 上批increment_055300：`c83ae19a9cce62aec2312096411af6f212366a984cd348f1ceb5d5b773a2b1af`，见[05:53增量](MATERIALS_INCREMENT_20260921.md)。
4. 本批07:53增量：新增内容由本manifest映射至objects；不变内容按inventory的previous.base_manifest、previous.path及export_sha256到对应基础目录读取。

业务路径比较时，将上批`increment/installed-data/`映射为统一的`installed-data/`，并以它覆盖更早版本；previous.path始终保留原发布路径。04:18审计收据的别名也保留。变化文件的新旧版本都可追溯，不覆盖任何旧manifest或资产，也不能把净化副本作为生产恢复包。

本批仅归档与更新文档；业务包仍f5a0cc24/build27ee306，材料代码基线为main d9d260c。没有额外模型调用、补时段、切包或频率调整。截止后自然记录留后批。
