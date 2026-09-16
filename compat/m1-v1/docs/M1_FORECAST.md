# M1 单次实验预报

对应 #10 v2 / #11 v1 / #12 v1 / #13 v1 / #14 v1。M0 已交付且五项视觉验收通过；M1 已获批准。#11 已实现本地单次 `prepare → Codex → validate/publish` 并通过工程审查，#12 接入同图显示与历史回放，#13 添加独立实际行情归档与到期核对。#13 已取得规划侧 `single_run_verified`，#14 按条件授权组合固定版本流程；配置、手动验证与自然运行分别留证。本文件描述实现口径，实际成熟窗口、工程审查及运行证据以 PROGRESS 和对应收据为准。工程能运行不等于预测准确、校准或盈利。

## 冻结方法与事件

`method_version=m1-path-events-v1`，`prompt_version=m1-codex-v1`，模型输出 schema `m1.0`。首轮实际输入冻结前固定此规则及函数、测试和 schema。阈值仅为清楚、可计算的首版定义，没有回测寻优，不随结果调整；后续修改必须新版本、新 run。

每个期限使用该期限内每15分钟的收盘节点，加原始锚点。6h、12h、24h分别24、48、96点；相对变动以锚点为分母。分类按下列顺序，命中第一类即返回，未命中归其他，因此互斥且穷尽。

| 类别 | 规则 |
| --- | --- |
| `surge_reversal` 冲高回落 | 先出现至少 +1% 的点；至少4步之后从该点回落至少锚点的1%；最终不高于 +0.5% |
| `dip_rebound` 下探回升 | 先出现至多 -1% 的点；至少4步之后回升至少锚点的1%；最终不低于 -0.5% |
| `uptrend` 终点向上 | 终点至少 +0.5%；不保证单调持续上涨 |
| `downtrend` 终点向下 | 终点至多 -0.5%；不保证单调持续下跌 |
| `narrow` 窄幅 | 包括锚点在内的最大值减最小值不大于锚点的0.5% |
| `other` 其他复杂路径 | 前述类别的补集 |

含等号边界。反转先后顺序与至少4步间隔都检查；两种反转都出现时优先冲高回落。±0.5%终点先归方向类。以上是收盘采样事件，不能推断15分钟柱内部先后顺序，也不把OHLC高低点当作可观测路径。

六个 `probability_24h` 分别属于上述24h类别，均在[0,1]且总和1，容差1e-8，超差拒绝，不自动归一。6h/12h不继承24h概率；后续仅能按各自期限独立分类/评分其已定义输出。每条96点代表路径必须分类为其声明类别；代表折线不穷尽类别中的可能路径，线性显示连接不是成交轨迹。

模型对0–6h、6–12h、12–24h分别提供有限正数下界/上界与简短解释；标为 `model_range_estimate`、未经校准，不声称80%/95%覆盖率。每类有支持依据、反对依据及失效条件；只要求简明可检查依据。

## 输入与来源

OKX `BTC-USDT-SWAP` USDT线性永续、trade价格、15m。复用M0规范化及来源重建函数：从最新完整柱冻结E，顺序分页收集 `[E-14天,E)` 的1,344根连续完整柱，保留排除未收盘与重复统计，缺口、冲突、错误响应或条数不足不发布。每个新run使用独立 `artifacts/data-source/<run_id>`，M0三文件及原始开发包不修改。必要公开行情请求无账户/交易密钥。

代码从冻结14天历史计算尾部6/12/24h收益、非年化close-to-close波动、价格范围、quote成交量及UTC时间信息；OI、funding等未取得项明确unknown。模型上下文只含冻结特征与最近96柱，完整14天源数据继续保留，不声称模型直接读了全部柱。

先保存少量官方宏观日历/来源及HTTP失败证据，再冻结输入。发布时间、事件时间、抓取时间分开，未知值保留null/unknown，不能用网页更新时间或抓取时间冒充初次发布时间。来源无法支持可靠事件风险时降级 `market_only`，模型上下文不纳入日期附件，明确“未纳入事件风险”；不能解释成没有重大事件。原始事件材料复制到对应run并以字节SHA绑定。

## 运行、时点与保存

```sh
node --import tsx scripts/m1-forecast.mjs prepare artifacts/path/to/events.json
node --import tsx scripts/m1-forecast.mjs generate artifacts/forecast-runs/<run_id>
node --import tsx scripts/m1-forecast.mjs read artifacts/forecast-runs/<run_id>
```

