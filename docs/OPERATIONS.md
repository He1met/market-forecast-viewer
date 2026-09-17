## 未发布失败记录与评分资格

ops生产/候选扫描与forecast fallback共用只读评分资格检查。只接受两次尝试已耗尽、冻结档与尝试收据/原输出/事件审计哈希一致的 `MODEL_ATTEMPT_REJECTED`，且不存在publication、结果档或已发布索引/成功摘要等矛盾迹象；正常扫描返回 `terminal_failed_not_scoreable`，仅解除该对象的评分unresolved，不改变原失败或执行告警。

准备失败、validation失败、单次失败、缺审计证据等类型暂不自动豁免。存在publication路径必须严格读取；成功后缺档、损坏、未完成尝试仍为unresolved。无需重写历史文件或删除告警来消除评分误报；告警与实际运行验收继续按真实记录判断。

# M1 本地运行与维护

### 服务巡检告警

安装ops在业务互斥内检查展示服务，结果核对slot已完成也继续检查；ops暂停时不执行检查或重启，service_paused保持独立。只有确认自有服务退出才有界重启，未知端口不停止、不换端口。服务故障保存到ops观察的service字段及独立service告警流；结果核对成功不清除服务故障。暂停不是恢复证据。notifications包含服务pending事件，仍不声称实际通知送达。

本页描述候选安装入口。当前工程尚在验证，业务维护 PAUSED 保留；命令存在不代表已部署、调度已运行或方法有效。原始输入输出与操作收据仅保存在 LOCAL_ONLY 位置。

## 开发续接

既有 chart-mvp 已获用户允许自动续接 Issue15，每小时12分、gpt-6-astra/medium，由监督侧管理其官方配置。自然触发使用真实 scheduled；交互实施使用 manual。每轮先核对检查点/文件指纹，持有自己的 executor 锁后同步远端。一个工作片目标不超过40分钟，结束所有自有命令、保存检查点后正常释放自己的锁。旧一行修正限制已由最新授权取代，不重复领取 Issue15、不伪造 owner review。

## 候选包与安装

包从精确 Git 提交导出并重新构建，使用单独锁定的运行依赖；合成验证包标为 synthetic，禁止激活。开发 checkout、runtime_home、data_root 分开；runtime_home/current.json 只指向已核验 release。正式激活需要维护者对精确 build SHA/release ID 的批准来源；范围内合并已获2026-09-16用户持续授权，必要测试及独立审查通过后可正常squash，不得提前切包或恢复业务。

在本地填好安装配置并保留 forecast_paused、ops_paused、service_paused=true。backup.target 必须已经存在且在生产数据与运行目录之外；记录实际 device_id，未挂载或身份变化将拒绝备份，不创建替代目录。绝对本机路径只进入 installation.local.json。

开发管理入口（参数以本地实际绝对路径和完整 SHA/ID 代入；先取得精确批准）：

```sh
npm run m1:release -- --commit FULL_COMMIT_SHA --destination ABSOLUTE_NEW_PACKAGE
node --import tsx scripts/m1-admin.mjs verify PACKAGE
node --import tsx scripts/m1-admin.mjs stage PACKAGE RUNTIME_HOME
MFV_RUNTIME_HOME="RUNTIME_HOME" npm run m1:deploy -- --release RELEASE_ID --approval ABSOLUTE_APPROVAL_JSON --config ABSOLUTE_CONFIG_JSON
```

stage 只复制候选。推荐公开 m1:deploy：它在业务互斥内校验批准、配置、旧档兼容与目标包，并在固定本机端口执行切换前 HTTP health/runtime/page 检查；检查结束停止自有探测进程，成功状态为 activated_paused，不是持续服务或安装入口端到端验收。首次无投影明确 not_initialized，坏投影拒绝。底层 m1-admin activate 默认没有 healthCheck，不能以其成功替代 HTTP 验收，也不作为日常部署示例。

安装要求展示服务已停止，保留三项暂停；安装 pending 事务门禁和显式恢复协议保护中断现场，三文件不是整体原子事务。未知字节不覆盖；历史无门禁 launcher 需单独受控迁移。审批材料不能由实施者虚构。安装后的稳定入口为：

```sh
node RUNTIME_HOME/launch.mjs RUNTIME_HOME doctor
node RUNTIME_HOME/launch.mjs RUNTIME_HOME forecast
node RUNTIME_HOME/launch.mjs RUNTIME_HOME ops
node RUNTIME_HOME/launch.mjs RUNTIME_HOME backup
```

launcher 每轮只读取一次 current；运行中不重新选择版本。forecast 只接受原计划 slot，重复 slot 不重新生成。人工验证通过 MFV_TRIGGER=manual 留源；调度入口按真实触发传 scheduled。

## 服务与故障

