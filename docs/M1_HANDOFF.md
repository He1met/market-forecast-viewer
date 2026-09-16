# M1 候选交付与切换核对单

## 2026-09-16 实机安装阻断更新

精确main94ae6e5的46afddca候选获用户安装/受控验证批准后，实际deploy因缺少tsx失败，尚未激活。锁文件生产依赖分类错误导致`npm ci --omit=dev`遗漏tsx/esbuild；先前package CI从开发目录祖先依赖回落解析，未证明独立可运行。下面历史哈希/CI记录保持原义，但不再作为部署就绪结论。INSTALL-DEPENDENCY-01返修、隔离验证和独立审查完成后须重新构建精确新main候选并绑定激活身份；原包不可临时补依赖后沿用旧批准。429旧档保护/迁移哈希一致，原档和失败证据保留；真实单轮、自然运行、方法效果仍NOT_VERIFIED。

## 2026-09-16合并权限更新

用户直接授权“合并，项目以后可以自行合并”。PR #7已审head `9862f7513cfef73625afadf9428f53feaf7bd549` 已squash合并为 `2c901c9738ccc30aec72fa385b9727788113ca23`，树内容一致。后续范围内变更通过必要测试和独立审查即可自主合并，不再等待重复合并决定。下面候选/审查记录保留其时点；合并后main的CI及新候选身份另绑定实际收据，正式激活仍需main精确包/配置确认。

## 当前结论

本表为 Issue15 的交付准备，不是维护者批准。代码审查基线为 `27699ffdacaedfbc1820f40bccfa52150b2769fa`，PR #7，分支 `feat/chart-mvp`。独立审查确认 FINAL-01 的具名维护入口缺口为 CODE_FIXED_REVIEWED，FINAL-02..06 为 FIXED_VERIFIED，原六项代码问题已解决；最终交付与运行验收未完成。安装版真实单轮、自然运行、方法效果分别为 NOT_VERIFIED。本次文档修订属于后续增量，其提交、CI及候选包需重新绑定，不能沿用上述 SHA 的批准。

该代码基线 CI `35059135212` 的 quality、runtime-package、browser、ci-required 四项成功。独立审查核对171个跟踪文件、676个候选清单文件、manifest/source archive/保全哈希匹配，未重跑测试。候选 release `beea1a27392f3948c532ceb276e7d11c27622be66e53debab79ca17c18948983` 为 non-synthetic / darwin arm64 / Node22，尚未批准或安装；此处仅记录修订前候选，后续精确身份在 LOCAL_ONLY 交付收据中重新绑定。

原 tar 含719个 AppleDouble 元数据普通文件，另有677个真实payload文件（含manifest）；原档保留，不能称为直接可移植恢复包。已另产无扩展元数据的便携tar，在新隔离目录解包后只读 verifyPackage 确认精确676文件加manifest，未放松文件集合校验。最终新候选同样需要独立便携保全及解包验档。原始证据、任务正文快照及安装绝对路径仅 LOCAL_ONLY。

## 调度现状与目标差异

以下为 2026-09-16 本轮本地配置文件回读。官方 view 只返回任务卡，未向模型返回时区或下一次触发时间，不能称为这些字段已获官方回读。

| 职责 | 实际状态 | 目标及剩余动作 |
| --- | --- | --- |
| 开发 `chart-mvp` | ACTIVE；每小时00分；gpt-6-astra/medium；Local主checkout | 方案写每小时12分；现有配置由监督侧维护，本轮保留设置并回报差异 |
| 预测 `m1` | ACTIVE；奇数小时47分；gpt-6-astra/ultra；仍绑定旧checkout入口和旧release | 本地维护 PAUSED 标志存在；切换时复用ID，改为已批准安装版forecast入口，先保持官方任务暂停 |
| 巡检 `m1-ops` | 本地任务清单未发现对应职责项，尚未创建 | 每小时17分；安装版ops；初次创建PAUSED，保存真实ID |
| 备份 `m1-backup` | 本地任务清单未发现对应职责项，尚未创建 | 每日04:27；安装版backup；周日由脚本追加恢复自检；初次创建PAUSED |

