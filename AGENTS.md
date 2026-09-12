# 市场天气预报图表 MVP：协作约定

- 默认使用简体中文；代码、命令、路径和专有名词保留原文。
- 每次开工先读本文件、`docs/CHART_MVP.md`、`docs/DATA_CONTRACT.md`、`docs/PROGRESS.md`，检查目录和 Git 状态，再确认用户本次批准的阶段。
- 当前授权：用户已确认 C0 基线并批准按 `Codex_Chart_MVP_Sequential_Run.md` 串行实施 C1–C5；每阶段技术检查通过自动继续。C3 用户视觉确认延后至 C5；最终停在“工程交付，待用户视觉验收”。这替代此前逐阶段审批安排。
- 历史记录（已被后续实施授权扩充）：2026-09-12 用户另行批准创建 GitHub 仓库、Issues 等项目管理内容；本次允许初始化本地 Git、建立私有 `He1met/market-forecast-viewer`、上传文档并创建 Chart MVP 里程碑与 C0–C5 Issues。该授权不包含 C1–C5 实施、行情下载、公开仓库或网站部署。
- 原始输入为 `Codex_Chart_MVP_Development_Pack.md`，保留原文。当前范围/实现计划以 CHART_MVP 为准，字段以 DATA_CONTRACT 为准，实际进度以 PROGRESS 为准；冲突优先遵循用户最新指令，就地修订相应文档。

## 范围与实现原则

- 空项目使用 Vite + TypeScript + 原生 HTML/CSS + 官方 `lightweight-charts`。只使用官方 Codex 进行本轮开发，不接入其他大模型、付费模型 API 或模型服务。
- 真实 BTC 历史、固定 DEMO 路径、独立 DEMO 网格三文件分离。常驻标注“DEMO 演示未来｜非交易信号”；示意区间未经校准，不代表实际预测能力。
- 模式、方案数量和价格层级由网格文件枚举，不把产品模式限制为中性或固定三种。
- 先验收图表。自动更新必须另行批准；本 MVP 不做真实预测、回测、收益计算、交易、WebSocket、定时任务、数据库、Docker、登录、微服务、复杂状态管理或多 Agent 调度平台。
- 每阶段只增加必要文件，不生成空模块，不重构其他项目。未来代码审查可由独立 Codex 只读进行；同一批文件仅一个写入者。

## 安全与数据边界

- 服务仅绑定 `127.0.0.1`，包括 dev 和 preview；端口冲突明确报错。不得监听 `0.0.0.0`、开放公网或部署网站。
- 不修改全局代理、安全设置或 TLS 校验；不安装全局工具。不得覆盖未提交修改、删除用户文件、执行破坏性 reset 或修改其他项目。
- 下载只在获批 C1 后由一次性本地脚本显式触发，使用官方公开市场数据接口，不需要交易密钥。失败如实报告，不伪造、不静默更换来源、不覆盖上次有效快照。
- 页面仅加载本地文件；重载不下载、不预测、不改写数据。资源本地打包，无 CDN、模型请求或凭证读取。
- 允许创建/复用 feat/chart-mvp、按阶段提交并推送该分支、更新现有 #1–#6 与 Chart MVP 里程碑、创建/更新一个 Draft PR（Refs #1–#6）。不直接写 main、不强推、不自动合并、不改变可见性、不关闭 #2–#6。仓库当前实测 PUBLIC；数据/原始响应/大证据留本地并受 .gitignore 排除。

## 库版本、验证与交接

- 后续安装时固定精确版本并生成锁文件。先读实际 `node_modules/lightweight-charts/package.json` 和 `dist/typings.d.ts`，再查对应版本官方文档与[官方编码助手指引](https://github.com/tradingview/lightweight-charts/blob/master/.github/skills/lightweight-charts/SKILL.md)。不要从 master 指引推断正式包中不存在的 API。
- v5 使用 `chart.addSeries(CandlestickSeries/LineSeries, ...)`；只用公开坐标与 primitive 接口。时间、锚点、共用价格尺度与清理规则遵循 DATA_CONTRACT 和 CHART_MVP。
- 验证应覆盖实际风险：C1 数据/关联/复现，C2–C4 浏览器真实图形与交互，C5 独立审查和干净依赖启动。不能只用 DOM 文本断言代替 Canvas 验收。
- 阶段结束更新 PROGRESS：真实执行命令、结果、未验证内容、截图位置、Git 状态及唯一下一步。README 只把实测命令标为可用。
- “实现完成”“测试通过”“待用户视觉验收”“预测有效”不同义；不得虚报完成、收益或预测能力。
