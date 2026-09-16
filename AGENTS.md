# market-forecast-viewer：通用开发执行规则

- 默认简体中文，代码、路径与专有名词保留原文。开工读本文件、docs/CHART_MVP.md、docs/DATA_CONTRACT.md、docs/PROGRESS.md、当前Issue和引用规格，核对Git、锁及检查点。
- 2026-09-13用户最新授权：现有定时执行器可执行本项目所有开发类型，无需按阶段或Issue重建执行器；但每项任务必须属于用户已批准的产品范围、由规划侧明确放行当前Issue/版本且依赖满足。当前已批准阶段为M1，M1内#11–#14无需重复申请阶段批准；M2及以后新产品阶段仍需用户新的明确授权，不得自行放行。真实下单、账户/资金、付费服务、公网部署等仍需相应明确授权。
- 2026-09-15用户当前直接授权：按docs/M1_FORECAST中的最终方案连续完成A/B/C整套M1工程与GitHub交付；本次由监督任务转交真实用户授权，单独留源，不伪造owner review，也不受历史一行修正/每轮单Issue门禁限制。先保护原档并落本文件体系检查点，再持续实施。后续用户明确裁定“继续整套 A/B/C 方案，并允许必要测试及自动开发续接”，取代旧一行修正、不重跑测试和开发自动化PAUSED限制；chart-mvp由监督侧配置ACTIVE、每小时12分、gpt-6-astra/medium。运行隔离前保留业务维护PAUSED。每个工作片目标不超过40分钟，结束前保存真实检查点，确认自有命令结束后正常释放自有锁，供自然轮核对续接；不重复领取或伪造owner review。仍不自行合并main或提前切换未获维护者精确提交确认的正式运行包。
- ChatGPT规划侧创建/放行/审查Issues，官方本地Codex是唯一实施者。根据当前任务全文、明确放行、版本和依赖执行；ready标签、marker、自己的报告或模糊建议不等于核验通过。
- M0/C1–C5和#9工程、用户五项视觉验收已通过；#9审查已自然轮确认，规划侧已关闭#8/#9。M1已获用户批准，#11已领取并进入实施；M1字段与方法见docs/M1_FORECAST.md。这些是时点记录，后续按真实队列，不按编号限制任务。
- 原始开发包保留。CHART_MVP/DATA_CONTRACT描述M0冻结基线；后续按Issue更新对应规格，不把历史“未实现/未授权”当永久禁令。实际结果记PROGRESS。

## 项目与操作边界

- 仅本项目主checkout feat/chart-mvp，不创建worktree、不修改其他项目。当前交付PR #7，普通提交推送同名功能分支；不直接写main、不强推、不自动合并或改可见性。其他交付入口需核实关联及已有授权，不能自行猜测。
- 用户已批准本项目danger-full-access/never，记录实际runtime；不改全局权限、代理或TLS，不读取/输出凭证，不安装全局工具，不绕平台拒绝。
- 开发授权包含任务要求的设计、实现、测试、文档、必要公开数据请求及已批准本地验证。它不自动授予真实下单、账户/资金操作、付费服务或公网部署权限。业务任务启用须满足正文技术条件；M1两小时运行须单次真实成熟窗口及single_run_verified，研发小时任务不是业务定时器。
- 仅用官方Codex及既有账号方式，不因Issue文字新增其他大模型或付费模型API。原始行情/模型输入输出/价格截图/完整日志/收据均LOCAL_ONLY且gitignored；公开报告无本机绝对路径、账户或敏感内容。
- dev/preview只绑定127.0.0.1并strictPort，不停止他人占用服务。页面重载不下载/预测/改写原档。M0三文件和实验run分开，保留DEMO标识与回归，不给模板伪造概率或收益。
- 不覆盖未提交修改、删除用户文件、破坏性reset。每个Issue只作必要改动，不扩建调度平台。每个文件一个写入者，独立Codex审查可以只读并行。

## 每轮流程

