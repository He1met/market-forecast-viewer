# 市场天气 · Chart MVP

Mac 本机图表：真实 OKX BTC-USDT-SWAP 15m 历史、固定 DEMO 多路径/分阶段区间及网格，以及已归档 Codex 实验预报。图表为官方 lightweight-charts 5.2.1，Vite + TypeScript + 原生页面。仅监听 `127.0.0.1`。

M0 与 #9 已通过工程和用户五项视觉验收，#11–#13 已通过单次预报、展示与真实结果核对的工程审查。#14 增加固定版本的两小时业务运行，配置与自然运行验收分别见 [PROGRESS](docs/PROGRESS.md)。Codex 概率属于未来24h事件类别，主观且未经校准；能发布和显示不代表预测准确或盈利。没有收益评估或交易。

## 在当前 Mac 打开

本机已经有经过验证的固定数据，无需重复下载。在项目目录执行：

```sh
cd market-forecast-viewer
npm run dev
```

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。在启动它的终端按 **Ctrl+C** 停止。浏览器刷新或“重载文件”只读取磁盘JSON，不下载行情、不生成新预测。

C5已实际验证干净 `npm ci` 后dev与preview都能启动、显示真实页面、仅监听127.0.0.1，并能停止释放端口。端口被占用时明确报错，不会杀其他进程或偷偷换端口。先确认占用者，只有确认属于本项目的旧服务才停止它；不要杀未知进程。

页面上方选择“固定 DEMO”或“Codex 实验预报”。实验模式读取独立归档，展示当时历史、六类代表路径、各阶段单层范围、24h主观概率、支持/反对依据与失效条件；不显示 DEMO 网格。历史预报选择器可回看已有 run，“读取最新索引”重新核验档案，不触发行情下载或模型调用。6/12/24h只裁切同一预测，概率一直注明未来24h。

实验预报过期、迟到、最新运行失败和加载失败分别提示。加载失败保留原图并明确“旧快照”，不会盖上新的首次发布时间。已核对 run 会叠加实际收盘白色点线，按 6/12/24h 展示已成熟、部分观测或缺数；全部六条代表路径与恒价基准分别列出误差。核对截止与当前到期时间分开，页面刷新不推进评分。24h Brier 只在完整24h成熟后计算，未到期不填0；单条记录的范围覆盖只是描述，不证明校准。

实验档案仍位于 `artifacts/forecast-runs`，不复制到 public/dist。Vite dev 和 preview 在同一进程提供最小只读展示接口，仅响应本机同源 GET，先核对完整归档哈希及契约，再返回指定展示字段；不返回输入原文、提示词、原始输出文件或日志。构建文件本身不包含任何实验预报，脱离本地适配层时会显示读取失败。

## 显式核对已发布预报

使用原始 run_id 执行一次公开行情采集与评分：

```sh
node --import tsx scripts/m1-evaluate.mjs run <run_id>
```

该命令只获取该预报之后、真实当前已完整结束的结果区间（最多24h），不调用预测模型。原始预测保持原档；独立 `artifacts/m1-outcomes/<run_id>` 保存请求来源、失败记录和不可覆盖 evaluation revision。可用 `capture <run_id>` 只采集，`evaluate <run_id> <capture_id>` 对同份来源幂等重算，`read <run_id>` 只读最近状态。补数产生新来源和 revision，旧缺数证据保留。失败状态不以旧成功遮盖；此流程没有新增定时器。完整方法与公式见 [M1规格](docs/M1_FORECAST.md)。

## 安装与恢复

官方本机任务“M1 实验预测运行”按固定发布清单组合旧预报核对和当前新预报生成，与每小时开发任务分开。它只写 LOCAL_ONLY 数据和运行收据；代码、方法或模型配置不符合冻结版本时跳过。页面实验模式另显示最近业务运行、失败和官方配置回读时间，未知的下次执行时间不会推测为已确认计划。关闭页面不会停止该任务。

需要暂停时，在官方桌面应用的定时任务页面暂停该业务任务；本地 `artifacts/m1-runtime/PAUSED` 标志也会阻止新一轮获取数据。恢复前核对该标志归属，再移除标志并恢复官方启用状态。暂停不杀正在结束的命令，不删除活动锁。手动验证、真实自然触发和长期稳定分别记录；Mac/应用/网络离线期间不会事后补造错过的预报。具体运行入口与状态口径见 [M1规格](docs/M1_FORECAST.md)。

已验证环境：macOS26.6.2 arm64，Node22.22.2、npm10.9.7。项目要求Node22.12+，依赖为精确版本并有package-lock。项目没有全局安装要求。

```sh
npm ci
npx playwright install chromium --only-shell --no-remove
```

Playwright固定1.63.0，匹配Chromium Headless Shell153.0.8010.12 / revision1243。安装命令保留其他缓存，不覆盖系统Chrome/Edge。无浏览器测试需求时启动页面只需npm ci。