预测任务 ACTIVE 与业务运行获准是两件事；当前保护由旧运行入口的维护暂停文件承担。不得据 ACTIVE 删除该保护。旧任务外层 ultra 和新包生成策略 medium 也分别记实，不把二者混为同一模型配置。

## 可审查任务正文

以下是尚未应用的完整正文模板。安装收据确定真实 `RUNTIME_HOME` 后，以绝对路径替换占位符并保存正文 SHA；含占位符的正文不能安装为可执行任务。保留各任务原有模型、权限和通知设置；新任务的模型设置须在配置材料中单列，不能隐式继承生成模型配置。

### 预测任务

读取本自动化 memory 和已核验安装收据，仅在收据绑定的 RUNTIME_HOME 工作。核对稳定启动器、current release 与维护者精确批准；身份或路径不一致停止并保留证据。只执行 `MFV_TRIGGER=scheduled MFV_TASK_ID=REAL_TASK_ID node RUNTIME_HOME/launch.mjs RUNTIME_HOME forecast`；人工试跑改用 manual，记录真实任务ID、CODEX_THREAD_ID及实际触发，缺身份不编造。不得执行开发、Git、模型替代回答或独立prepare/generate，也不得重复调用脚本重抽预报。有限重试和slot由脚本负责。读取结构化结果，分别保存old_results与新预报状态；迟到、缺数、失败不填零。暂停或锁忙安静结束，不清锁、不停止未知进程。异常中断保留实际进程身份与恢复信息。完成后按下述通知规则读取摘要并更新memory。不得修改代码、安装指针、批准文件、原始档案或其他任务。

### 巡检任务

读取本自动化 memory 和已核验安装收据，仅在收据绑定的 RUNTIME_HOME 工作。核对稳定启动器、current release 与维护者精确批准；不一致停止并保留证据。只执行 `MFV_TRIGGER=scheduled MFV_TASK_ID=REAL_TASK_ID node RUNTIME_HOME/launch.mjs RUNTIME_HOME ops`，人工试跑用 manual，并记录真实任务/线程/触发。读取结构化状态及未完成游标；partial不写成completed。不得调用预测模型、修改源码/提示词、操作Git、清理未知锁或进程。程序负责有界补核对、案例/比较、附加输入、索引和已确认自有服务恢复；不在脚本之外重复重试。按下述通知规则读取摘要并更新memory。暂停或锁忙安静结束；不得解除业务或服务暂停。

### 备份任务

读取本自动化 memory 和已核验安装收据，仅在收据绑定的 RUNTIME_HOME 工作。核对稳定启动器、current release 与维护者精确批准；不一致停止。只执行 `MFV_TRIGGER=scheduled MFV_TASK_ID=REAL_TASK_ID node RUNTIME_HOME/launch.mjs RUNTIME_HOME backup`，人工试跑用 manual，并记录真实任务/线程/触发。备份目标和设备身份必须与安装收据一致，不能创建离线设备的替代目录。日常幂等及周日恢复由同一脚本决定；记录backup_id、恢复游标、实际成功/未完成/失败，不将复制完成当成全恢复通过。不删除原档、旧备份，不向GitHub上传真实材料，不在脚本之外循环重试。按下述通知规则读取摘要并更新memory。不得修改安装配置或运行其他业务入口。

### 三项任务共用通知规则（应用时拼入各正文）

自身入口结束后，只读执行 `node RUNTIME_HOME/launch.mjs RUNTIME_HOME notifications`，汇总结果、执行、容量和服务四流。将event_set_id与本任务memory已呈现集合比较，仅新异常、恢复或必要行动呈现摘要，包含事件时间、总数/省略数、最近记录的发布时间和一个核对动作。未知读取失败单独去重，不能当作没有告警。相同集合、暂停、锁忙及无变化保持安静。完整错误、路径和价格数据不进入公开通知；原始结果保持LOCAL_ONLY。保存结果为“已呈现”或“呈现未知”，不得标为delivered，不清空pending outbox。逐条送达回执尚不可得；本任务间去重仅各自memory范围，不能承诺跨任务只通知一次。

