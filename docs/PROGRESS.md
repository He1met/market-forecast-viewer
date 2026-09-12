# 开发进度与证据

检查日期：2026-09-12（Asia/Shanghai）。当前阶段：**C0 文档已落地；已按专项授权创建 GitHub 私有仓库及 C0–C5 任务，仍等待用户批准 C1**。没有业务代码、行情下载或图表测试完成记录。

## C0 初次环境与实际检查（历史记录）

| 检查 | 实际结果 |
| --- | --- |
| 当前目录 | `/Users/shenjianpeng/Documents/market-forecast-viewer` |
| 初始文件 | 仅 `Codex_Chart_MVP_Development_Pack.md`（23,810字节）；无前端/package/锁文件/docs |
| AGENTS | 本目录和已检查祖先目录无AGENTS；遵循用户提供的简体中文全局指令，新建本项目AGENTS |
| Git状态 | `git status --short --branch`、`git rev-parse --show-toplevel`、`git remote -v` 均报 `fatal: not a git repository (or any of the parent directories): .git` |
| Git操作 | 未初始化、未提交、未创建分支/远程、未推送；当前commit为不适用，不能称工作区clean |
| 系统 | `sw_vers`：macOS26.6.2 / 25G83；`uname -m`：arm64 |
| 运行时 | `node --version`：v22.22.2；`npm --version`：10.9.7；`git --version`：2.50.1 (Apple Git-155) |
| 可执行路径 | node/npm位于 `/Users/shenjianpeng/.local/bin/`；未修改全局依赖/设置 |
| 浏览器 | 应用plist：Chrome152.0.7977.83，Edge152.0.4191.66，Safari26.6.2 |
| 测试缓存 | `~/Library/Caches/ms-playwright/` 有chromium/headless_shell 1217与1228；实际探测1228版本为Google Chrome for Testing149.0.7827.55 |
| 本项目测试工具 | 没有package.json、node_modules、Playwright配置；缓存存在不等于项目E2E可运行 |
| 网络 | npm元数据、GitHub官方指引/正式包与官方文档可读；没有请求OKX行情API，没有证明真实数据可下载 |

只读元数据命令 `npm view vite version engines --json`、`npm view typescript version --json`、`npm view @playwright/test version engines --json` 成功，分别为8.3.0、7.0.2、1.63.0；vite要求 `^20.19.0 || >=22.12.0`，Playwright包engines要求 `>=20`。使用了20秒网络超时/不自动重试参数；没有执行npm提示的全局升级。