仅使用本机官方 `codex exec` 与现有登录配置；不新增API凭证或其他模型服务，不读取凭证。实测CLI版本及本次配置标识记attempt receipt；JSONL未暴露精确模型标识时明确unknown，不从产品名猜版本。[官方结构化输出说明](https://developers.openai.com/codex/noninteractive/)与本机 `codex exec --help` 核对 `--output-schema`、`--json`、`--output-last-message`。模型子过程是只读单次判断，输入经stdin提供；禁止获取新消息/行情、修改文件或递归执行开发任务。JSONL检测到工具活动则拒绝发布。

`prepare`先创建唯一run，保存输入、提示词、schema、代码版本/文件SHA、原始来源及冻结manifest。信息冻结时间、generation起止时间与首次published_at由程序真实时钟落盘，模型不能指定。输入还保留data cutoff及事件抓取截止。模型输出与运行日志在独立attempt内；最多两个尝试且逐一保留，生成单次240秒超时，SIGTERM后给予2秒终止宽限，仍运行则SIGKILL并等待close；超时按失败记录。进程异常/额度失败留记录，不能制造替代预测。

若首次发布时首个未来节点 `anchor_time+900` 已发生，状态为 `late`，`eligible_as_latest=false`。不改时间或平移路径来掩盖延迟；整个late run不参与有效预报评分，也不冒称拥有完整事前视域。发布时间早于锚点拒绝。有效run也包含从数据截止到发布之间的已流逝区段；未来可评分点全部严格晚于首次发布时间，0–6h标签不是从发布时间起算。

原始输出校验通过后，在临时目录写forecast、receipt、manifest，再原子重命名成 `publication`。只有完整已提交目录可被读取；中断留下的临时目录无效。重复发布同run返回原published_at/哈希；任何已冻结输入/提示词/schema/来源、原始输出或已发布文件变化均拒绝。失败不会修改其他run，没有全局latest指针。已有有效run重读时其有效性是“发布当时”，当前是否过期由后续展示/核对功能另行处理。

整个run及原始响应均gitignored、LOCAL_ONLY、位于网页可服务目录之外。公开PR只提供非价格run_id、真实时间、SHA及测试摘要。上述 #11 单次归档本身不提供网页入口；#12 的受控展示入口见下文。没有网格盈亏、交易、业务定时器或公网部署。

## 验证范围

纯函数测试覆盖分类阈值/顺序/剩余类、坏概率、重复/遗漏类别、秒制锚点、96节点数量和路径归属。归档测试覆盖重复发布、篡改、失败/有限尝试、真实时钟与迟到，以及中断临时目录不被当成有效预报。真实运行必须另以官方Codex输出、来源重建、首次发布时间及稳定SHA验证，fixture测试不冒充实际预测。精确结果和限制记PROGRESS及本轮LOCAL_ONLY收据。


## #12 本地展示与历史回放

`/api/m1/index` 是同一 Vite 进程内的只读扫描快照，`/api/m1/runs/<run_id>` 只返回严格 `MFV:M1_DISPLAY:v1` 展示投影。接口不生成预测、不下载行情、不改原档或写全局 latest 文件。最小索引分别保留最新运行状态、可回看的历史条目与未过期的最新有效 run；坏档案、失败、未完成和迟到条目不被过滤成“最近成功”。刷新先核验完整选中 run，再一次替换主图、概率与来源；失败时明确保留哪份旧快照。

适配层复用 frozen/publication/attempt/source 哈希链并重新验证历史与预报契约。只允许精确 run_id 路径，拒绝穿越和符号链接，保留静态私有目录屏蔽；GET、连接地址、Host/Origin 同源检查与 no-store 适用于 dev 和 preview。HTTP 输出只含历史 OHLC、来源名称/端点、预报展示字段、模型标识可见性、版本、时间和摘要哈希，不返回完整输入、prompt、provenance、原始响应、日志或任意文件接口。

绘图投影与 M0 文件契约分开。实验概率仍属于冻结的六类24h事件，路径显隐及6/12h裁切均不重新归一。每个阶段只绘制原 lower/upper 对应的一层矩形范围；阶段交界保持原值，不把阶段范围插值成预测置信带，不套用 DEMO 内外两层区间或网格。历史、代表路径、区间与坐标支撑共用右侧价格轴，常驻支撑保持全24h节点和纯未来坐标。

实际走势叠加使用显式绘图入口，尚无 #13 已核验结果时不传入合成观察值；评分区逐6/12/24h显示未到期或已到期尚未核对。到期与过期由展示时真实时间计算，不改已归档 valid/late 发布状态或首次发布时间。评分另存并绑定原预测哈希，具体口径如下。页面体验验收与规划侧工程审查分别记录。

## #13 实际结果与独立评分

纯函数 `evaluateForecast({ forecast, forecastHash, candles, observedThrough, evaluatedAt })` 不读取时钟、文件或网络。输入为原始严格 `PublishedForecast`、该 publication 的字节 SHA、同 OKX `BTC-USDT-SWAP` trade 15m 完整柱、实际获取覆盖截止秒和真实评分时间。它重验原方法/提示词、概率、互斥类别代表线、96个时间节点及发布时间；实际柱按 `close_time=anchor_time+k*900` 对齐，重复、乱序、错误 OHLC、未完整收盘或超出获取截止的柱均拒绝。缺柱保留，不填补、插值或用最近价格替代。

结果契约为 `MFV:M1_EVALUATION:v1`，`evaluation_version=m1-evaluation-v1`；绑定 `forecast_id=run_id`、`forecast_hash`、`method_version`、`prompt_version`、原锚点/首次发布时间、`evaluated_at` 和 `observed_through`。归档层另保存评分代码 SHA 和原分类代码 SHA。原分类代码须与这份预报冻结的 provenance 一致；不根据实际结果修改事件定义。

### 成熟度、可评价性与实际线

`windows.h6/h12/h24` 分别期望24/48/96个未来收盘节点。`maturity` 表示本次获取覆盖截止对应的时间进度：首节点尚未到达为 `not_due`，已到部分节点为 `partial`，期限已到为 `mature`。`expected_observed_count` 只计算截止当时应已完整收盘的节点，`observed_count` 是实际取得数，`missing_times` 列出应有而缺失的时间。`status` 在缺数时为 `missing_data`，否则沿用时间进度；整份迟到预报一律 `ineligible`。顶层状态对应24h窗口，各窗口自身状态独立保留。

有观察的部分窗口允许计算已观测节点的描述与 MAE，缺数窗口也只能描述实际取得的节点；两者都不发布完整期限事件或概率分数。成熟且节点完整才调用原 `classifyPath`。零观察、未支持或不可评价的数值使用 `null`，不将其写成零分。零是实际算出的结果时才有效，例如观察到的恒价路径误差确实为零。页面的当前墙钟到期提示与历史评分的 `evaluated_at/observed_through` 分开，时间过去不会自动补齐或改写旧结果。

所有参与评分的未来收盘点都严格晚于首次发布时间。首根未来柱可能在发布时间之前已开盘：其发布后收盘点仍可评价，但整柱 high/low 无法区分发布前后。因此只有 `open_time >= published_at` 的完整柱参与 OHLC 极值及整柱覆盖，记录 `ohlc_eligible_count` 与 `excluded_prepublication_candles`；无合格柱时相关指标为 `null`。不从15m高低价推断内部先后、反转事件或触达时点。

`actual_points` 只输出自首未来节点起到第一个缺口之前的连续前缀，迟到 run 返回空数组；`omitted_after_gap_count` 明确后续已取得但未画线的节点数。全部已取得节点仍用于其支持的描述与 MAE。显示连接只是收盘采样线，不跨缺口补线，也不是逐笔成交轨迹。

### 指标公式与单位

设原锚点价格为 `A`，第 `k` 个未来实际收盘为 `C[k]`，情景 `s` 的对应原代表价格为 `P[s,k]`，`O` 是某窗口内实际取得的可评分节点集合。每个窗口保留所有六情景的误差，不选择最接近的一条充当综合成绩。

| 字段/指标 | 冻结计算口径 |
| --- | --- |
| `scenario_errors[].mae_price` | `sum(abs(P[s,k]-C[k])) / len(O)`，价格单位 |
| `scenario_errors[].mae_return_pct` | 预测和实际均以原锚点计算收益百分比后的 MAE，等价于 `mae_price/A*100`；单位为百分点，不是每步收益误差 |
| `constant_baseline` | 同一节点集合上将全部 `P[k]` 固定为 `A` 的相同两项 MAE；只是统计参照 |
| `actual_category` | 完整成熟窗口的未来收盘序列调用冻结分类函数，包含原锚点并使用该窗口自己的期限 |
| `brier_score` | 仅完整成熟24h：`sum_s((probability_24h[s] - 1[actual_category=s])^2)`；六类求和，不除以类别数，范围0至2，越小越好；6/12h始终为 `null` |
| `width_price/width_return_pct` | 每阶段原估计 `upper-lower`，及该宽度除以 `A` 再乘100；区间宽度无需结果成熟 |
| `close_min/close_max` | 该阶段已取得未来收盘的最小/最大值，不把锚点插入观测样本 |
| `close_max_upside_pct/close_max_downside_pct` | 相对原锚点的上/下极值幅度：`max(0,(close_max-A)/A*100)` 与 `max(0,(A-close_min)/A*100)`；都是非负幅度，不是相对某条代表线的残差 |
| `ohlc_low/ohlc_high` 及对应上/下幅度 | 只对整柱均在发布之后的合格 OHLC 计算 low/high 极值，相对锚点幅度同上 |
| `close_coverage` | 该阶段收盘落在原 `[lower,upper]`（含端点）的观察数除以该阶段观察数，值为0至1 |
| `ohlc_coverage` | 合格 OHLC 中同时 `low>=lower` 且 `high<=upper` 的完整柱占比，值为0至1；分母只包含合格整柱 |
| `realized_volatility` | `sqrt(sum((log(C[k])-log(C[k-1]))^2))`，仅两个端点均为已取得且发布后相邻未来收盘的步；无年化、非标准差、原值是 fraction，页面可乘100显示百分比 |
| `return_pair_count` | 上述实际相邻收益对的数量；首未来节点不与发布前锚点组成波动样本，缺口不跨越；阶段可使用前阶段相邻的已观测最后收盘 |

阶段是原冻结的1–24、25–48、49–96步；每个节点只归一个阶段。阶段描述也分别保留时间成熟度、预期/实际观察数和缺口。部分阶段只描述已取得部分，无观察或整份迟到时 `observed=null`，没有相邻未来收盘对时波动为 `null`。

### 获取、幂等重算与只读显示

显式本地命令如下；页面刷新只读取结果，不执行这些命令：

```sh
node --import tsx scripts/m1-evaluate.mjs capture RUN_ID
node --import tsx scripts/m1-evaluate.mjs evaluate RUN_ID CAPTURE_ID
node --import tsx scripts/m1-evaluate.mjs run RUN_ID
node --import tsx scripts/m1-evaluate.mjs read RUN_ID
```

`capture` 单独保存完整行情请求及原始响应；`evaluate` 评分某次 capture；`run` 顺序完成两步；`read` 只核验读取。每次获取最多覆盖原未来24h（96柱），使用有限分页/超时、正常 TLS 和既有网络环境。原始响应、HTTP/解析失败、未完成尝试、缺数和后续补数均保存在 `artifacts/m1-outcomes/<run_id>`，全部 `LOCAL_ONLY` 且 gitignored；不改原 `forecast-runs` 输入、输出、publication 或 M0 三文件。

同一已保存 capture、相同评分代码重复评分返回原 revision；新的获取与补数生成新的 revision，保留之前的 `missing_data/null`，不就地覆写。结果及 manifest 在临时目录写完后原子发布。读取时重新校验源文件/预测/代码 SHA、时间、方法，并从对应实际柱确定性重算，比对全部评分字段；临时目录不算已发布。最新失败或中断明确显示，不把旧成功冒称本次成功；旧 revision 证据仍在本地。

评分记录保留方法与提示词版本；当前没有跨 run 的显著性、校准率或盈利汇总。重叠窗口不是独立样本，一份记录不足以证明概率校准、区间置信水平或预测有效。区间覆盖只是对未校准模型估计的观察描述，不能据此冠以80%/95%置信带。不同方法/提示词记录也不混合成同分布样本。

验收分别保存 synthetic 手算/负例、真实成熟窗口核对、UI图形验证及规划侧审查。技术完成但真实6h尚未成熟时记录 `waiting_for_outcome` 与 `next_check_at`，结束本轮等待下一有效检查；不修改系统时间、不补造历史事前预测、不额外创建评分定时器。至少一个真实成熟窗口（最先6h即可）及绑定提交/run/evaluation 的监督 `gate=single_run_verified` 才满足 #14 的业务任务前置。

## #14 固定版本两小时业务运行

业务名称为“M1 实验预测运行”，通过官方桌面应用创建的 Local 定时任务绑定本项目主 checkout，每两小时执行一次。现有每小时研发执行器不充当业务任务。创建/复用前先检查同职责实例，并手动验证完整组合流程；首次自然业务运行必须另有实际线程与收据，手动试跑不能标为 scheduled。官方计划、启用状态、模型及权限的实际配置回读和首次自然证据分别保存，准确状态见 PROGRESS。

`artifacts/m1-runtime` 是 LOCAL_ONLY 运行目录。小型 release manifest 记录规划侧 single_run_verified 的真实 review/源字节 SHA、方法/提示词/评分版本和全部相关代码字节 SHA，另记本机 CLI 模型配置来源。业务每次在持有项目原子锁后、加载相关模块前核对固定发布版本，并在各阶段重新核对；发现变动即跳过或保留失败状态，不自动批准新代码。正常研发提交并不自动更新业务 manifest，升级应按具体批准任务验证后显式交接。系统权限与业务职责分别记录：业务仅读取已批准代码和输入、写本地 run/evaluation/status，不改代码、Git、队列、提示词、分类、评分或风险规则。

运行入口：

```sh
node --import tsx scripts/m1-runtime.mjs run RELEASE_FILE RELEASE_SHA256 THREAD_ID scheduled
```

RELEASE_SHA256 必须与官方任务正文固定的发布清单字节哈希一致，不从当前文件自行推导为批准值。THREAD_ID 必须来自本次官方任务真实会话。开发者在自己的独占锁内手动验证时使用 `manual` 并传已有 owner；这只是借用本轮锁，不释放他人锁，不冒充自然运行。业务沿用项目 executor 原子互斥，只使用 acquire/owned/release，不领取开发 Issue 或改其检查点。锁忙、已有暂停标志均跳过，不用时间推断锁失效、不抢锁或杀进程。

每轮先按6/12/24h实际成熟进度核对旧有效预报；已完整核对24h的档案不重复获取。到期、缺数、失败与尚未到期继续沿用 #13 的独立 revision，不改原发布。随后收集少量官方日历来源与最新完整行情，冻结一份新输入，执行既有官方 Codex 单次判断、原校验与原子归档，再保存展示索引和本轮状态。旧结果每步保存，新预测失败不会删除已有核对成果。来源不可支持可靠事件风险时标为 market_only/未纳入事件风险；不把HTTP成功当作完整事件研究，也不添加冻结后信息。

一轮只有一个新 forecast run；有限同run重试保留全部attempt，不为挑选有效/好看结果重复新建样本。首次发布迟到保留late，不平移锚点或首次时间。离线后只发布当前有效新预报并补旧结果，不回填错过的事前预测。中断留下的状态和未完整提交目录保留；恢复不掩盖失败、不在未知活动进程下夺锁。

页面的业务状态独立于当前回放的预测。固定发布清单和所列代码字节另作只读核验：发生改变时显示业务入口将拒绝，保留原轮次记录，不伪造一次新的失败或成功。读取 `/api/m1/runtime` 只返回严格白名单状态；原始收据、日志、源码路径与完整错误仍在网页服务范围之外。最近成功保留其首次发布时间，最新失败/运行中/跳过单独显示；历史有效不等于当前未过期。官方配置快照显示真实回读时间；下次执行时间只有官方入口实际提供时才展示，否则明确未知，不根据代码推测为官方计划。页面定时读取只更新状态，不调用模型、行情获取或评分，不改变原图档案。

暂停可使用官方桌面应用中的该业务任务暂停功能；也可在没有改动代码的情况下创建 `artifacts/m1-runtime/PAUSED`，下次业务入口在获取数据前跳过。恢复只移除已核实归属的暂停标志并恢复官方启用状态，不能删除活动 writer.lock。暂停阻止新一轮，不中止正在安全结束的流程；关闭网页不会停止业务任务。Mac、官方应用、网络与已有登录可用性决定能否自然运行，不承诺无限在线。

验收保留 synthetic 故障/重叠/重复/暂停恢复/代码变更测试、一次真实手动组合验证、官方配置回读，以及至少一次真实自然业务运行。预测准确、概率校准、长期稳定和交易授权均不由这些工程证据推出。