展示服务只监听配置的127.0.0.1端口，GET白名单且静态资源每次回读哈希。管理命令 service-status、service-start、service-stop 后接 RUNTIME_HOME。启动/停止通过独立控制锁串行化，以 PID、进程身份及 health token 核对自己的服务。未知监听者、PID身份冲突、未知控制锁均保留现场，不杀进程或换端口。ops 只在确认原有服务已退出且 service_paused=false 时有界重启，30分钟最多3次。

已持有端口但不健康的服务不会被自动杀掉；保留日志并报告。服务暂停与预测暂停独立。自动调度全部停止期间不能承诺实时故障通知。

回退使用 `MFV_RUNTIME_HOME="RUNTIME_HOME" npm run m1:rollback -- --release PREVIOUS_RELEASE_ID`；底层参数为 `rollback RUNTIME_HOME PREVIOUS_RELEASE_ID`。精确目标必须是 previously approved 的旧 release，锁内用目标 reader 校验现存原档兼容性后才切指针，仍要求先停止自己的服务并保持业务暂停；旧证据不删除，恢复后重新核验 health/release/旧档回放，再由维护者决定恢复业务。首次安装没有已批准 previous release，实机回退为 NOT_AVAILABLE，不能报 PASS。

## 备份与恢复

备份短暂持有业务锁捕获稳定文件，并二次核对捕获期间的字节；释放业务锁后通过独立备份锁复制和校验对象，最后提交 manifest。覆盖行情原始分页、正式/候选预测、核对结果、案例/实验/补充输入、控制与运行记录，以及 runtime 安装/release 信息。日志变化使本次捕获失败，不能把变化尾部写成稳定备份。

forecast/ops/backup 的独立 started/result 记录包含真实 MFV_TRIGGER、MFV_TASK_ID 和 CODEX_THREAD_ID；外层必须传入实际任务 ID，不推测不存在的调度环境变量，未提供身份明确保存 null。共享 backup.json 与 last-backup-success.json 仅在取得业务锁后更新；锁忙仍保留独立结果供后续 ops 归集，不改他人的共享状态。恢复未完成返回 partial，失败返回 failed，不刷新完整成功；已完成的快照 ID 独立保留。doctor 可读取最近备份摘要，尚未运行不能显示成功。

每日 backup slot 去重；周日启动恢复检查，未完成检查后续轮继续。恢复到新隔离目录，逐对象校验并保存游标；每批有时间/对象上限。回放原预测、重算已有核对及读取案例后才写完整恢复收据。运行指针、安装配置、活动 owner 和任务状态不会恢复为可运行状态。源沙盒删除/篡改演练不触碰真实原档。

同盘副本仅为 local-recovery。外部故障域必须按真实备份设备另行验收；不自动删除原档或旧备份、不上传原始材料。剩余空间不足则拒绝大备份并保留失败。

## 交付状态

安装版 `npm run m1:doctor` 默认只读：返回精确包/三根路径/暂停意图、固定大小的最新预测/巡检/备份记录与学习控制、任务意图及被动业务互斥探测。设置 `MFV_RUNTIME_HOME` 指向已批准安装；也可执行 `node RUNTIME_HOME/launch.mjs RUNTIME_HOME doctor`。每个状态文件最多1MiB，缺失为unknown、坏档/超限/软链接为unreadable；历史记录不冒充本次验档，版本内任务意图不冒充官方当前任务回读。诊断包含本机路径，只能LOCAL_ONLY。备份观察链已接通独立结果、锁内最近尝试及完整成功摘要；未实际运行或缺失备份记录仍为unknown。

显式 `npm run m1:doctor -- --full-audit`（或稳定启动器末尾加`--full-audit`）才遍历正式/候选原档与案例，重读最新核对及其引用capture、重算案例，不补采、不创建评分revision、不更新索引、不调用模型。历史全部revision不在此次范围，`historical_revisions_audited=false`；不称所有历史评分已通过。最新核对的failed/未知评分会计入失败，即使显示读取器未抛异常；合法not_evaluated单独计数，available记录中的部分观测/缺数据不当成坏档。30秒协作式预算仅在文件操作之间检查；预算耗尽/清单不可读为incomplete，损坏/不可资格化对象为failed，两者均打印JSON并退出2。该审计不是备份恢复演练，也不提供并发写入期间的事务快照。默认doctor不遍历原档；两种模式均不领取或恢复业务锁、不杀进程、不修文件。未知参数非0退出。

分别报告工程验证、安装版真实单轮、至少两期自然运行、方法效果。测试成功、配置 ACTIVE、历史预测可读均不能替代后面三项证据。合并前核对精确提交、CI与独立审查并按持续授权执行；正式切包前另准备精确main候选包与配置差异供维护者确认。


## 容量限制

