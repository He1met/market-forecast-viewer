# 市场天气预报图表 MVP

状态：2026-09-12 用户确认 C0 基线，授权按 Sequential_Run 串行完成 C1–C5。每阶段技术通过自动继续；C3 保留真实截图与技术验收，用户视觉确认延后至 C5，最终停在“工程交付，待用户视觉验收”。C1–C5实施与工程验证现已完成，用户视觉验收待进行；具体证据以 PROGRESS 为准。

2026-09-12 后续流程授权：Issue #8 设置本机单执行者队列；只额外批准既有图表可理解性修正，试点 #9 必须等待配置审查后由自然定时领取。本规格的图表/数据基线不变，唯一正式队列规则见 AGENTS 的 W0；实际状态见 PROGRESS。

## 目标与默认值

在 Mac 本地浏览器内，用官方 lightweight-charts 显示真实 BTC 历史 K 线、固定 DEMO 多路径、分阶段内外示意区间、历史/未来分界和可切换网格。演示检验图表表达与交互，不检验预测能力。不是 OKX/TradingView 浏览器插件。

| 项目 | C0 采用的演示默认值 |
| --- | --- |
| 历史来源 | OKX 官方 `BTC-USDT-SWAP`，USDT 线性永续，成交价 OHLC |
| 周期/窗口 | 15 分钟；一次性获取最近 14 天连续完整柱，目标 1,344 根；C1 冻结实际 UTC 起止 |
| 未来 | 24 小时，步长 900 秒，96 个未来节点；锚点单独保存 |
| 路径 | 至少冲高回落、下探回升、持续突破三条；路径数从文件读取 |
| 区间 | 内外两层，`kind: illustrative`；标注“示意区间，未经校准” |
| 阶段 | 文件显式定义 0–6h、6–12h、12–24h，可更换阶段定义 |
| 网格 | 初始至少三个演示方案，含中性/做多/做空标签；模式与数量不写死 |
| 视图 | 初始最近约 48h 历史 + 24h 未来；完整历史可向左查看 |
| 窗口/时区 | 6/12/24h 裁切同一份 DEMO；默认浏览器 IANA 时区，可切换 UTC |

无真实预测、收益/胜率/推荐等级、回测、撮合、自动交易、业务行情定时任务、自动更新、数据库、Docker、登录或公网部署。本轮不接入其他大模型、付费大模型 API。来源下载失败明确报告，不能把合成价格写进历史文件。

## 技术选择与官方核对

采用 Vite + TypeScript + 原生 HTML/CSS，一个页面、一个 `loadDataset()` 入口、本地静态 JSON。初始目录没有可复用前端。数据脚本使用 Node；单元验证计划用 Vitest，浏览器验证计划用 Playwright，不引入业务状态管理框架。

C0 查询记录：lightweight-charts 正式包 **5.2.1**；Vite **8.3.0**、TypeScript **7.0.2**、`@playwright/test` **1.63.0** 为查询时版本，均未安装到项目。Vite engines 为 `^20.19.0 || >=22.12.0`，本机 Node 22.22.2 满足。后续建立 package.json 时再固定兼容组合和锁文件，不用查询结果冒充已安装版本。

已完整读取官方编码助手 SKILL，并在临时目录解包 npm 正式 5.2.1 检查 package.json、`dist/typings.d.ts` 及与坐标有关的实现。后续安装后重新检查本项目实际类型，使用 `chart.addSeries(CandlestickSeries, ...)` / `chart.addSeries(LineSeries, ...)`，不混入 v4 的创建方法。`CanvasRenderingTarget2D` 来自 `fancy-canvas`；若代码直接导入其类型，再将匹配版本作为明确直接依赖（5.2.1 包声明 2.1.0），不另起插件项目。

官方资料：