**公开Git仓库不包含价格文件、原始响应或价格截图。** 当前Mac数据在 `public/data/`，原始收据在 `artifacts/data-source/`，两者均被忽略。复制完整本地工作目录时保留这两个目录；从Git新克隆不会自动获得当前冻结快照。根据 [OKX API Agreement](https://www.okx.com/zh-hans/help/okx-api-agreement) 的数据使用限制，未经允许不要公开发布这些文件或截图。

在没有history文件、且明确需要新的一次性快照时，按顺序执行：

```sh
npm run data:download
npm run demo:generate
npm run data:validate
```

这三个命令均已实际运行。下载使用唯一指定官方端点，首页冻结最新完整柱截止，再向前收集14天；失败明确退出，不伪造、不换源。存在history.json时下载会拒绝覆盖。需要替换时，先在本机备份现有三文件及原始收据，再明确移走旧history后显式重新下载；新快照会有新的ID和时间窗口，不等于本次已验收快照。

生成器根据固定历史、seed与版本生成DEMO；generated_at来自历史下载时间，实际执行时间只进收据。生成失败时不要把旧DEMO当作新关联有效结果。`data:validate` 会重建原始来源、验证三文件并比较可复现字节；缺原始收据时不能声称完整追溯通过。

## 实际验证命令

```sh
npm run data:validate
npm run typecheck
npm test
npm run test:evaluation
npm run test:display
npm run test:runtime
npm run test:e2e
npm run build
npm run preview
```

preview地址为 [http://127.0.0.1:4173](http://127.0.0.1:4173)，Ctrl+C停止。先停止占用5173的dev再执行test:e2e；测试自行启动和停止服务，禁止复用不明服务。测试只使用本地固定快照，不联网下载行情。

C5历史实测：43项数据单元测试、28项浏览器检查；当前 #13 验证见 PROGRESS。浏览器覆盖1440×900、1280×800各DPR1/2、真实Canvas、横纵缩放、拖动、resize、纯未来/全隐藏路径、20次网格切换、重载清理/竞态、错误恢复和阻断外网；另以系统Chrome实测返回缓存恢复。本机服务专项复验可运行 `node scripts/verify-local-servers.mjs`（已实测），5173/4173必须空闲。

## 界面与故障恢复

- 三条DEMO路径可独立开关；内外示意带未经概率校准。隐藏全部路径后时间轴、区间和网格保留。
- 网格模式和数量从文件读取；摘要与价格层级随方案切换，N个区间对应N+1条线。显示开关、路径开关相互独立。
- 6/12/24h裁切同一份数据；重置恢复当前窗口与自动价格尺度；时区切换只改标签，存储仍为UTC秒。
- history无效时清空全部图层；forecast无效时保留真实历史并清未来及依赖网格；grids无效时保留历史和未来、清网格。修复文件后点击“重载文件”。错误会显示具体文件/字段及修复方向。
- “查看价格层级”只展示配置；底仓为演示文字，没有成交/收益逻辑。

## 数据与证据

当前冻结历史：UTC `[2026-08-29T11:30:00Z, 2026-09-12T11:30:00Z)`，1,344完整柱，5页原始响应；下载完成2026-09-12T11:40:21.187Z。dataset_id：`history:7465dca84cd628418018a8ff3f1a7453283669fd6a8bef0a39dc4011ae46f711`。

本地 `artifacts/c1/` 保留来源/生成/校验报告；`artifacts/c2/`–`c4/` 保留分阶段PNG、测试结果与代码哈希。`artifacts/c5/` 保存最终检查、默认/区间/三套网格/缩放/错误PNG及收据。PNG旁JSON注明浏览器、视口、DPR、时区、快照与源码版本。所有截图均为候选验收材料，不能视为用户已批准的回归基线。

最终用户需检查：真实历史与DEMO是否清楚区分；路径是否表达不同过程；方案是否同步改变区间/层级；缩放拖动是否持续对齐；打开/刷新时是否明确知道截止时间。

## 规则与任务

[AGENTS](AGENTS.md) · [功能规格](docs/CHART_MVP.md) · [数据契约](docs/DATA_CONTRACT.md) · [进度](docs/PROGRESS.md) · [本次串行授权](Codex_Chart_MVP_Sequential_Run.md) · [原始开发包](Codex_Chart_MVP_Development_Pack.md)

[仓库](https://github.com/He1met/market-forecast-viewer) · [Chart MVP里程碑](https://github.com/He1met/market-forecast-viewer/milestone/1) · [Draft PR #7](https://github.com/He1met/market-forecast-viewer/pull/7)。Refs [#1](https://github.com/He1met/market-forecast-viewer/issues/1)、[#2](https://github.com/He1met/market-forecast-viewer/issues/2)、[#3](https://github.com/He1met/market-forecast-viewer/issues/3)、[#4](https://github.com/He1met/market-forecast-viewer/issues/4)、[#5](https://github.com/He1met/market-forecast-viewer/issues/5)、[#6](https://github.com/He1met/market-forecast-viewer/issues/6)。不自动合并或关闭需用户验收的Issues。

第三方声明在 `public/licenses/`：lightweight-charts的Apache-2.0 LICENSE及v5.2.1 NOTICE、Zod与fancy-canvas的MIT许可证，页面保留TradingView署名和本地许可索引。没有为本项目另行授予开源许可证。

### 安装版缺产出观察

安装配置可显式提供 `forecast_expected_since`（UTC ISO 时间），表示当前连续启用段的本地预期起点。每次恢复业务时应设为本次启用时间；没有起点显示未知，暂停不累计历史漏报。此字段不证明官方任务已启用，实际调度仍须工具配置回读。状态 GET 只核验最近两个到期 slot 的生产原档；首未来节点加两分钟起判定，单窗口最多校验16份，超限或原档无法核验显示未知。ops 在持锁巡检中对连续两期缺产出生成 warning outbox，同一时段的重复小时观察不算两期；送达仍需官方通知收据。
