# 2026-09-21 05:53 增量材料

[Issue #42](https://github.com/He1met/market-forecast-viewer/issues/42)跟踪首次公开归档后的这一批真实增量。业务截止为上海时间2026-09-21 05:53:00；业务来源在06:05:39短暂一致性快照中采集，保留源修改时间，只纳入截止内版本。两附件已通过[精确独立审查](https://github.com/He1met/market-forecast-viewer/pull/43#issuecomment-5753082324)，于06:22:44公开。全部实际下载后的SHA256/大小核对通过，总计11,040,261字节；06:23匿名访问Release及两下载链接全部HTTP200。源码文档最终交付见[PR #43](https://github.com/He1met/market-forecast-viewer/pull/43)。

## 本次事实

- 04:29备份在业务入口前因身份环境缺失停止；04:31修正官方任务身份核对规则。入口没有被调用，因此没有业务备份收据，不补造run_id或backup_id。[原记录](https://github.com/He1met/market-forecast-viewer/issues/39#issuecomment-5752482635)。
- 05:19自然巡检完成，10项核对通过；完整成熟配对达到1/20，决定仍为waiting。[样本记录](https://github.com/He1met/market-forecast-viewer/issues/15#issuecomment-5752746137)。
- 05:52:48新f5包自然发布首期valid预测，当前自然预测验收1/2；仅一次attempt，模型实际服务身份仍未由JSONL暴露。[发布记录](https://github.com/He1met/market-forecast-viewer/issues/15#issuecomment-5752968392)。

## 覆盖与基础关系

| 范围 | 本次处理 |
| --- | --- |
| 业务来源 | 17个允许根内3,184个文件逐路径和原始SHA核对；新增197、变化6，实际新版本共8,717,506字节 |
| 不变业务资料 | 2,981条引用首次归档，包括已在首批审计附件中的04:18两份巡检收据，不重复上传 |
| 相关开发交付与任务修正 | 明确列出的31份原材料中23份新增、8份引用基础已有字节；不是重新扫描或重打全部开发历史 |
| 入口前停止依据 | 本批新采集官方已完成任务的消息/命令元数据，以及自动化追加日志中的当时片段；记录现在的采集时间和片段哈希，不冒充当时生成的业务收据 |
| 本批处理依据 | 快照与增量构造脚本、采集收据、范围和两处普通字面量的检查记录；这些是业务截止后生成的处理材料 |
| 合计导出 | 236条内容映射、203个去重对象，发布对象共10,853,790字节；无未处理的图片、编码或未知内容 |

六个变化文件是calendar、derivatives和projections的派生入口，以及forecast、last-forecast-success和ops任务状态；清单分别保留旧原SHA、旧发布对象、新原SHA和新发布对象。2,989条基础引用逐项匹配首次核心/审计manifest，并重新核验2,547个不同基础对象。无本批截止版本不可取得的业务路径；以后若出现这种情况必须明确缺失，不能把新版本当旧版本。

私密协调身份的`m1-control`与已迁移的`m1-runtime`不在允许来源内；凭证、私密安装配置、依赖和缓存不进入本批。源快照的整体保护摘要计数包含不同范围，不能代替上表允许来源计数。文字、嵌套字段和任务材料均经净化；原始文件不改写。

## 下载与读取

本批使用已公开的[独立增量Release](https://github.com/He1met/market-forecast-viewer/releases/tag/materials-increment-20260921-055300)。

| 附件 | 大小 | SHA256 |
| --- | ---: | --- |
| [materials-01.zip](https://github.com/He1met/market-forecast-viewer/releases/download/materials-increment-20260921-055300/materials-01.zip) | 11,022,812字节 | `c9422c83fb8c61c3e50cc93f16fc69259d5867df5eae811db939a266b063f476` |
| [volumes.json](https://github.com/He1met/market-forecast-viewer/releases/download/materials-increment-20260921-055300/volumes.json) | 17,449字节 | `c2c38eee4de3de0ec22bd5d667e25f25913bcee7f6560b05fbbae0b7c72a3eb3` |

增量manifest SHA256为`c83ae19a9cce62aec2312096411af6f212366a984cd348f1ceb5d5b773a2b1af`。请解压到一个新的文件夹，不覆盖[首次归档](https://github.com/He1met/market-forecast-viewer/releases/tag/materials-20260921-041032)的manifest。新内容按增量manifest指向objects；未变内容按业务/开发inventory里的`previous.base_manifest`、原逻辑路径和发布对象SHA，在首次核心或审计目录查找。变化文件保留两版映射，不能把这些净化材料用于生产恢复。

本次仅同步材料与状态，不切正式f5运行包、不调用模型、不补旧时段、不改变模型或频率。截止后的新自然轮进入后续批；自然备份/恢复、通知、页面体验和方法效果仍各自验收。