- [编码助手指引](https://github.com/tradingview/lightweight-charts/blob/master/.github/skills/lightweight-charts/SKILL.md)、[API（核对时为5.2）](https://tradingview.github.io/lightweight-charts/docs/api)、[v5 迁移](https://tradingview.github.io/lightweight-charts/docs/migrations/from-v4-to-v5)
- [Series primitives](https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives)、[插件示例](https://tradingview.github.io/lightweight-charts/plugin-examples/)、[WhitespaceData](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/WhitespaceData)
- [Vite 环境要求](https://vite.dev/guide/)、[Playwright 环境要求](https://playwright.dev/docs/intro)、[视觉比较](https://playwright.dev/docs/test-snapshots)
- [OKX 历史行情](https://app.okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks-history)、[Lightweight Charts 署名说明](https://github.com/tradingview/lightweight-charts#license)

采用包内 Apache-2.0 LICENSE；5.2.1 npm包没有NOTICE，交付时从[同一发布tag的官方NOTICE](https://raw.githubusercontent.com/tradingview/lightweight-charts/v5.2.1/NOTICE)保留实际文本。在页面提供 TradingView 署名及链接（保留 `layout.attributionLogo:true`，并提供本地第三方说明），不因资源本地打包删除署名。

## 图表实现与重点验收（设计，尚未实测）

### 1. 未来时间轴与锚点

- 历史 candle 的图表时间是 `open_time`；最后柱占 `[open_time, close_time)`。锚点是最后柱 `close_time` 和 `close`，不是最后柱的开盘标签。分界画在锚点时刻。
- 图表统一使用 UTC 秒。每个历史时点、锚点以及 `anchor_time + k * 900`（k=1…96）进入主图时间轴，不能只加最远端点或依赖 `rightOffset` 制造空白。
- 使用一个常驻 **坐标支撑 LineSeries**：数据为历史 close、锚点和各未来节点内带中点，仅由三份文件在内存派生。设 `visible:true`，关闭 `lineVisible`、`pointMarkersVisible`、`lastValueVisible`、`priceLineVisible`、`crosshairMarkerVisible`，关闭 last-price animation。它不画价格、不进入图例/tooltip、不写回 history，绝不呈现为真实未来 OHLC。
- 十字线设 `crosshair.mode: CrosshairMode.Normal`；不能使用会吸附到该不可见支撑中点的默认Magnet行为。tooltip按时间读取明确的数据文件字段，不把支撑series当作展示数据。
- 选择数值支撑的原因：纯 `WhitespaceData` 可保留时间，但没有价格基值；历史全部移出视口时，只有 candle 的 primitive 也可能无法获得 `priceToCoordinate`。数值支撑同时给纯未来视窗保留坐标基础。这是基于 5.2.1 类型及源码的设计判断，C2/C3 必须用浏览器验证。
- 路径开关只改变对应 LineSeries 的可见性，支撑序列始终保留。每条显示路径在内存前置同一锚点，再接文件的96个未来点；history 不增加任何合成柱。
- 初始化/重置显式设置最近48h历史至所选未来终点的视窗。窗口切换裁切视野，不重生成、不改 ID、不截断原文件。全24h支撑保留，右边距只用于标签呼吸空间。
- 验收：初始看见完整未来；全隐藏路径后仍有未来刻度、分界、区间和网格；平移到只含未来的窗口，坐标仍有效。未来 tooltip 即使没有 candle 也按时间查 DEMO 数值，支撑中点永不冒充一条预测。

### 2. 分阶段区间随图表重绘

- 内外带与分界用官方 series primitive，附着在坐标支撑序列。参考官方 bands 示例的生命周期/renderer 结构，输入采用本项目未来上下界，不使用历史布林带算法。
- 使用 `timeScale().timeToCoordinate()` 和同一右轴支撑序列的 `priceToCoordinate()`。primitive 的 `updateAllViews()`/renderer 按当前坐标重算，保留稳定 view/renderer 对象，不缓存跨缩放的固定屏幕位置。
- 在 `CanvasRenderingTarget2D` 的 media/bitmap 坐标空间正确处理横纵像素比；填充、边界线、阶段文字按图表 pane 裁切，`null` 坐标不当成 0。范围边缘保留相邻节点用于插值，避免平移时边缘断裂。
- 阶段按 `stages` 枚举；内外带每15分钟有上下界，阶段标签在对应时间段内绘制。先画透明外带再画内带，路径/网格/十字线可辨认，不用固定 CSS 阴影盖图。
- resize 使用 `autoSize:true`/ResizeObserver；数据或配置改变调用 primitive 保存的 `requestUpdate`，依靠图表绘制周期处理横纵缩放和 DPR。自建监听需要成对解绑，不依赖不存在的 price-scale 事件。
- 验收：水平缩放/平移、右侧价格轴缩放、两种视口、DPR 1/2、全隐藏路径、纯未来视窗均对齐。与公开坐标转换的关键点相差不超过1 CSS像素；保存真实截图人工检查填充、裁切及标签。首次截图获认可后才作为回归基线。

### 3. 共用价格尺度与 autoscale

- candle、所有路径、坐标支撑均在同一 pane、`priceScaleId:'right'`；右轴采用普通价格尺度。网格价格线也挂在该支撑系列。不得使用各自独立的隐藏价格尺度。
- 支撑序列的 `autoscaleInfoProvider` 与 primitive `autoscaleInfo` 协同：取可见历史 OHLC、可见 DEMO 路径、可见区间上下界及当前网格上下界的并集；包括视窗边界插值值。不让未绘制中点意外单独决定范围，避免回调递归。
- 无可见价格范围时用锚点的有限正数范围兜底。隐藏全部路径仍保留区间与当前网格的范围。手动价格缩放时不强制每帧恢复 autoScale；重置视图恢复自动缩放。
- 验收：同一价格在所有图层具有相同 y 坐标；初始、纯未来和重置视图无可见带/网格被自动尺度裁掉；垂直手动缩放后仍然对齐。

### 4. 网格切换与图层清理

- 独立选择框枚举 `schemes`，不根据选中路径生成网格。摘要同步显示模式、上下界、分布、区间数 N、价格线数 N+1 和可选底仓演示标签。
- 用 `createPriceLine` 为文件 `levels` 绘制水平参考线，贯穿当前主图并标为 DEMO 配置，不表示历史曾使用该方案。网格不设置生效时间，本轮不是成交模拟。
- 保存所有 `IPriceLine` 引用。选择新方案前完成校验；逐个 `removePriceLine`，清空旧数组，再绘制新线并更新摘要/尺度。切换过程不创建第二个 chart，不重复绑定控件监听。显示路径开关不改网格。
- 手动文件重载先解析、校验新组合；通过后一次替换图层和状态。失败清理受影响图层，不能把旧未来留作看似新结果。异步重载用请求序号或 AbortController 丢弃过期结果。
- 整体销毁依次解绑监听、detach primitive、清理价格线/series、移除 chart；每个所有者只清理一次。
- 验收：连续20次切换，活动价格线恰为当前 N+1，无旧线、重复图表或递增监听；路径与网格互不改写。交替窗口/重载/方案切换后对象数量保持有界。浏览器截图与数值/生命周期断言共同验收。

## 页面、错误与离线验收

顶部常驻品种、15m、真实来源、历史截止、演示锚点、当前时区、“DEMO 演示未来｜非交易信号”。图中直接区分真实历史、演示未来和未经校准区间。路径图例用文字与线型，不只靠颜色。未来悬停显示路径和区间值；历史悬停显示真实 OHLC。无示例收益、胜率或真实概率。

提供缩放、平移、十字线、路径独立开关、方案切换、6/12/24h、重置、手动重载和中文错误区。缺文件、坏 JSON、错误版本/品种/id/哈希/锚点依 DATA_CONTRACT 停止受影响图层，显示原因、文件位置与修复办法。

在1440×900和1280×800视口验证，应用控制台无未解释错误。构建资源全部本地；服务已启动且数据已在磁盘后，阻断外部网络仍可打开/重载 localhost 页面。测试记录浏览器、视口、DPR、时区、dataset_id、实际 Git commit（若无则文件哈希），不在测试时拉最新行情。

## 文件计划与阶段关卡

以下为阶段职责与文件划分；C1–C4实际实现已落地，完成证据以PROGRESS为准。不创建空模块：

| 阶段 | 输入、计划文件/输出 | 验收与停止点 |
| --- | --- | --- |
| C0 约定 | 开发包/本机环境 → 五份最小文档 | 目录/Git/版本/官方接口检查与字段方案可审查；C0 已获确认，进入C1 |
| C1 数据 | 获批契约 → `scripts/download-history.mjs`、`make-demo.mjs`、`validate-data.mjs`，`public/data/{history.json,forecast.demo.json,grids.demo.json}`，最小 package/锁文件、相关测试及下载收据 | 官方真实来源、冻结窗口/数量/原始哈希；数据关联验证、错误用例、同输入生成两次逐字节相同。未接图表，完成后报告 |
| C2 真实K线 | C1通过 → `index.html`、`vite.config.ts`、`tsconfig.json`、`src/{main.ts,data.ts,chart.ts,styles.css}`、必要测试/许可证文件 | 127.0.0.1页面、真实来源/截止、K线交互和完整未来坐标支撑；类型/构建/浏览器截图。C2仅真实K线；技术通过继续C3 |
| C3 路径与区间 | 固定三文件/C2 → `src/forecast-band.ts`、路径/分界/图例与相关测试 | 三条路径、内外带、阶段、全隐藏/纯未来/resize/DPR/价轴验证；技术通过继续C4，截图仍待用户最终视觉验收 |
| C4 网格交互 | C3技术通过 → 按需 `src/controls.ts`、网格管理、窗口/重置/重载/错误处理 | 至少三套截图、20次切换、参数独立、坏数据和离线查看；不实现收益计算 |
| C5 审查交付 | C1–C4结果 → 独立只读审查、范围内修复、README实测说明、`artifacts/`证据 | data/type/unit/e2e/build、干净依赖启动和停止、许可证/监听地址、截图人工复核；标为待用户视觉验收，不自动开始预测或更新 |

每阶段记录真实命令与结果；授权以用户消息为准，本次已获 C1–C5 串行实施授权。2026-09-12 用户专项批准建立 GitHub 私有仓库、上传文档和创建任务；使用 `He1met/market-forecast-viewer` 与 Chart MVP 里程碑管理 C0–C5。Issue 创建或依赖完成不授予实施权限；本次已授权推送feat/chart-mvp并维护一个Draft PR；不得合并或改变可见性。仓库当前实测PUBLIC，早期PRIVATE仅为历史记录。
