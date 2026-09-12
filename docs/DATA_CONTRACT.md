# 三文件数据约定

版本：`schema_version: "1.0.0"`，C0 设计，尚未生成真实文件或实现校验器。字段名称在此唯一维护。默认 OKX BTC-USDT-SWAP / 15m；本 MVP 不做跨品种拼接。

## 通用规则

- JSON 为 UTF-8，不含注释、NaN、Infinity、重复键或省略的必填值。读取器对重复对象键报错，不能仅依赖会静默覆盖的 JSON.parse。未知 schema_version 拒绝；v1 未定义字段拒绝，新增字段先修订本约定和版本。
- **所有行情/锚点/路径/阶段时间为 UTC Unix 秒安全整数**。`downloaded_at`、`generated_at`、请求收据时间为带 `Z` 的 ISO 8601 UTC 字符串。所有 `_seconds` 为正整数时长。OKX 原始 `ts` 为毫秒字符串，仅下载适配器验证能整除1000后转成秒；图表直接接收已校验秒，不再除1000。禁止靠数量级猜单位。
- 图表 candle 用 `open_time`；柱代表 `[open_time, close_time)`，`close_time=open_time+bar_seconds` 是本项目派生的右开边界，不是交易所返回字段，也不是最后一笔成交时间。
- UTC 数据不平移时区；界面通过 `Intl.DateTimeFormat` 格式化坐标标签、十字线与摘要并显示 IANA 时区。不能发明 `timeScale.timezone` 或按本地时区改写时间戳。
- 所有价格为有限正数 number，单位 USDT；成交量为有限非负 number，单位见历史字段。排序时间唯一严格递增；不把业务数字解析失败当0。
- `content_sha256`：递归按对象键的 Unicode 顺序排序（数组保留顺序），采用 Node `JSON.stringify` 的数字/字符串表示生成无空白 UTF-8 字节，再 SHA-256，输出64位小写十六进制。排除**顶层** `content_sha256` 和本文件的主 ID 字段（history=`dataset_id`，forecast=`forecast_id`，grids=`grid_set_id`）；其余字段全部参与。负零先规范为0，非有限数拒绝。各文件主 ID 为对应 `history:` / `forecast-demo:` / `grids-demo:` 前缀加完整内容哈希。
- 原始响应哈希是收到的原始字节 SHA-256，与规范化 JSON 哈希不同；完整文件字节 SHA-256 可在校验报告额外记录，不放进其自身形成循环。

## history.json：唯一真实历史

| 字段 | 类型/含义 |
| --- | --- |
| `schema_version`, `kind`, `dataset_id`, `content_sha256` | string；kind 固定 `history`；ID/hash按通用规则 |
| `source` | 对象，字段详见下段，真实来源与原始请求证据 |
| `instrument` | string，默认 `BTC-USDT-SWAP`，不得静默换成现货或别家交易所 |
| `market_type`, `price_type` | 固定 `linear_perpetual`、`trade` |
| `base_currency`, `quote_currency`, `settle_currency` | 固定 `BTC`、`USDT`、`USDT` |
| `time_unit`, `timezone`, `bar_seconds` | 固定 `s`、`UTC`、900 |
| `downloaded_at` | 真实抓取完成的 ISO UTC 时间，不伪造为行情时间 |
| `start_time`, `end_time`, `count` | 首柱open_time、末柱close_time（右开）、实际柱数 |
| `quality` | `{excluded_unclosed_count, identical_duplicates_removed, gaps: [], conflicting_duplicates: []}`；计数为非负整数，成功文件后两项必须为空 |
| `candles` | 以下 candle 对象数组，默认连续1,344条 |

每条 candle：`open_time`, `close_time`, `open`, `high`, `low`, `close`, `volume_contracts`, `volume_base`, `volume_quote`, `closed: true`。volume单位依次为**张、BTC、USDT**。不能把合约张数当 BTC 数量。价格满足 `low <= min(open,close) <= max(open,close) <= high`。时间必须满足 `open_time % bar_seconds === 0`、相邻open_time之差等于bar_seconds、末柱close_time不晚于真实downloaded_at转换出的UTC秒。

`source` 必填：`provider: "OKX"`、`endpoint`（默认 `https://www.okx.com/api/v5/market/history-candles`，记录实际使用的官方 HTTPS 完整端点，不静默换域名或来源）、`documentation_url`、`request`（`instId`, `bar: "15m"`, `limit: 300`, `requested_start_time`, `requested_end_time`）、`raw_responses` 数组。每页收据为 `{path, sha256, requested_at, params, response_code}`；path 为项目内相对路径，如 `artifacts/data-source/<capture-id>/page-001.json`，不得路径穿越。params记录该页实际 `instId/bar/limit/after` 或 `before`，其中游标保持交易所要求的毫秒字符串；response_code必须为字符串 `"0"`。原始响应保留在 public 目录外，不由页面加载。