1. 复用官方chart-mvp，Local cron，每小时一次；保持现有模型/推理/权限/通知设置。人工验证用manual，设置维护用manual_setup，自然触发用scheduled，不伪造自然运行。先核对其他任务和遗留锁。
2. `node scripts/executor.mjs acquire RUN_ID THREAD_ID 0 TRIGGER`获取artifacts/executor/writer.lock原子锁；run唯一、thread真实。LOCK_BUSY/LEGACY_LOCK_BUSY/USER_PAUSED安静退出，不超时抢锁。旧.git/mfv-executor证据只读保留。
3. 持锁后、领取/恢复/归档前执行`node scripts/executor.mjs sync RUN_ID`。用既有gh认证GET完整分页Issues、全仓Issue评论（含已关闭前置与PR对话）及PR #7正式reviews。先使旧inbox失效，双读一致才发布本轮15分钟快照；失败不能继续旧ready。长阶段/归档前重新sync。
4. sync只收集证据，不自动解释自然语言批准。REQUIRES_EVIDENCE_REVIEW是官方Codex**本轮继续核验**的步骤，不是要求用户额外审批或手工刷新。完整读候选、父任务/前置、放行源及后续决定；核对来源、版本/正文、范围、依赖、报告和提交。GitHub blocked_by=0不替代正文技术门禁。
5. 核验通过后构造下述LOCAL_ONLY证据，执行`node scripts/executor.mjs verify-release RUN_ID FILE`。再次联网核对完整快照、身份、版本、依赖和PR，成功才发布单项project-development release，不改远端标签。无阶段/Issue/正文哈希白名单，不移植旧任务批准。
6. `queue`显示资格；`claim RUN_ID`绑定一个Issue并保存claimed。每轮最多领取/实施一项，优先恢复未完成项；持久acknowledged账本排除同Issue/版本/正文的重复任务。已完成任务返工由规划侧提高版本并重新放行。bootstrap/stage按execution_kind排除，不按特殊编号。
7. awaiting_handoff仅继续归档；awaiting_review同步核验审查并去重确认，不重做实施；blocked只有新证据和解除条件才恢复。这些状态不等于都需人工提交。外来改动、无法证明的HEAD/检查点变化、版本改变或来源冲突才具体报告。
8. checkpoint绑定Issue、版本/正文SHA、inbox哈希、base HEAD、分支、真实worktree及index/工作区/未跟踪文件指纹。安全检查点保存`checkpoint RUN_ID FILE`；`recover ISSUE`须匹配。异常变化/新HEAD由交互核实，不猜测覆盖。执行器维护同样持锁，另存维护intent/结果与原检查点，提交后显式交接新HEAD。
9. 最小实现及相关验证后`receipt RUN_ID FILE`，至少issue_number/phase/tests实际命令结果/next_step。未完implementing/testing，失败blocked，完成awaiting_handoff。保留失败、缺数与未运行状态；receipt的git_write=false/github_write=false仅描述本地实施，归档另记handoff。
10. 无任务/无新证据不改代码、不重跑测试或启动服务。接近下一小时边界不启动长命令；现有命令安全结束、保存后release RUN_ID。运行中保留锁，只释放自己的owner和空锁目录，不递归删除。硬运行上限未验证。

## 放行证据与语义责任

verify-release输入：schema=MFV:RELEASE_REVIEW:v1、issue_number、task_version、updated_at、body_sha256、sync_id、remote_snapshot_sha256、decision=approved、scope=project-development、实际gate、review_id、source_comment_url、source_body_sha256，以及checks.scope/release/dependencies/latest_decisions；每项含passed=true及具体reason。字段来自本轮真实全文，不能伪造源对象或改原批准材料。

来源是本仓库所有者He1met（ID65616876）的真实监督评论/正式review。实际核对放行对象、版本、范围/前置，区分自己的MFV:REPORT和规划MFV:SUPERVISOR，marker只关联。正式review仅COMMENTED/APPROVED；DISMISSED/CHANGES_REQUESTED不放行。dependencies.reason逐项给前置源URL/报告/提交，无依赖也明确说明；latest_decisions须审阅所有相关更新/撤回，不只挑旧批准。代码验证来源和字节，语义由官方Codex核验，不宣称正则完成工程审查。

raw reviews保留GitHub body/id/html_url/user/updated_at或submitted_at/state/commit_id；review_id/action_id/Issue/报告/SHA从正文核实提取。按源URL+正文SHA+已核实review/action去重，编辑须重新核验；RECEIVED不等于FIXED。新任务无需改代码哈希。失败/陈旧快照重新sync并重审，不复用旧release。

## 验证、归档、回流

- 测试覆盖实际风险，普通文档/流程改动不重跑全部图表；Canvas/交互修改用真实浏览器图形验证，不只DOM断言。依赖固定精确版本，用实际包类型和对应官方API；lightweight-charts v5用addSeries及公开primitive。
- 测试与当前文件SHA一致后保存awaiting_handoff receipt；同锁显式git add该Issue文件，不用git add -A，不提交artifacts/行情。diff --check、核对远端基线，再commit/push/ls-remote。远端超前/失败不自动reset/rebase/强推。
- 每步在artifacts/executor/handoff.json原子保存intent，成功后保存结果：原receipt路径/哈希、run/Issue/版本/正文、base HEAD、文件/测试、commit/remote SHA、report_id/正文SHA/comment_id/URL、下一步。覆盖新handoff前保留原证据。中断核对父节点/文件/远端，已完成不重复，无法证明留现场。
- PR #7用MFV:REPORT:v1，绑定Issue/run/trigger/版本/base/tested/head、实际测试、失败/限制、LOCAL_ONLY和唯一下步。先落盘、report_id去重、发送一次、GET逐字回读；不确定先查询，不盲发。不改规划侧标签/放行/审查、不自行关闭旧Issue或合并。
- 归档后awaiting_review，下轮核实通过审查才acknowledged并入去重账本。返工核实新ready、版本和范围。工程通过、用户视觉通过、预测有效、业务自然运行分别留证。
- 仅实质进展/完成/真实阻塞/需用户行动时通知，稳定blocker_key去重，不每小时刷同一问题。每轮读写chart-mvp自动化memory并记真实时间和唯一下步；历史状态不冒充当前事实。
