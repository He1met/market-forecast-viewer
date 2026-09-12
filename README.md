# 市场天气预报图表 MVP

当前状态：**C0已确认，C1–C5已获串行实施授权，正在开始C1。当前尚无可运行页面。** 以 [PROGRESS](docs/PROGRESS.md) 为实时记录；最终待用户视觉验收。

目标是在 Mac 本地浏览器用官方 lightweight-charts 展示真实 BTC 历史、固定 DEMO 多路径/分阶段区间和可切换网格。演示不代表预测能力，不提供交易或收益评估。先验收图表，自动更新另行开发。

## 从哪里读起

- [协作与阶段边界](AGENTS.md)
- [技术方案、文件计划与验收](docs/CHART_MVP.md)
- [history / forecast / grids 字段约定](docs/DATA_CONTRACT.md)
- [实际环境、检查结果与唯一下一步](docs/PROGRESS.md)
- [原始开发包](Codex_Chart_MVP_Development_Pack.md)（原文保留）

## 环境

2026-09-12 C0 检查：macOS 26.6.2 arm64；Node v22.22.2；npm 10.9.7；Git工具2.50.1。本次建仓重新核对 Node/npm/Git 版本一致。最初目录无 Git；用户随后专项批准建立仓库及任务，记录见 PROGRESS。

## GitHub 任务入口

- [私有仓库 He1met/market-forecast-viewer](https://github.com/He1met/market-forecast-viewer)
- [Chart MVP 里程碑](https://github.com/He1met/market-forecast-viewer/milestone/1)
- [C0 文档确认 #1](https://github.com/He1met/market-forecast-viewer/issues/1)：基线已由用户确认。
- [C1 数据 #2](https://github.com/He1met/market-forecast-viewer/issues/2)、[C2 真实 K 线 #3](https://github.com/He1met/market-forecast-viewer/issues/3)、[C3 路径与区间 #4](https://github.com/He1met/market-forecast-viewer/issues/4)、[C4 网格交互 #5](https://github.com/He1met/market-forecast-viewer/issues/5)、[C5 审查交付 #6](https://github.com/He1met/market-forecast-viewer/issues/6)：已授权，按技术依赖串行实施。

Issues 包含输入/输出、验收清单、依赖和停止点；创建任务不等于实施授权。仓库目前仅存文档与 Git 忽略规则；未提供应用开源许可证，未提交行情数据。

Chrome、Edge、Safari已安装，存在Chromium测试缓存。Headless Shell的JavaScript/Canvas 2D/ResizeObserver基础探测成功；完整Chrome for Testing探测曾超时。项目Playwright尚未安装，未执行图表E2E。详情和限制见PROGRESS。

计划技术栈：Vite + TypeScript + 原生页面 + lightweight-charts。C0未安装项目依赖，未启动监听服务。正式开发时固定依赖与锁文件，只绑定 `127.0.0.1`，资源本地打包。

## 后续命令计划——目前均不存在、未验证

| 命令 | 预计阶段/作用 |
| --- | --- |
| `npm ci` | 有package/锁文件后验证干净依赖安装；C0不可用 |
| `npm run data:download` | C1，一次性下载真实历史，失败不覆盖成功快照 |
| `npm run demo:generate` | C1，按固定快照和seed生成两份DEMO |
| `npm run data:validate` | C1，验证三文件及其关联 |
| `npm run dev` | C2，本地开发预览，计划127.0.0.1:5173，strictPort |
| `npm run typecheck`、`npm test` | 按阶段加入类型检查和相关单元测试 |
| `npm run test:e2e` | C2起，真实浏览器交互/截图 |
| `npm run build` | C2起，本地构建 |
| `npm run preview` | 构建后预览，计划127.0.0.1:4173，strictPort |

未来启动/停止说明须在实测后补齐。计划以前台终端 `Ctrl+C` 停止；端口占用时报告占用并改用明确本机端口，不杀未知进程。手动重载只重新读取本地文件，不联网或触发预测。双击 `start.command` 仅在基本流程验收后按需添加。

恢复工作时先读PROGRESS，确认用户授权的下一阶段再操作。本次只允许推送feat/chart-mvp并维护一个Draft PR，不合并或改变可见性，不覆盖本目录原有文件或其他项目。