一次性下载约定：先请求首页确认最新可用 `confirm="1"` 完整柱；以其已规范化的 `open_time+bar_seconds` 冻结 `end_time=E`，目标窗口为 `[E-14*86400,E)`；source.request的requested_start_time/requested_end_time使用同一秒制边界。记录相对抓取时刻的截止滞后，不把它自动标为实时。后续以 `after` 向更早分页，不随墙钟推进改变 E；过滤到固定窗口，按开盘升序排列。

OKX 返回 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]`；`ts` 是开盘毫秒，`confirm=1` 才保留。官方端点支持15m，当前每页最多300，20请求/2秒；采用顺序、有限分页和有上限的重试，不轮询。约5页是容量估计，不是成功证据。

相同的重复柱可去重并记录，冲突重复、缺口、非法数值、错误代码或条数不足均不发布成功文件；不补真实行情。失败保留错误报告和此前有效快照。先写临时文件，完成来源、窗口和内容校验后原子替换 `history.json`。更换历史后旧 demo 将不再匹配，生成器必须显式重新生成；页面不能继续显示旧未来为有效关联。

来源：[OKX 官方 history-candles 文档](https://app.okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks-history)。C0只读了文档，没有请求行情 API；可达性、地区限制、真实完整性及再分发条款仍待 C1 核实。没有授权不切换来源，不公开分发行情快照。

## forecast.demo.json：固定演示未来

| 字段 | 类型/含义 |
| --- | --- |
| `schema_version`, `kind`, `forecast_id`, `content_sha256` | kind 固定 `forecast_demo`；ID/hash按通用规则 |
| `demo`, `source_kind`, `label` | 必须为 `true`、`synthetic_fixture`、`DEMO 演示未来，非交易信号` |
| `history_dataset_id`, `history_content_sha256` | 精确引用对应history，ID与hash都校验 |
| `instrument`, `market_type`, `price_type`, `time_unit`, `bar_seconds` | 与history完全相同 |
| `generator_version`, `seed`, `generated_at` | 固定生成器版本string、uint32种子（默认20260912）、ISO UTC逻辑生成时间 |
| `anchor_time`, `anchor_price` | 末柱close_time、末柱close，必须精确相同，不容许偏移一个周期 |
| `horizon_seconds`, `step_seconds`, `future_count` | 默认86400、900、96；horizon_seconds可被step_seconds整除，step_seconds=bar_seconds，future_count=horizon_seconds/step_seconds |
| `stages` | `{id, name, start_time, end_time}` 数组；稳定唯一id和中文标签 |
| `scenarios` | `{id, name, description, points}` 数组，至少3条不同走势 |
| `bands` | `{kind: "illustrative", label: "示意区间，未经校准", points}` |

路径 points 的每项为 `{time, price}`，time须**逐项**等于 `anchor_time+k*step_seconds`（k=1…future_count，本次96），价格为有限正数。未来点必须严格晚于锚点，锚点不放进points。不仅检查开始/结尾和条数，还检查每个节点；三条路径不能数值完全相同。

bands.points 每项为 `{time, inner_lower, inner_upper, outer_lower, outer_upper}`，覆盖完全相同的future_count个节点（本次96），满足 `0 < outer_lower <= inner_lower <= inner_upper <= outer_upper`。锚点处绘图所需的四个边界由 `anchor_price` 在内存补齐，不计入future_count。不要求所有场景都落在内带；外带在本演示夹住三条路径只属生成器设计，不表示概率覆盖。

stages按时间升序、无重叠无缺口覆盖 `[anchor_time, anchor_time+horizon_seconds]`，边界与step对齐。默认三个阶段为0–6h、6–12h、12–24h。归属使用左闭右开，最后阶段包含最终节点；阶段边界点归后一个阶段，折线/区间连续连接，不复制重复time。阶段展示从文件读取。

复现约定：同一history文件、generator_version、seed和固定模板产生字节相同的forecast和grids。`generated_at` 固定取 history.downloaded_at，表示此快照的逻辑生成时间；真实执行时刻放生成收据，不进入fixture。固定PRNG算法及插值/舍入规则随生成器版本冻结，禁止 Date.now()/Math.random() 或不同执行时刻进入fixture。页面刷新/窗口切换不生成文件。

v1 不保存、不显示权重或概率；后续若增加 `demo_weight`，先修订契约并强制“示例权重，非实测概率”、总和1和隐藏不归一化。界面不得从三条场景推断各为1/3。路径间的线性连接仅为视觉表达，不描述真实成交过程。

## grids.demo.json：独立配置与任意模式

| 字段 | 类型/含义 |
| --- | --- |
| `schema_version`, `kind`, `grid_set_id`, `content_sha256` | kind 固定 `grids_demo`；ID/hash按通用规则 |
| `demo`, `source_kind`, `label` | `true`、`synthetic_fixture`、`DEMO 网格配置，未接入收益评估` |
| `history_dataset_id`, `history_content_sha256` | 引用history，和forecast引用一致 |
| `instrument`, `market_type`, `price_type`, `time_unit`, `bar_seconds` | 与history/forecast一致 |
| `anchor_time`, `anchor_price` | 与forecast和末柱收盘边界/价格相同 |
| `horizon_seconds`, `step_seconds` | 与forecast一致，表示配套演示窗口；不表示网格实际生效时间 |
| `generator_version`, `seed`, `generated_at` | 采用上述固定复现规则 |
| `default_scheme_id` | 必须指向schemes中唯一存在的id |
| `schemes` | 以下方案对象数组；演示至少3个，渲染不硬编码数量上限 |

每个方案必填 `id`, `name`, `mode`, `lower_price`, `upper_price`, `distribution`, `interval_count`, `levels`；可选 `initial_position_label` 仅为底仓演示文字。mode为 `{id, label}`，两个值均为非空string，**不设 neutral/long/short 三值枚举**；初始用中性/做多/做空标签，正式产品模式未知时不猜其他模式语义。方案id唯一。

`distribution` 为 `arithmetic` 或 `geometric`（描述层级分布，不是交易模式）；`interval_count=N` 为正整数，`levels` 为严格递增有限正数数组，长度必须 N+1，首尾精确等于lower/upper，lower<upper。校验每个i的理论值：等差 `lower+(upper-lower)*i/N`，等比 `lower*(upper/lower)^(i/N)`，比较容差 `max(1e-8, abs(expected)*1e-10)` USDT。输入允许重复显示模式的不同方案，不允许重复scheme id。

页面只读取levels，不自行以N或模式重新生成。网格线贯穿当前主图，标为当前DEMO参考配置；不声称在历史时段实际运行。网格与场景ID没有对应关系，不要求引用forecast_id（允许独立换路径模板），但历史ID/hash、锚点、口径、粒度、horizon和step必须一致。切换路径/窗口/方案均不改写任一原文件。

不允许收益、胜率、成交、杠杆建议或推荐等级字段。参数摘要可显示“尚未接入评估”。

## 关联校验、错误与验收

加载顺序：读取三文件 → 严格解析/各自字段和hash校验 → 对照history引用/品种/口径/时间和锚点 → 提交可绘制状态。使用同一 `loadDataset()`，不增加数据库或存储驱动框架。

| 失败 | 页面行为与恢复办法 |
| --- | --- |
| history缺失/坏JSON/未知版本/hash或OHLC/连续性错误 | 清理全部价格/未来/网格图层，显示中文原因与 `public/data/history.json`；提示恢复有效快照或显式执行获批的一次下载 |
| forecast无效或关联不匹配 | 有效历史可显示，清理旧路径/带/分界未来标注和依赖future的支撑；未来相关控件禁用，指出文件/字段并提示重生成校验；依赖完整演示坐标的网格一起停绘 |
| grids无效或关联不匹配 | 保留已验证历史与未来，清理所有旧网格线/摘要并禁用方案控件，提示修复配置 |
| 任一重载请求过期 | 丢弃过期结果，避免它覆盖较新的已验证组合 |

错误含文件、字段/行或节点索引（若可得）、原因与修复动作，不展示看似有效的旧图层。不从失败来源回退到随机示例，不把缺数据解释为0。重新校验成功后再启用对应控件。

C1验收必须包含：原始来源收据与哈希重算、固定窗口1,344完整柱、未收盘排除、重复/缺口/OHLC/毫秒误传、全节点/锚点/内外嵌套/阶段、任意模式与N+1、坏JSON/重复键/缺文件/不兼容版本/篡改hash/id冲突，以及同快照同种子生成两次字节比较。测试固定快照，不每次联网拉最新历史。C0未运行这些测试。