lightweight-charts：`npm view` 查询5.2.1；仅在 `/tmp/chart-mvp-lwc.nic2fg/` 解包正式npm tarball，核对 `package/package.json`、`package/dist/typings.d.ts` 和相关正式包源码。项目未安装，临时目录不作为长期工程依赖。完整读取[官方SKILL](https://github.com/tradingview/lightweight-charts/blob/master/.github/skills/lightweight-charts/SKILL.md)；安装后须重验本地版本/API。

只读包核对SHA-256：tarball为 `64310292298df4dd527494865e5d91d447f8bb397b68de3912c2a6465025ee5e`；typings为 `e3d7cd2e718e92c4f61413f1b15aebb39f20c9e987a138b30e575c7843cc8c71`。包内有LICENSE、无NOTICE，后续使用相同发布tag官方NOTICE，不能写成包内已有。

浏览器基础探测使用临时独立profile和 `data:text/html`，没有启动项目或监听端口：

- 完整 `Google Chrome for Testing` 使用 `--headless=new --dump-dom` 在25秒内未得到DOM，Node `spawnSync` 返回 `ETIMEDOUT`。即使status字段为0，仍按探测失败记录。
- 缓存 `chrome-headless-shell` 使用 `--dump-dom` 成功返回 `{"smoke":"C0_ENV_ONLY","canvas2d":true,"rgba":[18,52,86,255],"resizeObserver":"function","dpr":1}`，exit_code=0。stderr有 `ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.`；2D读回成功，仍保留该诊断，C2需核对真实渲染是否受影响。
- 临时profile已清理；未关闭TLS校验、未修改全局浏览器或安全配置。未用Playwright执行项目测试，未验证DPR2或Safari/Edge实际页面。

原始开发包SHA-256：`dee5d878f2c681ba4ef0afdd56a0ad470e581647afa034b1874589402cc29bff`。该文件保持不变。

## C0 初次交付（历史记录）

创建 `AGENTS.md`、`docs/CHART_MVP.md`、`docs/DATA_CONTRACT.md`、`docs/PROGRESS.md`、`README.md`。原目录没有同类文档，因此没有创建冲突副本。C0仅新增这五份文档；未创建src、public/data、scripts、package、锁文件或项目测试。

已明确 UTC秒与原始毫秒转换、最后完整柱收盘边界锚点、96个未来节点、显式阶段、哈希与固定复现、文件驱动网格和N+1。已给出未来/价格坐标支撑、primitive重绘、共用右轴、autoscale及图层清理的实现计划和验收标准。这些是设计约定，未声称浏览器图表行为已通过。

C0文档核对：五份文档本地Markdown链接均存在；结束时原开发包哈希保持一致，目录仍无.git/package/src/public。两项并行只读复核分别检查官方图表接口及数据契约，已修正一个重复除1000的单位笔误、API链接路径、NOTICE来源和不可见支撑引起Magnet吸附的设计问题。仅为文档复核，不是C5实现审查或应用测试。

## 阶段状态

| 阶段 | 状态 | 证据/下一关卡 |
| --- | --- | --- |
| C0 约定 | 文档已形成，等待用户确认 | 本文环境记录及其余四份文档；没有运行功能测试 |
| C1 数据 | 未批准、未开始 | 待真实下载/三文件/原始收据/哈希/复现与数据测试 |
| C2 真实K线 | 未批准、未开始 | 待本地页面/未来轴/实际types/build/浏览器截图 |
| C3 路径与区间 | 未批准、未开始 | 待多路径/区间/坐标缩放与第一轮视觉验收 |
| C4 网格交互 | 未批准、未开始 | 待方案/窗口/重载/错误/20次切换与离线验证 |
| C5 审查交付 | 未批准、未开始 | 待独立审查、范围内修复、全套交付证据和用户验收 |

## 阻塞、风险与未验证项

- **C0无剩余技术阻塞；下一阶段的推进条件是用户批准。** 最初无 Git/远程不阻塞开发；后续用户专项批准建仓，当前结果见下。
- OKX行情API的本机可达性、地区权限与14天完整数据尚未验证；属于C1待检查项，目前不能称“下载失败”或“行情已可用”。若失败，报告实际错误并停止发布数据，不静默切源。
- 项目依赖尚未安装，实际固定组合/锁文件/类型检查、npm脚本、构建均未验证。官方文档和临时包核对不等于项目安装成功。
- 已有一种基础浏览器探测成功；完整Chrome无头超时是后续E2E的已知风险。C2锁定Playwright后先验证与其匹配的浏览器，不以缓存revision强行声明兼容。不得通过改安全设置规避失败。
- 坐标支撑、纯未来autoscale、primitive的垂直缩放/DPR、图层清理、断外网后的页面加载仍全部未实现/未测试。数据源再分发条款和最终许可证材料在相应交付前核实。

## 2026-09-12 GitHub 建仓与任务初始化

用户请求：“读取本目录中的 Codex_Chart_MVP_Development_Pack.md以及本地的实际情况，在github上创建所需要的仓库、issue等内容。”本次据此建立私有仓库、上传现有文档与创建任务；不把管理动作视作 C1–C5 实施授权。

本次读取开发包、AGENTS、三份 docs 和 README；目录初始仅这六份 Markdown，无 `.git`、package、代码、数据。重新运行 Node/npm/Git 版本检查，分别为 v22.22.2 / 10.9.7 / 2.50.1。未重跑历史浏览器或官方库检查。原始开发包 SHA-256 仍为 `dee5d878f2c681ba4ef0afdd56a0ad470e581647afa034b1874589402cc29bff`。

### 已执行的管理命令与结果

- `gh api user --jq .login`：当前账号 `He1met`；仓库列表检查未发现同名项目。
- `gh repo create He1met/market-forecast-viewer --private --description … --disable-wiki`：成功创建 [私有仓库](https://github.com/He1met/market-forecast-viewer)。未指定公开需求，采用私有可见性。
- `gh api repos/He1met/market-forecast-viewer/{labels,milestones,issues} --method POST --input -`：通过结构化 JSON 依次创建 3 个任务标签、1 个 [Chart MVP 里程碑](https://github.com/He1met/market-forecast-viewer/milestone/1)、6 项 Issues；没有创建 Project、PR、自动化或部署。
- `git init -b main`、`git remote add origin https://github.com/He1met/market-forecast-viewer.git`：成功建立本地 Git 和 origin。
- `gh repo view … --json nameWithOwner,visibility,url,hasIssuesEnabled`：实测 `PRIVATE` 且 Issues 已启用；`gh issue list … --state all --json number,title,state,labels,milestone,url` 确认六项全部 OPEN 且关联 Chart MVP。

| 阶段 | GitHub Issue | 当前状态 |
| --- | --- | --- |
| C0 | [#1 环境与文档约定确认](https://github.com/He1met/market-forecast-viewer/issues/1) | 文档已落地，`status:awaiting-confirmation`；未代替用户关闭 |
| C1 | [#2 真实历史快照、固定 DEMO 与数据校验](https://github.com/He1met/market-forecast-viewer/issues/2) | 未批准、未开始 |
| C2 | [#3 真实 K 线页面与完整未来时间坐标](https://github.com/He1met/market-forecast-viewer/issues/3) | 未批准、未开始 |
| C3 | [#4 DEMO 多路径、分阶段区间与视觉验收](https://github.com/He1met/market-forecast-viewer/issues/4) | 未批准、未开始 |
| C4 | [#5 独立网格切换、窗口与重载错误处理](https://github.com/He1met/market-forecast-viewer/issues/5) | 未批准、未开始 |
| C5 | [#6 独立只读审查、验证与本地交付](https://github.com/He1met/market-forecast-viewer/issues/6) | 未批准、未开始 |

C1–C5 均带 `status:awaiting-approval`；每项含前置依赖、计划输出、验收清单、证据和停止点。字段引用 DATA_CONTRACT，未复制出第二套字段定义。尚未有功能实现，不创建空功能分支或 PR。

本次就地修订 AGENTS/CHART_MVP/README/PROGRESS，记录建仓专项授权和任务入口；新增 `.gitignore` 排除依赖、凭证、构建、生成行情与大量证据。保留原始开发包与 DATA_CONTRACT 不变。提交范围限定六份现有文档和 `.gitignore`；本次无业务测试、无图表截图，仍无可运行 npm 命令。

### 文档归档验证

- Python 检查现有文档的本地 Markdown 链接、原始开发包 SHA-256 及无实现文件：PASS；`git diff --cached --check`：通过。
- `git add .gitignore AGENTS.md README.md Codex_Chart_MVP_Development_Pack.md docs/CHART_MVP.md docs/DATA_CONTRACT.md docs/PROGRESS.md` 后执行 `git commit -m 'docs: archive C0 specification and GitHub stage tracking'`：成功，归档提交为 `eb843d1ec44a3755f3630dffdca35f0317a7ddfa`，共 7 个文件。
- `git push -u origin main`：成功。`git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main` 在该归档检查点均为上述完整 commit；`git status --short --branch` 输出 `## main...origin/main`，无未提交文件。
- 逐一使用 GitHub contents API 读取 main 的 7 个文件，Base64 解码后与本地原始字节比较：全部一致。里程碑回读为 OPEN、6 个 open Issues、0 个 closed Issues。
- 此段是归档检查点之后的验证记录补充，随独立文档提交保存；当前最终 commit 以 `git log -1` 与远程 main 为准，避免在文档中形成自引用哈希。

历史停止点：当时等待C1授权；已由下面的新授权替代。

## 2026-09-12 串行实施授权与当前恢复点

用户已确认 CHART_MVP/DATA_CONTRACT 基线，授权 C1–C5 串行实施，技术通过自动继续；C3真实截图保留，用户视觉确认延至C5。最终停在“工程交付，待用户视觉验收”；不授权预测、更新、收益或交易。执行文件为 `Codex_Chart_MVP_Sequential_Run.md`。

实际基线：main/origin/main均为 `f4b4bf77dc99f619084088998d82a4f41bdea57d`；仅新执行文件未跟踪。已切换新建feat/chart-mvp，保留用户文件。GitHub现为PUBLIC（本轮未改变），#1–#6均OPEN，无PR；此前PRIVATE仅为历史建仓记录。数据和原始响应/大量证据继续忽略，不公开分发。

当前：C0已获用户确认；C1正在实施，C2–C5已授权未开始。用户页面验收尚未发生。下一动作：安装最小依赖，实施真实下载/固定DEMO/数据校验；通过后进入C2。无当前技术阻塞。