官方任务支持收件箱呈现，实际可见性仍需首次正式运行验收：[Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)。

## 最终材料的完成门槛

| 材料 | 当前证据与限制 | 完成条件 |
| --- | --- | --- |
| 代码与CI | 上述精确代码基线四项CI成功，六项具名代码缺口已审查解决 | 本文档增量正常提交、CI及独立增量复核，最终状态绑定新SHA |
| 候选包 | 上述非synthetic候选676项验档通过；便携保全677文件已解包复验；不是安装回执 | 从文档增量的精确提交重建并核验新release/manifest/source/依赖身份及便携保全 |
| 安装配置 | 2026-09-16 06:04 UTC只读检查：拟定runtime/data根尚不存在，5178/5179无监听（未预留）；同盘local-recovery | LOCAL_ONLY配置SHA为 `3007f7613b8bb1b97c331f022da3014ebda6e88266e4e85e084d681fd8adf3cd`；激活前复核根/设备/容量/端口，保持三项暂停并绑定精确批准；尚未建根/迁档 |
| 调度 | 上表为实际差异；两个新任务尚未配置 | 官方创建/修改及回读ID、正文SHA、Local目录、状态；预计未来三次上海/UTC时点与官方返回值分别记实 |
| 通知 | 只读摘要/去重逻辑测试通过，pending保留 | 官方任务首次摘要实际可见；若无送达回执继续UNKNOWN，不改写delivered |
| 真实单轮 | 安装版未验证；旧版本历史结果不能替代 | 批准后manual安装入口，真实冻结/生成/归档/HTTP可见及成熟核对绑定同release |
| 自然运行 | 尚未验证 | 至少两期真实scheduled证据；休眠/迟到不回填，不把manual冒充自然 |
| 方法效果 | 样本不足/未验证 | 独立冻结前向样本与预设检查点；不足保持WAITING_NEW_DATA，不推断有效 |

## 切换顺序与下一动作

先完成必要测试与独立审查，按最新持续授权合并精确head，再向维护者提交main精确release/config的激活决定；未经激活决定不得切包。合并后从确切main提交重建，若SHA或包身份改变，重新绑定激活批准，不能沿用功能分支包身份。

正式切换前先暂停旧官方业务任务，等已确认自有轮次结束；保留暂停保护。核验/暂存包，激活为forecast/ops/service均暂停，先核验doctor与备份恢复。服务和manual真实单轮验证须在精确批准及对应技术门满足后，分别受控启用service和forecast；全暂停状态不能完成真实预测。验证后保留或恢复各项暂停，保存每次控制变化回执。随后配置并回读三个官方入口与时区，满足技术和授权门后才恢复各项。旧任务ID复用，不重复创建预测任务；新任务按真实ID去重。

回退只使用此前批准且兼容现有原档的release，保留业务暂停，停止已确认自有服务，调用管理rollback，再核验health/release/旧档；不删除新原档。若从未有已批准安装版，previous_release不存在，必须明确没有可用安装版回退目标。

维护者决定材料须明确：精确提交及release/manifest、配置SHA、原批准来源和安装目标；批准范围分别列出合并、正式激活、受控service/manual验证及其后恢复哪些职责。默认激活后forecast/ops/service均暂停；只在获准的验证步骤临时启用对应项并保存回执，结束恢复暂停。自然业务启用仍需真实单轮技术条件与任务配置回读；不把代码审查当成恢复运行批准。首次 previous rollback 为 NOT_AVAILABLE；备份仍只承诺同盘恢复。

唯一下一步：完成最新授权规则增量的必要验证/独立审查/正常合并，回读最终main CI并重建候选，形成精确激活决定材料；正式激活、持续服务、安装入口验档/备份恢复、manual真实单轮留待精确确认后执行。未来两期scheduled及方法效果仍需真实时间与新数据，不能提前报通过。