安装配置可选 `capacity: { "reserve_bytes": 2147483648, "production_floor_bytes": 268435456 }`，两者为正整数且安全余量不得小于生产底线。缺省使用上列值。低于安全余量停止安装版候选执行、附加输入刷新和备份；低于生产底线或空间未知时，预测在领取slot前失败。ops继续核对正式结果并记录容量；小量诊断/锁/状态写入仍可能失败，空间充足也不保证实际写入成功。

ops每日UTC基线的 `filesystem_used_delta_bytes` 是整个文件系统的用量差，不能归因于本项目；设备或总容量变化时不计算差值。doctor返回当前空间检查。独立容量outbox记录告警/恢复，pending仍不代表官方送达。备份目标还须满足复制字节数加安全余量。开发验证在复制隔离环境前要求至少2GiB可用，不自动清理旧材料。

## 官方任务通知摘要

安装批准后，`node RUNTIME_HOME/launch.mjs RUNTIME_HOME notifications` 只读结果、执行、容量和服务四个告警流，返回最近20条待发送历史事件、总数/省略数、全事件集合的稳定 `event_set_id`、记录的最后发布时间及一个核对动作。不会预测、联网、争业务写锁或改变告警送达状态；即使业务暂停也可读取。最后发布时间仅来自已记录摘要，不代表本次重新验档。跨流读取不是一致性事务快照；后续读取会看到新提交。

官方业务任务执行自己的入口后可读取此摘要，按事件集合ID与任务memory中已呈现的ID比较：只对新事件集合呈现一次简短异常/恢复摘要，保留历史事件时间和省略数；重复集合保持安静。保存的“已呈现”只能用于消息去重，不能写成delivered，也不能丢弃outbox。发送不确定时记录unknown，不盲目重复。禁止把原始错误、路径、输入输出拼进公开通知。摘要读取失败必须记不可用，不能当成无告警。

[官方任务文档](https://learn.chatgpt.com/docs/automations?surface=app)说明有发现的任务结果进入Scheduled收件箱；本轮文档及已暴露工具未提供逐事件送达回执。当前代码没有传输器，`transport=not_configured`、告警保持pending；未据此宣称系统推送或用户已读已验证。不使用新消息服务，不修改业务调度。后续正式任务配置使用此摘要呈现规则，真实可见性与送达能力另验；无法取得官方回执时继续保留pending。

## 预测轮旧结果兜底核对

安装版forecast在冻结新输入前复用已持有的业务锁，最多45秒、最多两个正式run补采实际行情并写独立评分revision；兜底使用独立游标和未解决项，不清除ops包含案例生成等更广职责的错误，候选不进入此兜底。已完整成熟的结果不重复下载，案例生成和方法决定留给ops。请求传入取消信号和单调截止，文件步骤前后检查预算；这是协作式截止，不是对文件系统调用的硬中断。

补核对失败单独保存于本轮old_results和失败收据，在新预测仍有预算时继续；不能把新预报成功写成旧结果也成功。坏档和未完成检查保留兜底游标未解决项，后续预测轮继续；ops独立巡检。重复预测slot不再次补核对或调用模型。
# 受控附加输入实验

通过已获精确包批准的安装入口执行 `npm run m1:learning -- plan-input --input calendar --policy-sha <64位哈希> --reason "比较原因"`；`--input` 仅支持 `calendar` 或 `derivatives`。哈希取 `m1:doctor` 的 `learning.effective_policy.sha256`，这是只读时点值，执行时在业务锁内再次核对。未知参数、策略变化、运行包变化、学习禁用或已有活动实验均拒绝，不采集行情、不调用模型、不改变正式策略和暂停配置。

当前受控入口只允许从 `additional_inputs=none` 启动一个因子；必须已有同一生成身份的反馈实验完成20对并决定 promote/reject，还要有决定后新增且重新验档通过的成熟案例。前置决定须具有plan/decision commit绑定和全机会证据；逐项核验冻结输入、实际启动及原评分revision，再重算原检查点，缺证据的旧摘要不能当作通过。计划保留原因、release、策略哈希、反馈决定哈希、案例及revision哈希；共享创建入口对手动和自动路径每天（Asia/Shanghai）最多新建一个，已尝试的相同策略/输入不重复建。后续沿用01:47机会、20对/30机会、5%改善及原护栏，不承诺何时产生有效结论。

正式策略与实验control不一致时，预测登记和ops审查先保存实验 `paused/production_configuration_changed`，保留原计划、机会和结果；不继续混合评分或自动建替代实验。正式预测继续使用当前获准策略。旧晋级策略的模型/推理/predictor身份已不匹配新包时，使用新包基础策略；损坏的决定哈希仍明确失败。旧记录不改写，暂停实验没有自动恢复或替代入口；共享创建路径拒绝覆盖其状态及原因，需另行受控处置后才可新建。
