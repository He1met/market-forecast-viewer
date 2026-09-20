# 项目材料与下载索引

用户已[明确授权](https://github.com/He1met/market-forecast-viewer/issues/15#issuecomment-5751861127)将项目原始行情、模型完整输出、截图、日志和备份发布到本仓库。[Issue #40](https://github.com/He1met/market-forecast-viewer/issues/40)跟踪实际附件交付与独立检查。

六个附件已于2026-09-21 05:08（上海时间）完成上传、全部下载及逐件SHA256/大小核对，总计1,087,127,379字节。[本次Release](https://github.com/He1met/market-forecast-viewer/releases/tag/materials-20260921-041032)已公开；附件交付与源码PR合并分别核验。核心、审计补充和导出源码均有独立审查，详见下方依据。

| 附件 | 大小 | 用途 |
| --- | ---: | --- |
| [materials-01.zip](https://github.com/He1met/market-forecast-viewer/releases/download/materials-20260921-041032/materials-01.zip) | 478,148,048字节 | 核心资料第1卷，含总清单 |
| [materials-02.zip](https://github.com/He1met/market-forecast-viewer/releases/download/materials-20260921-041032/materials-02.zip) | 475,079,072字节 | 核心资料第2卷 |
| [materials-03.zip](https://github.com/He1met/market-forecast-viewer/releases/download/materials-20260921-041032/materials-03.zip) | 57,992,204字节 | 核心资料第3卷 |
| [volumes.json](https://github.com/He1met/market-forecast-viewer/releases/download/materials-20260921-041032/volumes.json) | 2,649,115字节 | 三卷SHA和完整成员列表 |
| [audit-evidence.zip](https://github.com/He1met/market-forecast-viewer/releases/download/materials-20260921-041032/audit-evidence.zip) | 73,254,761字节 | 独立核验、失败/通过测试日志、截图核查和单独的自然巡检补充 |
| [audit-volumes.json](https://github.com/He1met/market-forecast-viewer/releases/download/materials-20260921-041032/audit-volumes.json) | 4,179字节 | 审计卷SHA和成员列表 |

三个核心ZIP解压到同一新文件夹；审计ZIP解压到另一个文件夹。每组的`manifest.json`按原逻辑路径指向`objects/<export_sha256>`中的完整实际文件，可据此查找行情、模型全文、截图或日志；不能把审计组的manifest覆盖核心组。

核心保留71,388条逻辑内容，去重为31,528对象、965,228,260字节；61个原压缩归档按成员展开。审计组47条材料、45个对象。原始源另有4,234条排除记录，覆盖726,188个原逻辑文件，清单在核心的`fixed-source-inventory.json`映射中；不是原档零排除。历史备份单独保留14份/86,881逻辑映射，其中2,925个允许对象可下载；被排除内容仍有原因和已知元数据。

正式业务数据采集于上海时间03:39:11；允许来源的固定复制在04:09:25–04:10:32进行，前后完整枚举一致，每个允许文件逐SHA/大小核对。04:18自然巡检的started/result于04:21单独采集，属于审计补充。04:29备份入口前停止及04:31提示修正晚于这些材料边界，已在状态页公开说明，原材料留待后续增量；不因此重抽预测或暂停业务。

## 材料来源

- 正式运行的数据快照：原始行情、冻结输入与提示词、完整模型输出、发布结果、实际结果核对、研究计划/机会、失败和观察记录。
- 正式备份：每个历史manifest对应的原文件名、原对象哈希，以及允许发布的对象内容；经脱敏的副本有单独哈希，不冒充原生产恢复包。
- 开发证据：测试实际日志、检查结果、截图和交付记录。合成测试明确标注，不能代替自然运行或方法效果。
- 代码与配置说明：源代码由Git保存；运行版本、模型、频率和研究参数用非敏感字段说明。凭证与私密安装配置不进入公开附件。

## 原档、去重与隐私

本地原档不改写。公开清单区分逻辑文件数、去重对象数、原始字节和发布字节；每个逻辑文件对应下载对象，修改过的文件同时给原SHA、发布SHA及修改原因。多个文件共享一个对象时，保留每个原文件的映射。

认证存储、凭证、私密锁/安装身份、账户私密信息及无关对话不读取或发布。已知禁止对象使用现有备份清单的哈希/大小记录排除，不打开内容。配置整文件排除时，必要的模型、频率、版本和研究设置另列允许字段。

文本及嵌套JSON、转义字段、日志、归档内容均检查；截图按SHA去重后做文字筛查，命中、低置信度、非纯项目页面和全屏截图再逐图视觉审查。OCR不是安全批准。未知内容保持明确待检查状态，不上传。任何待检查项、源变化、文件遗漏或哈希错误都会阻止该份导出通过验证。

依赖、构建缓存和重复恢复树不会直接重复上传；排除清单说明范围与原因。实际模型全文和实际日志仅精确脱敏，不用摘要替代。公开工具不上传、不调用模型、不更改原档或业务设置。

## 工具与验证

`scripts/export-project-materials.py`生成内容寻址对象及清单，`verify`重新检查清单和全部对象。准备、独立审查、打包、上传和远端下载校验分别留证。业务互斥只覆盖短暂一致性快照，不跨文字检查、OCR、压缩或上传持锁。

使用Python 3运行，输入spec列出来源名称/目录、采集时间、明确排除规则及每个截图SHA绑定的OCR与视觉审查记录。识别出的未知编码二进制保持待检查；与编码相似的普通类型名/路径/哈希串，只有精确token、SHA、来源和原因经过独立核查后，才能加入`literal_token_reviews`。该记录仅跳过编码误判，其他敏感字段和路径仍需净化。输出目录必须是新目录，且不能位于任何来源目录内。

```sh
python3 scripts/export-project-materials.py prepare spec.json prepared
python3 scripts/export-project-materials.py verify prepared MANIFEST_SHA256
python3 scripts/export-project-materials.py bundle prepared MANIFEST_SHA256 new-volumes
```

`bundle`只打包清单和被引用且校验通过的对象，不包含本地`pending`目录。分卷索引保存每卷SHA、大小和成员名。内部对象一致性不等于源覆盖：还必须由独立清点比对每个源路径、原SHA、大小、嵌套成员、备份逻辑映射和排除子树。仅本轮可变导出工作目录明确置于快照外；工具、测试和最终审查证据单独归档。

本次图片核查覆盖687张独立PNG和196张嵌套录制JPEG，按SHA与OCR记录绑定；逐张联系表视觉检查确认项目页面、图表、状态面板或空白初始帧，未见其他应用或账户界面。未声称全分辨率逐字阅读小字；中文OCR存在低置信限制，识别无命中不单独构成安全保证。独立审查已核对图片映射、审查记录并抽查原图，完整范围和限制见[核心审查](https://github.com/He1met/market-forecast-viewer/pull/41#issuecomment-5752468886)、[审计补充审查](https://github.com/He1met/market-forecast-viewer/pull/41#issuecomment-5752485748)及[精确源码审查](https://github.com/He1met/market-forecast-viewer/pull/41#pullrequestreview-5261705150)。未来新增材料仍须逐批核对，不沿用本批结论。
