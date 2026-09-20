import './styles.css';
import { loadDataset, type Dataset } from './data';
import { WeatherChart, colors } from './chart';
import { gridPosition, generationExplanation } from './demo-explanation';
import { loadDisplayIndex, loadDisplayRun, loadRuntimeDisplay, type DisplayRun, type DisplayIndex, type RuntimeDisplay } from './m1-display';
import { toExperimentChart, CATEGORY_LABELS, CATEGORY_DEFINITIONS } from './chart-model';
import { CATEGORY_STYLE, rankProbabilities, topProbabilityIds, probabilityStyle, formatProbability, displayTime, runtimeHeadline } from './forecast-presentation';
const $ = (id:string) => document.getElementById(id)!;
let view:WeatherChart|undefined, dataset:Dataset={errors:[]}, request=0, controller:AbortController|undefined;
$('app').innerHTML=`<header><div class="brand"><span class="brand-icon">◒</span><div><h1>市场天气</h1><p>MARKET WEATHER / BTC</p></div></div><div class="demo-badge">DEMO 演示未来｜非交易信号</div><div class="header-note">本地历史快照 <span class="dot"></span></div></header><main><section class="market-head"><div><span class="eyebrow">OKX · USDT 线性永续</span><h2>BTC <span>/ USDT</span> <small>15m</small></h2></div><div id="metadata" class="metadata">正在读取本地数据…</div></section><section class="chart-shell"><div class="toolbar"><div id="legend"></div><div id="controls"><select id="window" aria-label="未来展示窗口"><option value="6">未来 6h</option><option value="12">未来 12h</option><option value="24" selected>未来 24h</option></select><button id="reset">重置视图</button><select id="timezone" aria-label="显示时区"><option value="Asia/Shanghai" selected>北京时间</option><option value="local">浏览器时区</option><option value="UTC">UTC</option></select><button id="reload">重载文件</button></div></div><div class="demo-context"><p>未来为固定 DEMO 情景路径，不是本轮 Codex 市场预测；区间未经校准。 <strong>概率：未计算（固定 DEMO）</strong></p><details id="generation"><summary>生成依据</summary><div id="generation-content"></div></details></div><div id="chart" role="img" aria-label="BTC真实历史与DEMO未来图表"></div><div class="chart-foot"><span id="hover">移动十字线查看数据</span><span>滚轮缩放 · 拖动平移 · 拖动右轴缩放价格</span></div></section><div id="errors" role="alert" hidden></div><section class="grid-controls"><div class="grid-picker"><label for="scheme">DEMO 网格方案</label><select id="scheme" aria-label="网格方案"></select><label class="grid-visible"><input id="grid-visible" type="checkbox" checked>显示网格</label></div><div><div id="grid-summary"></div><small id="position-label"></small><p id="grid-position"></p></div><details id="levels"><summary>查看价格层级</summary><div id="level-values"></div></details></section><section id="detail" class="detail"><p>内层 / 外层示意区间 · 未经校准 · 路径仅为固定演示模板</p><span id="load-status" role="status">正在读取文件…</span></section><footer><span>数据来源 <a href="https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history" target="_blank" rel="noreferrer">OKX 官方公开接口</a> · <span id="dataset-id"></span></span><span>仅作演示 · <a href="/licenses/index.html" target="_blank">第三方声明</a> · <a href="/licenses/lightweight-charts-LICENSE.txt" target="_blank">Apache-2.0</a> · <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a></span></footer></main>`;
let experimentLoadFailed=false;
let selectionMode:'follow_latest'|'history_pinned'='follow_latest';
let activeMode:'demo'|'experiment'='demo', experiment:DisplayRun|undefined, experimentIndex:DisplayIndex|undefined;
const modeBar=document.createElement('section');modeBar.className='mode-bar';
modeBar.innerHTML='<label>查看内容 <select id="mode" aria-label="查看内容"><option value="demo">固定 DEMO</option><option value="experiment">Codex 实验预报</option></select></label><label id="run-picker" hidden>历史预报 <select id="run" aria-label="历史预报"></select></label><button id="latest" hidden>返回最新</button><button id="history-more" hidden>更早的30期</button><span id="run-status" role="status"></span>';
document.querySelector('.chart-shell')!.before(modeBar);
const runtimePanel=document.createElement('details');runtimePanel.id='runtime-panel';runtimePanel.hidden=true;
runtimePanel.setAttribute('aria-label','实验预测业务运行状态');
runtimePanel.innerHTML='<summary class="runtime-heading">运行详情 <span id="runtime-status" role="status">业务状态尚未读取</span></summary><div id="runtime-details"></div><p class="runtime-help">关闭页面不会停止业务任务。暂停方式：在 Codex 应用中暂停“M1 实验预测运行”；正在执行的轮次需安全结束，暂停不等于终止当前进程。此处每分钟只读取运行状态；“返回最新”更新预报显示，不触发预测、下载或评分。</p>';
$('detail').before(runtimePanel);
const headline=document.createElement('section');headline.id='forecast-headline';headline.hidden=true;headline.innerHTML='<p id=forecast-summary></p><p id=operation-summary role=status>当前运行待核验</p><p id=new-forecast role=status hidden></p>';modeBar.after(headline);
const board=document.createElement('div');board.className='forecast-board';const shell=document.querySelector('.chart-shell')!;shell.before(board);board.append(shell);
const probabilities=document.createElement('aside');probabilities.id='probabilities';probabilities.hidden=true;probabilities.innerHTML='<h3>未来24h · 六类概率</h3><p>主观判断，未经校准</p><button id=emphasize-top aria-pressed=false>突出前三（含并列）</button><p class=probability-note>线宽与清晰度表示类别概率，不表示精确命中折线。6/12h仅裁切同一份预报。</p>';board.append(probabilities);
let topOnly=false,latestRuntime:RuntimeDisplay|undefined;
const selectedZone=()=>select('timezone').value==='local'?Intl.DateTimeFormat().resolvedOptions().timeZone:select('timezone').value;
const timeLabel=(value:string|number|null|undefined)=>displayTime(value,selectedZone());
let runtimeRequest=0,runtimeController:AbortController|undefined;
const runtimeStatusLabels:Record<string,string>={running:'运行中',completed:'成功完成',failed:'运行失败',late:'新预报发布迟到',skipped:'本轮已跳过'};
const runtimeStageLabels:Record<string,string>={check_release:'核验固定发布版本',score_old:'核对旧预报',collect_events:'收集公开事件',prepare:'冻结最新输入',generate:'生成并校验预报',publish_index:'发布只读索引',done:'流程结束',unknown:'阶段未知'};
function renderRuntime(runtime:RuntimeDisplay){
 latestRuntime=runtime;$('operation-summary').textContent=runtimeHeadline(runtime);
 const attempt=runtime.latest_attempt;
 $('runtime-status').textContent=runtimeHeadline(runtime);
 runtimePanel.dataset.state=runtime.paused?'paused':runtime.release_integrity==='changed'?'unknown':attempt?.status??'unconfigured';
 const target=$('runtime-details');target.replaceChildren();
 const add=(text:string)=>{const p=document.createElement('p');p.textContent=text;target.append(p);};
 const configuration=runtime.configuration;
 add(configuration?`配置回读：每 ${configuration.frequency_hours} 小时；调度时区：${configuration.time_zone??'未知'}；回读时${configuration.enabled?'启用':'暂停'}（${timeLabel(configuration.read_back_at)}）。官方当前启用状态未实时回读。`:runtime.source==='installed'?'官方任务配置未接入本页；请在Codex任务中查看启用状态。':'业务任务未配置：尚无已核验的官方配置回读。');
 add('下次官方计划时间：未知（官方入口未提供可读取的下次时间，不按频率推算）。');
 add(runtime.release_integrity==='verified'?'固定发布文件与所列代码字节核验一致；此项不代表本轮已运行成功。':runtime.release_integrity==='changed'?'当前发布文件或代码已改变，业务入口将拒绝使用当前版本。下面的成功或失败记录属于原轮次，未伪造新的运行尝试。':runtime.release_integrity==='unknown'?'固定发布版本核验未知：缺少可读取的绑定资料或无法校验；下面仅展示历史运行记录。':'固定发布版本尚未配置。');
 if(attempt){
  const reason=attempt.reason==='code_changed'?' · 代码或模型配置变更，未使用变更版本运行':attempt.reason==='publication_late'?' · 发布迟到，不能作为最新有效预报':attempt.reason==='runtime_failed'?' · 本轮流程失败，旧预报首次发布时间不变':attempt.reason==='unknown'?' · 原因未知':attempt.reason==='lock_busy'?' · 写入锁占用':attempt.reason==='paused'?' · 暂停': '';
  add(`最近业务尝试：${runtimeStatusLabels[attempt.status]}${reason}；${attempt.trigger==='scheduled'?'自然触发':'手动验证'}；${runtimeStageLabels[attempt.stage]}。`);
  add(`开始 ${timeLabel(attempt.started_at)}；${attempt.completed_at?'结束 '+timeLabel(attempt.completed_at):'最后记录 '+timeLabel(attempt.updated_at)+'，是否仍在执行须由本机任务确认'}。`);
  if(attempt.forecast_id)add(`本轮预报：${attempt.forecast_id}`);
 }else add('最近业务尝试：暂无记录。开发定时任务不计入业务运行。');
 add(runtime.last_success?`${runtime.source==='installed'?'最近预报发布成功':'最近业务成功'}：${timeLabel(runtime.last_success.completed_at)} · ${runtime.last_success.forecast_id}`:'最近业务成功：暂无已记录的完整成功流程。');
 if(runtime.publication_health){const health=runtime.publication_health;const label={paused:'暂停，不累计缺产出',unknown:'产出核验未知',waiting:'尚无启用后到期时段',current:'最近到期时段已有及时有效预报',stalled:'更新停滞：到期时段缺少及时有效预报'}[health.status];add(`产出检查：${label}。依据本地计划推导，不代表官方任务实际触发或调用失败；启用起点：${timeLabel(health.expected_since)}。`);}
 if(runtime.inspection){const inspection=runtime.inspection;const label={unknown:'尚无巡检观察',fresh:'巡检观察在90分钟内',stale:'巡检信息陈旧（超过90分钟）',clock_invalid:'巡检时间异常，不能判断健康'}[inspection.freshness];add(`巡检：${inspection.paused?'暂停；':''}${label}；最近结果：${inspection.result==='ok'?'已取得必要结果':inspection.result==='failed'?'存在未解决异常':'未知'}；实际观察时间：${timeLabel(inspection.last_observed_at)}。状态读取不会刷新巡检时间。`);}
 add('告警：可在 Codex 的预测、巡检与备份任务中查看本轮摘要；本页未接入事件明细。外部推送未接入；任务呈现及用户确认送达均未验证，读取页面不确认或清除告警。');
 add(`状态读取时间：${timeLabel(runtime.checked_at)}。${runtime.paused?'本地暂停会阻止后续新轮次；正在执行的轮次保留原状态。':''}`);
}
async function reloadRuntime(){
 const id=++runtimeRequest;runtimeController?.abort();runtimeController=new AbortController();
 try{const runtime=await loadRuntimeDisplay(runtimeController.signal);if(id!==runtimeRequest)return;renderRuntime(runtime);}
 catch{if(id!==runtimeRequest)return;runtimePanel.dataset.state='unknown';$('runtime-status').textContent='业务状态读取失败 · 当前状态未知';$('operation-summary').textContent='业务状态读取失败 · 当前状态未知';latestRuntime=undefined;$('runtime-details').textContent='本次无法读取或校验业务状态。预报图保留已加载快照，不把旧预报视为本次业务成功；可点击“返回最新”重试。';}
}
const experimentDetails=document.createElement('section');experimentDetails.id='experiment-details';experimentDetails.hidden=true;
experimentDetails.innerHTML='<details id=forecast-basis><summary>预测依据</summary><div id="experiment-summary"></div><div id="scenario-evidence"></div></details><details id=results-learning><summary>结果与学习</summary><section id="evaluation"><h3>实际走势与结果核对</h3><p id="evaluation-status"></p><div id="evaluation-content"></div></section><section id="history-learning"><h3>历史与学习</h3><div id="history-learning-content"></div></section></details>';
runtimePanel.before(experimentDetails);
const demoContext=document.querySelector('.demo-context') as HTMLElement;
const demoBadge=document.querySelector('.demo-badge') as HTMLElement;
const gridControls=document.querySelector('.grid-controls') as HTMLElement;
const detailText=$('detail').querySelector('p')!;
const select=(id:string)=>$(id) as HTMLSelectElement;
function updateMeta(){if(activeMode==='experiment'){updateExperimentMeta();return;}const h=dataset.history;if(!view||!h){$('metadata').textContent='历史数据不可用';$('dataset-id').textContent='无有效快照';return;}$('metadata').textContent=`历史截止 ${view.format(h.end_time,true)}\n演示锚点 ${dataset.forecast?view.format(dataset.forecast.anchor_time,true):'不可用'} · ${view.zone}`;$('dataset-id').textContent='快照 '+h.dataset_id.slice(8,20);$('dataset-id').title=h.dataset_id;}
function hover(t:number|undefined){if(activeMode==='experiment'){hoverExperiment(t);return;}if(!view||t===undefined){$('hover').textContent='移动十字线查看真实历史 / DEMO未来数值';return;}const c=dataset.history?.candles.find(c=>c.open_time===t);if(c){$('hover').textContent=`${view.format(t,true)} · 真实历史  O ${c.open}  H ${c.high}  L ${c.low}  C ${c.close}`;return;}const f=dataset.forecast,idx=f?Math.round((t-f.anchor_time)/f.step_seconds)-1:-1,b=f?.bands.points[idx];$('hover').textContent=b&&f?`${view.format(t,true)} · DEMO ${f.scenarios.filter(s=>view!.paths.get(s.id)?.options().visible).map(s=>s.name+' '+s.points[idx].price.toFixed(2)).join(' / ')}\n内带 ${b.inner_lower.toFixed(2)}–${b.inner_upper.toFixed(2)} · 外带 ${b.outer_lower.toFixed(2)}–${b.outer_upper.toFixed(2)} · 未经校准`:`${view.format(t,true)} · 演示锚点，无真实未来 OHLC`;}
function updateGrid(){if(activeMode==='experiment'){view?.setGrid(undefined);return;}const scheme=dataset.grids?.schemes.find(s=>s.id===select('scheme').value);view?.setGrid(($('grid-visible')as HTMLInputElement).checked?scheme:undefined);$('grid-summary').textContent=scheme?`${scheme.mode.label} · ${scheme.distribution==='arithmetic'?'等差':'等比'} · ${scheme.lower_price.toFixed(2)}–${scheme.upper_price.toFixed(2)} USDT · ${scheme.interval_count} 区间 / ${scheme.levels.length} 条价格线`:'网格配置不可用';$('level-values').textContent=scheme?scheme.levels.map((p,i)=>`${i}: ${p.toFixed(2)}`).join('　 /　 '):'';$('position-label').textContent=scheme?`方向只是配置标签；未模拟底仓、未生成实际订单。${scheme.initial_position_label??'文件未提供底仓说明。'}`:'底仓说明不可用';const stats=scheme&&dataset.grids?gridPosition(dataset.grids.anchor_price,scheme.levels):undefined;const percent=(n:number)=>`${n>0?'+':''}${n.toFixed(2)}%`;$('grid-position').textContent=stats?`来源：文件中的 DEMO 参数 · 相对锚点：下界 ${percent(stats.lowerPercent)} / 上界 ${percent(stats.upperPercent)}\n价格线：锚点下 ${stats.below} / 等于锚点 ${stats.equal} / 锚点上 ${stats.above}；完整区间：下方 ${stats.intervalsBelow} / 上方 ${stats.intervalsAbove} / 跨锚点 ${stats.intervalsCrossing}（端点等于锚点的区间计入对应一侧）`:'相对边界与锚点统计不可用';$('levels').hidden=!scheme;}
function updateExplanation(){
 const target=$('generation-content');target.replaceChildren();
 const add=(text:string)=>{const p=document.createElement('p');p.textContent=text;target.append(p);};
 add(dataset.history?`真实历史：${dataset.history.source.provider} 官方历史快照；合成未来仅用于显示验证。`:'真实历史不可用，无法核验配套 DEMO。');
 const f=dataset.forecast;
 if(!f){add('DEMO 元数据不可用；请修复文件后重载。');return;}
 add(generationExplanation(f));
 add(`未来来源：${f.source_kind} · generator_version：${f.generator_version} · seed：${f.seed}`);
 add(`演示锚点：${view?.format(f.anchor_time,true)??f.anchor_time} · ${f.anchor_price} USDT`);
 for(const scenario of f.scenarios)add(`${scenario.name}：${scenario.description||'文件未提供描述。'}`);
 const g=dataset.grids;
 add(g?`网格来源：${g.source_kind} · generator_version：${g.generator_version} · seed：${g.seed}。边界和价格层级直接来自独立网格文件，不由路径推导。`:'网格元数据不可用。');
}
async function reloadDemo(){const id=++request;controller?.abort();controller=new AbortController();$('load-status').textContent='正在校验本地文件 · 当前显示旧快照';const previousScheme=select('scheme').value;const visibility=new Map([...view?.paths??[]].map(([key,s])=>[key,s.options().visible]));const next=await loadDataset(controller.signal);if(id!==request)return;view?.destroy();view=undefined;activeMode='demo';experiment=undefined;dataset=next;setModePresentation();$('legend').replaceChildren();const historyLabel=document.createElement('span');historyLabel.className='legend-item';historyLabel.textContent='▮ 真实历史 K 线';$('legend').append(historyLabel);$('errors').hidden=!next.errors.length;$('errors').textContent=next.errors.join('\n');
 if(next.history){view=new WeatherChart($('chart'),next.history,next.forecast,hover);view.setTimezone(selectedZone());if(next.forecast)view.setWindow(Number(select('window').value));for(const [i,s]of(next.forecast?.scenarios??[]).entries()){const label=document.createElement('label');label.className='legend-item path-toggle';const input=document.createElement('input');input.type='checkbox';input.checked=visibility.get(s.id)??true;input.setAttribute('aria-label',s.name);view.setPath(s.id,input.checked);input.onchange=()=>view?.setPath(s.id,input.checked);const swatch=document.createElement('i');swatch.className='path-swatch';swatch.style.borderColor=colors[i%colors.length];swatch.style.borderStyle=['solid','dashed','dotted'][i%3];label.append(input,swatch,document.createTextNode(s.name));$('legend').append(label);}}
 select('scheme').replaceChildren();for(const s of next.grids?.schemes??[]){const option=document.createElement('option');option.value=s.id;option.textContent=`${s.name} / ${s.mode.label}`;select('scheme').append(option);}select('scheme').value=next.grids?.schemes.some(s=>s.id===previousScheme)?previousScheme:next.grids?.default_scheme_id??'';
 select('window').disabled=!next.forecast;select('scheme').disabled=!next.grids;($('grid-visible')as HTMLInputElement).disabled=!next.grids;($('reset')as HTMLButtonElement).disabled=!next.history;select('timezone').disabled=!next.history;updateGrid();updateMeta();updateExplanation();hover(undefined);$('load-status').textContent=next.errors.length?'加载存在错误 · 无效图层已清除':'本地文件已校验 · 固定 DEMO / 尚未接入评估';
}
$('reset').onclick=()=>view?.reset();$('window').onchange=()=>view?.setWindow(Number(select('window').value));$('timezone').onchange=()=>{view?.setTimezone(selectedZone());if(activeMode==='experiment'){if(experiment){renderEvaluation();renderExperimentEvidence();if(experimentIndex){indexOptions(experimentIndex,experiment.run_id);experimentStatus(experimentIndex,experiment);}}if(latestRuntime)renderRuntime(latestRuntime);}updateMeta();updateExplanation();hover(undefined);};$('scheme').onchange=updateGrid;$('grid-visible').onchange=updateGrid;$('reload').onclick=()=>void reload();
function setModePresentation(){
 const isExperiment=activeMode==='experiment';
 document.body.classList.toggle('experiment-mode',isExperiment);headline.hidden=!isExperiment;probabilities.hidden=!isExperiment;
 if(isExperiment)probabilities.insertBefore($('legend'),probabilities.querySelector('.probability-note'));else document.querySelector('.toolbar')!.prepend($('legend'));
 demoBadge.textContent=isExperiment?'Codex 实验预报 · 主观概率未校准 · 非交易信号':'DEMO 演示未来｜非交易信号';
 demoBadge.classList.toggle('experiment-badge',isExperiment);
 demoContext.hidden=isExperiment;gridControls.hidden=isExperiment;$('experiment-details').hidden=!isExperiment;
 $('chart').setAttribute('aria-label',isExperiment?'BTC真实历史与Codex实验预报图表':'BTC真实历史与DEMO未来图表');
 detailText.textContent=isExperiment?'模型范围估计 · 未经校准 · 代表折线不是类别全部可能路径':'内层 / 外层示意区间 · 未经校准 · 路径仅为固定演示模板';
 document.querySelector('footer>span:last-child')!.firstChild!.textContent=isExperiment?'实验展示 · ':'仅作演示 · ';
 $('run-picker').hidden=select('mode').value!=='experiment';$('latest').hidden=select('mode').value!=='experiment';
 runtimePanel.hidden=select('mode').value!=='experiment';
 if(!isExperiment)$('run-status').textContent='';
}
function showError(message:string){$('errors').textContent=message;$('errors').hidden=!message;}
function updateExperimentMeta(){
 const run=experiment;
 if(!run||!view){$('metadata').textContent='暂无可显示的实验预报';$('dataset-id').textContent='无实验快照';return;}
 const f=run.forecast;
 $('metadata').textContent=`数据截止 ${view.format(f.data_cutoff,true)}\n信息冻结 ${view.format(Date.parse(f.information_frozen_at)/1000,true)}\n首次发布 ${view.format(Date.parse(f.published_at)/1000,true)} · ${view.zone}`;
 $('dataset-id').textContent='实验档案 · '+timeLabel(f.published_at);$('dataset-id').title=run.hashes.forecast_sha256;
 const states=[6,12,24].map(hours=>`${hours}h ${Date.now()/1000>=f.anchor_time+hours*3600?'已到期':'未到期'}`);
 if(run.evaluation.status==='available'){
  const result=run.evaluation.result;
  $('evaluation-status').textContent=`当前时间：${states.join('　 /　 ')}。当次核对 ${timeLabel(result.evaluated_at)}，行情核对截止 ${view.format(result.observed_through,true)} · ${view.zone}。到期不会自动补取行情或更新评分。`;
  for(const element of $('evaluation-content').querySelectorAll<HTMLElement>('[data-maturity-hours]')){const hours=Number(element.dataset.maturityHours);element.textContent=`当前时间${Date.now()/1000>=f.anchor_time+hours*3600?'已到期':'未到期'}`;}
 }else{
  const pending=states.map(value=>value.includes('已到期')?value+' · 尚未核对':value);
  $('evaluation-status').textContent=pending.join('　 /　 ')+(run.evaluation.status==='failed'?`。${run.evaluation.reason==='evaluation_invalid'?'核对档案无效':run.evaluation.reason==='evaluation_incomplete'?'核对尚未完成':'核对失败'}，本次未加载实际走势与评分。`:f.status==='late'?'。此 run 发布迟到，不参与有效预报评分；仅可历史回看。':'。尚无已核验实际走势与评分；后续结果将叠加于原预测，原路径保持不变。');
 }
}
const evaluationLabels:Record<string,string>={not_due:'未到期 · 尚无可观测节点',partial:'部分已观测',mature:'已成熟 · 完整核对',missing_data:'缺数 · 不作完整结论',ineligible:'不可评价 · 发布迟到'};
const metric=(value:number|null|undefined,digits=3)=>value==null?'不可评价':value.toFixed(digits);
const percentage=(value:number|null|undefined)=>value==null?'不可评价':`${(value*100).toFixed(2)}%`;
function evaluationText(parent:HTMLElement,text:string,className?:string){const p=document.createElement('p');p.textContent=text;if(className)p.className=className;parent.append(p);return p;}
function evaluationTable(parent:HTMLElement,headers:string[],rows:string[][],label:string){
 const scroll=document.createElement('div');scroll.className='evaluation-table-scroll';
 const table=document.createElement('table');table.className='evaluation-table';table.setAttribute('aria-label',label);
 const head=document.createElement('thead'),tr=document.createElement('tr');
 for(const text of headers){const th=document.createElement('th');th.scope='col';th.textContent=text;tr.append(th);}head.append(tr);table.append(head);
 const body=document.createElement('tbody');for(const row of rows){const line=document.createElement('tr');row.forEach((text,index)=>{const cell=document.createElement(index===0?'th':'td');if(index===0)(cell as HTMLTableCellElement).scope='row';cell.textContent=text;line.append(cell);});body.append(line);}table.append(body);scroll.append(table);parent.append(scroll);
}
function renderEvaluation(){
 const run=experiment!,target=$('evaluation-content');target.replaceChildren();
 target.dataset.status=run.evaluation.status;
 if(run.evaluation.status!=='available')return;
 const result=run.evaluation.result;
 evaluationText(target,'白色点线为已核验实际收盘节点，只连接从锚点开始的连续已观测部分；未观测区段不补线。模型概率与范围均未校准，单个 run 样本不足，不能推断预测能力或盈利。','evaluation-note');
 if(result.omitted_after_gap_count)evaluationText(target,`实际行情存在缺口：缺口后的 ${result.omitted_after_gap_count} 个已观测节点未绘线，避免跨缺口连接；下方误差仅计算已对齐节点。`,'evaluation-warning');
 if(run.forecast.status==='late')evaluationText(target,'此 run 发布迟到，整份不可评价；不显示实际评分或有效预测叠加。','evaluation-warning');
 const windows=document.createElement('div');windows.className='evaluation-windows';target.append(windows);
 for(const [key,window]of Object.entries(result.windows)){
  const hours=window.horizon_seconds/3600,card=document.createElement('section');card.className='evaluation-window';card.dataset.window=key;card.dataset.state=window.status;
  const title=document.createElement('h4');title.textContent=`未来 ${hours}h`;const now=document.createElement('span');now.className='evaluation-current';now.dataset.maturityHours=String(hours);title.append(now);card.append(title);
  evaluationText(card,`当次核对：${evaluationLabels[window.status]} · ${window.observed_count}/${window.expected_count} 节点；当次应有 ${window.expected_observed_count} 个。`);
  evaluationText(card,`到期 ${view!.format(Date.parse(window.due_at)/1000,true)} · ${view!.zone}`,'evaluation-note');
  if(window.missing_times.length)evaluationText(card,`已到观测时间但缺失 ${window.missing_times.length} 个节点；类别与 Brier 不据缺数判错。`,'evaluation-warning');
  evaluationText(card,`该期限路径事件：${window.actual_category?CATEGORY_LABELS[window.actual_category]:window.status==='ineligible'?'不可评价（迟到发布）':'尚不可完整分类'}`);
  evaluationText(card,hours!==24?'Brier：不适用（本 run 只有 24h 类别概率）':window.status==='ineligible'?'24h Brier：不适用（迟到发布，整份不可评价）':window.brier_score===null?'24h Brier：尚不可评价，须完整成熟且数据齐全。':`24h multiclass Brier：${metric(window.brier_score,6)} · 越低越好`,'evaluation-brier');
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`查看 ${hours}h 全部代表路径误差与恒价基准`;details.append(summary);
  evaluationText(details,'MAE 使用同时间的已观测收盘节点；收益以原锚点为分母，误差单位为百分点。全部六条代表线分别保留，没有“最像路径”综合成绩。');
  const rows=window.scenario_errors.map(error=>[CATEGORY_LABELS[error.id],metric(error.mae_price),metric(error.mae_return_pct)]);
  rows.push(['价格不变基准',metric(window.constant_baseline?.mae_price),metric(window.constant_baseline?.mae_return_pct)]);
  evaluationTable(details,['路径 / 基准','价格 MAE (USDT)','收益 MAE (百分点)'],rows,`${hours}h 路径误差`);card.append(details);windows.append(card);
 }
 const stages=document.createElement('details');stages.id='evaluation-stages';const summary=document.createElement('summary');summary.textContent='查看阶段极值、波动与范围覆盖';stages.append(summary);
 evaluationText(stages,'覆盖只是本次观测描述，不代表置信水平。上/下偏差均以原始锚点为参照，各代表线误差在上方单独列示。close 为 15m 收盘采样；OHLC 仅使用整根柱起点不早于首次发布的柱，高低点不提供柱内先后顺序。');
 for(const stage of result.stages){
  const section=document.createElement('section');section.className='evaluation-stage';const title=document.createElement('h4');title.textContent=`${(stage.start_step-1)/4}–${stage.end_step/4}h · ${evaluationLabels[stage.status]}`;section.append(title);
  evaluationText(section,`收盘 ${stage.observed_count}/${stage.expected_count} 节点；可用于 OHLC 的完整事后柱 ${stage.ohlc_eligible_count}，排除跨首次发布的柱 ${stage.excluded_prepublication_candles}。`);
  const o=stage.observed;
  evaluationTable(section,['核对量','收盘采样','完整事后 OHLC'],[
   ['观测低值 (USDT)',metric(o?.close_min),metric(o?.ohlc_low)],
   ['观测高值 (USDT)',metric(o?.close_max),metric(o?.ohlc_high)],
   ['相对锚点最大上行 (%)',metric(o?.close_max_upside_pct),metric(o?.ohlc_max_upside_pct)],
   ['相对锚点最大下行 (%)',metric(o?.close_max_downside_pct),metric(o?.ohlc_max_downside_pct)],
   ['落在模型范围的比例',percentage(o?.close_coverage),percentage(o?.ohlc_coverage)],
  ],`${(stage.start_step-1)/4}–${stage.end_step/4}h 阶段观测`);
  evaluationText(section,`冻结模型范围 ${metric(stage.lower)}–${metric(stage.upper)} USDT；范围宽度 ${metric(stage.width_price)} USDT / ${metric(stage.width_return_pct)}%（相对锚点）。`);
  evaluationText(section,`非年化已实现波动 ${percentage(o?.realized_volatility)}；${o?.return_pair_count??0} 对连续相邻未来收盘节点，缺口不计算跨段收益；口径为 √Σ(相邻收盘对数收益²)。`);stages.append(section);
 }
 target.append(stages);
 const source=document.createElement('details');source.id='evaluation-source';const sourceSummary=document.createElement('summary');sourceSummary.textContent='核对口径与版本';source.append(sourceSummary);
 evaluationText(source,'24h multiclass Brier = Σₖ(pₖ − 1[实际类别=k])²，对六类求和，不除以类别数，范围 [0, 2]；不用于 6h / 12h。');
 evaluationText(source,'这是一个 run 的窗口核对；不同方法 / 提示词版本和重叠窗口不合并为独立同分布样本，不计算显著性或校准结论。');
 evaluationText(source,`方法 ${result.method_version} · 提示词 ${result.prompt_version} · 核对版本 ${result.evaluation_version}`);
 evaluationText(source,`核对 revision ${run.evaluation.revision_id} · SHA ${run.evaluation.evaluation_sha256}`);
 evaluationText(source,`绑定原预报 ${result.forecast_id} · SHA ${result.forecast_hash}`);target.append(source);
}
function hoverExperiment(t:number|undefined){
 if(!view||!experiment||t===undefined){$('hover').textContent='移动十字线查看真实历史 / 实验代表路径';return;}
 const h=experiment.history,f=experiment.forecast,c=h.candles.find(c=>c.open_time===t);
 if(c){$('hover').textContent=`${view.format(t,true)} · 真实历史  O ${c.open}  H ${c.high}  L ${c.low}  C ${c.close}`;return;}
 const idx=(t-f.anchor_time)/f.step_seconds-1;
 if(!Number.isInteger(idx)||idx<0||idx>=f.future_count){$('hover').textContent=`${view.format(t,true)} · 实验锚点，无真实未来 OHLC`;return;}
 const stage=f.stages.find(s=>idx+1>=s.start_step&&idx+1<=s.end_step)!;
 const actual=experiment.evaluation.status==='available'?experiment.evaluation.result.actual_points.find(point=>point.time===t):undefined;
 $('hover').textContent=`${view.format(t,true)} · ${actual?'已核验实际收盘 '+actual.price.toFixed(2)+' · ':''}实验代表路径 ${f.scenarios.filter(s=>view!.paths.get(s.id)?.options().visible).map(s=>CATEGORY_STYLE[s.id].symbol+' '+CATEGORY_LABELS[s.id]+' '+s.points[idx].price.toFixed(2)).join(' / ')}\n模型范围 ${stage.lower.toFixed(2)}–${stage.upper.toFixed(2)} · 未经校准`;
}
function renderExperimentEvidence(){
 const run=experiment!;const f=run.forecast;const ranked=rankProbabilities(f.scenarios),leaders=ranked.filter(s=>s.probability_24h===ranked[0].probability_24h);$('forecast-summary').textContent=`${leaders.map(s=>CATEGORY_LABELS[s.id]).join('、')}${leaders.length>1?'并列':''}概率最高 · ${formatProbability(ranked[0].probability_24h)}`;const historical=$('history-learning-content');historical.replaceChildren();const addHistory=(text:string)=>{const p=document.createElement('p');p.textContent=text;historical.append(p);};const historySummary=experimentIndex?.summary;if(historySummary)addHistory(`历史 ${historySummary.total_runs} 期；已核验96节点成熟 ${historySummary.verified_mature_runs} 期；及时发布 ${historySummary.valid_runs} 期；迟到 ${historySummary.late_runs} 期；失败或无效 ${historySummary.failed_runs} 期。上述期数包含重叠窗口，不等于独立训练样本数。`);else addHistory('当前接口尚无完整历史学习汇总，仅展示已读取档案。');addHistory(`当前${selectionMode==='follow_latest'?'跟随最新':'固定回看'}；列表每页最多30期。索引最近校验 ${timeLabel(experimentIndex?.verified_at??experimentIndex?.checked_at)}。`);addHistory(`本次冻结基准样本 ${run.basis?.base_count??'未知'} 个；反馈案例 ${run.basis?.case_ids.length??'未知'} 个。案例使用当时实际可用证据；新结果不会改写历史输入。`);const target=$('experiment-summary');target.replaceChildren();
 const add=(text:string)=>{const p=document.createElement('p');p.textContent=text;target.append(p);};
 add(f.summary);
 if(f.calibration){const c=f.calibration;evaluationTable(target,['24h 类别','原始概率','历史基准率','最终概率'],f.scenarios.map((scenario,i)=>[CATEGORY_LABELS[scenario.id],percentage(c.raw_probabilities[i]),percentage(c.base[i]),percentage(scenario.probability_24h)]),'本次概率依据');add(`固定混合系数 λ=${c.lambda}；原始主路径 ${CATEGORY_LABELS[c.raw_main as keyof typeof CATEGORY_LABELS]}，最终主路径 ${CATEGORY_LABELS[c.final_main as keyof typeof CATEGORY_LABELS]}。主路径按最大概率选择，同值按固定类别顺序。`);}
 if(run.basis){const b=run.basis;add(`冻结反馈 ${b.feedback_mode}：${b.case_ids.length} 个案例；历史基准率 ${b.base_count} 个非重叠成熟样本，截止 ${timeLabel(b.base_cutoff)}。`);add(`衍生品数据已采集 ${b.derivatives_collected} 类，本次${b.derivatives_incorporated?'已纳入':'未纳入'}；官方日历已采集 ${b.calendar_collected} 项，纳入 ${b.calendar_included} 项。`);if(b.case_ids.length)add('本次引用案例：'+b.case_ids.join('、'));}else add('历史版本未记录反馈和补充输入信息；不补写为已学习。');
 add(`概率来源：官方 Codex 主观判断，未经校准；未来24h类别概率属于完整事件类别，不表示精准命中某条折线。6/12h仅裁切视窗；隐藏路径不修改概率。`);
 add(`事件覆盖：${f.event_risk_label} · ${f.event_mode}。${f.limitations.join('；')}`);
 const metadata=document.createElement('details');const summary=document.createElement('summary');summary.textContent='来源与预报版本';metadata.append(summary);
 for(const text of [`run：${run.run_id}`,`来源：${run.history.source.provider} · ${run.history.instrument} · ${run.history.market_type} · ${run.history.price_type} · 15m · ${run.history.source.endpoint}`,
  `模型配置：${run.model.config.provider} · ${run.model.config.selection} · ${run.model.config.cli_version} · 实际模型标识：${run.model.identity??'unknown'} · 标识可见性：${run.model.identity_visibility}`,
  `方法：${f.method_version} · 提示词：${f.prompt_version} · 契约：${f.schema_version}`,
  `生成开始 ${timeLabel(f.generation_started_at)} · 生成结束 ${timeLabel(f.generation_ended_at)}`,
  `信息冻结 ${timeLabel(f.information_frozen_at)} · 数据截止 ${timeLabel(f.data_cutoff)} · 事件截止 ${timeLabel(f.event_cutoff)}`,
  `首次发布时间 ${timeLabel(f.published_at)} · 原始发布状态 ${f.status}`,
  `输入 SHA ${run.hashes.input_sha256} · 预报 SHA ${run.hashes.forecast_sha256}`]){const p=document.createElement('p');p.textContent=text;metadata.append(p);}target.append(metadata);
 const scenarios=$('scenario-evidence');scenarios.replaceChildren();
 for(const s of f.scenarios){const item=document.createElement('details');item.className='scenario-card';const title=document.createElement('summary');title.textContent=`${CATEGORY_LABELS[s.id]} · 未来24h ${formatProbability(s.probability_24h)}`;item.append(title);
  for(const text of [`事件定义（${f.method_version}）：${CATEGORY_DEFINITIONS[s.id]}`,`支持依据：${s.support.join('；')}`,`反对依据：${s.counterevidence.join('；')}`,`失效条件：${s.invalidations.join('；')}`]){const p=document.createElement('p');p.textContent=text;item.append(p);}scenarios.append(item);}
 const stages=document.createElement('details');const title=document.createElement('summary');title.textContent='分阶段模型范围与依据 · 未经校准';stages.append(title);
 for(const s of f.stages){const p=document.createElement('p');p.textContent=`${(s.start_step-1)/4}–${s.end_step/4}h：${s.lower}–${s.upper} USDT · ${s.explanation}`;stages.append(p);}target.append(stages);
}
function renderProbabilityLegend(visibility=new Map<string,boolean>()){
 const run=experiment;if(!run||!view)return;
 $('emphasize-top').removeAttribute('disabled');
 for(const s of rankProbabilities(run.forecast.scenarios)){
  const label=document.createElement('label');label.className='legend-item path-toggle probability-row';label.dataset.category=s.id;
  const input=document.createElement('input');input.type='checkbox';input.checked=visibility.get(s.id)??view.paths.get(s.id)?.options().visible??true;input.setAttribute('aria-label',CATEGORY_LABELS[s.id]);view.setPath(s.id,input.checked);input.onchange=()=>view?.setPath(s.id,input.checked);
  const swatch=document.createElement('i');swatch.className='path-swatch';
  const name=document.createElement('span');name.className='probability-name';name.textContent=CATEGORY_STYLE[s.id].symbol+' · '+CATEGORY_LABELS[s.id];
  const number=document.createElement('strong');number.textContent=formatProbability(s.probability_24h);number.title='未来24h类别概率';
  const track=document.createElement('span');track.className='probability-track';track.setAttribute('aria-hidden','true');const fill=document.createElement('span');fill.style.width=`${s.probability_24h*100}%`;fill.style.backgroundColor=CATEGORY_STYLE[s.id].color;track.append(fill);
  label.append(input,swatch,name,number,track);$('legend').append(label);
 }
 updateProbabilityEmphasis();
}
function updateProbabilityEmphasis(){
 if(!experiment)return;const top=topProbabilityIds(experiment.forecast.scenarios);view?.setProbabilityEmphasis(topOnly);$('emphasize-top').setAttribute('aria-pressed',String(topOnly));
 for(const s of experiment.forecast.scenarios){const row=$('legend').querySelector<HTMLElement>(`[data-category="${s.id}"]`);if(!row)continue;const style=probabilityStyle(s.id,s.probability_24h,topOnly&&!top.has(s.id));const swatch=row.querySelector<HTMLElement>('.path-swatch')!;swatch.style.borderColor=style.stroke;swatch.style.borderTopWidth=style.width+'px';row.dataset.emphasized=String(!topOnly||top.has(s.id));}
}
$('emphasize-top').onclick=()=>{topOnly=!topOnly;updateProbabilityEmphasis();};
const statusLabel={valid:'有效发布',late:'迟到发布',failed:'运行失败',incomplete:'尚未完成',invalid:'档案无效',skipped:'未执行'};
const reasonLabel:Record<string,string>={forecast_expired:'预报已过期',publication_late:'发布迟到',preparation_failed:'输入准备失败',generation_failed:'模型生成失败',validation_failed:'输出校验失败',generation_incomplete:'生成尚未完成',publication_missing:'尚无有效发布',archive_invalid:'档案校验失败',candidate_not_invoked:'正式预测失败，影子候选未调用'};
function indexOptions(index:DisplayIndex,chosen:string|undefined){
 select('run').replaceChildren();
 for(const r of index.runs){const o=document.createElement('option');o.value=r.run_id;o.textContent=`${timeLabel(r.published_at??r.created_at)} · ${statusLabel[r.status]}${r.reason?' · '+reasonLabel[r.reason]:''}`;select('run').append(o);}
 if(chosen&&!index.runs.some(r=>r.run_id===chosen)&&experiment?.run_id===chosen){const option=document.createElement('option');option.value=chosen;option.textContent='固定回看 · '+timeLabel(experiment.forecast.published_at);select('run').append(option);}
 $('history-more').hidden=index.next_cursor==null;
 if(chosen)select('run').value=chosen;select('run').disabled=!index.runs.length;
}
function experimentStatus(index:DisplayIndex,run:DisplayRun,statusOnly=false){
 const f=run.forecast;const latest=index.latest_attempt;
 const expired=Date.now()/1000>=f.anchor_time+f.horizon_seconds;
 const recentFailed=latest&&latest.run_id!==run.run_id&&latest.status!=='valid';
 const state=f.status==='late'?'迟到预报 · 无完整事前视域':expired?'预报已过期 · 历史回看':recentFailed?'旧快照 · 最近运行未成功':index.latest_run_id===run.run_id?'最新有效预报（发布时）':'历史回看 · 非最新有效预报';
 $('run-status').textContent=`${selectionMode==='history_pinned'?'固定回看 · ':''}${state} · 首次发布 ${timeLabel(f.published_at)}`;
 const newAvailable=selectionMode==='history_pinned'&&!!index.latest_run_id&&index.latest_run_id!==run.run_id;$('new-forecast').hidden=!newAvailable;$('new-forecast').textContent=newAvailable?'有较新的有效预报，当前仍固定回看；点击“返回最新”查看。':'';
 const warning=latest&&!['valid'].includes(latest.status)?`最近运行 ${timeLabel(latest.created_at)}：${statusLabel[latest.status]}${latest.reason?' · '+reasonLabel[latest.reason]:''}。当前保留上次已加载的原始快照。`:'';
 if(statusOnly)return;
 const evaluation=run.evaluation.status==='available'?'已加载独立核对结果':run.evaluation.status==='failed'?(run.evaluation.reason==='evaluation_unsupported'?'此评分版本当前无法重算':run.evaluation.reason==='evaluation_incomplete'?'核对尚未完成 / 无有效结果':'核对失败 / 无有效结果'):'尚未核对实际结果';
 showError(warning);$('load-status').textContent=`实验档案已校验 · ${state} · ${evaluation}`;
}
async function reloadExperiment(preferLatest=false){
 const id=++request;controller?.abort();controller=new AbortController();setModePresentation();
 void reloadRuntime();
 $('load-status').textContent='正在校验实验档案 · 当前显示旧快照';
 try{
  const index=await loadDisplayIndex(controller.signal);
  const requested=preferLatest||activeMode!=='experiment'?undefined:select('run').value||undefined;
  if(requested&&index.page_offset===undefined&&!index.runs.some(r=>r.run_id===requested))throw Error('所选历史预报已从索引缺失，未自动替换其他 run');
  const chosen=requested??index.latest_run_id??index.runs.find(r=>r.status==='valid'||r.status==='late')?.run_id;
  if(!chosen){if(id!==request)return;view?.destroy();view=undefined;experiment=undefined;activeMode='experiment';experimentIndex=index;indexOptions(index,undefined);setModePresentation();$('legend').replaceChildren();$('forecast-summary').textContent='暂无可显示的已发布预报';$('new-forecast').hidden=true;$('emphasize-top').setAttribute('disabled','');$('experiment-summary').textContent='暂无已发布实验预报。';$('scenario-evidence').replaceChildren();$('evaluation-content').replaceChildren();$('evaluation-status').textContent='暂无可核对的已发布预测。';updateExperimentMeta();$('run-status').textContent=index.latest_attempt?`最近运行：${statusLabel[index.latest_attempt.status]} · ${index.latest_attempt.reason?reasonLabel[index.latest_attempt.reason]:'尚无有效发布'}`:'暂无实验预测';$('load-status').textContent='暂无实验预测 · 等待有效发布';showError('');select('window').disabled=true;return;}
  const run=await loadDisplayRun(chosen,controller.signal);if(id!==request)return;
  const indexed=index.runs.find(r=>r.run_id===chosen)!;
  if(indexed&&(indexed.published_at!==run.forecast.published_at||indexed.status!==run.forecast.status))throw Error('索引与预报状态或首次发布时间不一致');
  const sameRun=activeMode==='experiment'&&experiment?.run_id===run.run_id;
  const preservedRange=sameRun?view?.chart.timeScale().getVisibleLogicalRange():null;
  if(sameRun&&experiment?.hashes.forecast_sha256!==run.hashes.forecast_sha256)throw Error('已发布预报内容发生变化');
  if(sameRun&&view){experiment=run;experimentIndex=index;experimentLoadFailed=false;view.setActual(run.evaluation.status==='available'?run.evaluation.result.actual_points:[]);if(preservedRange)view.chart.timeScale().setVisibleLogicalRange(preservedRange);indexOptions(index,run.run_id);renderExperimentEvidence();renderEvaluation();updateExperimentMeta();experimentStatus(index,run);return;}
  const projection=toExperimentChart(run);const visibility=activeMode==='experiment'&&experiment?.run_id===run.run_id?new Map([...view?.paths??[]].map(([key,s])=>[key,s.options().visible])):new Map<string,boolean>();
  view?.destroy();view=undefined;experimentLoadFailed=false;activeMode='experiment';experiment=run;experimentIndex=index;
  view=new WeatherChart($('chart'),projection.history,projection.forecast,hover);
  if(run.evaluation.status==='available')view.setActual(run.evaluation.result.actual_points);
  view.setTimezone(selectedZone());view.setWindow(Number(select('window').value));
  $('legend').replaceChildren();const h=document.createElement('span');h.className='legend-item';h.textContent='▮ 当时真实历史 K 线';$('legend').append(h);
  if(run.evaluation.status==='available'&&run.evaluation.result.actual_points.length){const actual=document.createElement('span');actual.className='legend-item actual-legend';const swatch=document.createElement('i');swatch.className='path-swatch';actual.append(swatch,document.createTextNode('已核验实际收盘'));$('legend').append(actual);}
  renderProbabilityLegend(visibility);
  indexOptions(index,run.run_id);setModePresentation();renderExperimentEvidence();renderEvaluation();updateExperimentMeta();experimentStatus(index,run);hover(undefined);
  select('window').disabled=false;select('timezone').disabled=false;($('reset')as HTMLButtonElement).disabled=false;
 }catch(error){if(id!==request)return;experimentLoadFailed=true;const message=error instanceof Error?error.message:String(error);showError(`实验档案加载失败：${message}。请恢复有效档案后重载；当前${experiment?'仍显示 '+timeLabel(experiment.forecast.published_at)+' 的旧预报':'显示内容未切换'}，不是本次最新成功。`);$('load-status').textContent='加载失败 · 保留旧快照，未更新成功';$('run-status').textContent=experiment?'旧快照 · 本次更新失败':'实验模式加载失败';}
}
$('history-more').onclick=async()=>{const cursor=experimentIndex?.next_cursor;if(cursor==null)return;const id=++request;controller?.abort();controller=new AbortController();try{const page=await loadDisplayIndex(controller.signal,cursor);if(id!==request)return;experimentIndex=page;indexOptions(page,experiment?.run_id);selectionMode='history_pinned';}catch{if(id===request)showError('历史列表读取失败，当前预报保持不变');}};
async function reload(){if(select('mode').value==='experiment')await reloadExperiment();else await reloadDemo();}
$('mode').onchange=()=>{selectionMode='follow_latest';void reload();};$('run').onchange=()=>{selectionMode='history_pinned';void reloadExperiment();};$('latest').onclick=()=>{selectionMode='follow_latest';void reloadExperiment(true);};
if(new URLSearchParams(location.search).has('test'))Object.assign(window,{chartTest:{snapshot:()=>({...view?.diagnostics()??{historyCount:0,pathCount:0,gridLineCount:0,activeCharts:0},mode:activeMode,selectionMode,runId:experiment?.run_id,forecastHash:experiment?.hashes.forecast_sha256,latestRunId:experimentIndex?.latest_run_id,evaluationStatus:experiment?.evaluation.status,evaluationRevision:experiment?.evaluation.status==='available'?experiment.evaluation.revision_id:undefined}),setRange:(from:number,to:number)=>view?.setRange(from,to),reload}});
const refreshVisible=()=>{if(document.visibilityState==='visible'&&select('mode').value==='experiment')void reloadExperiment(selectionMode==='follow_latest');};
window.addEventListener('online',refreshVisible);window.addEventListener('pageshow',refreshVisible);document.addEventListener('visibilitychange',refreshVisible);
const statusTimer=window.setInterval(()=>{refreshVisible();if(activeMode==='experiment'&&experiment&&experimentIndex){updateExperimentMeta();if(!experimentLoadFailed)experimentStatus(experimentIndex,experiment,true);}},60000);
const explicitDemo=new URLSearchParams(location.search).has('test')||new URLSearchParams(location.search).get('mode')==='demo';
if(!explicitDemo){select('mode').querySelector('option[value=demo]')?.remove();select('mode').value='experiment';}
void reload();window.addEventListener('pagehide',(event)=>{if(event.persisted)return;window.clearInterval(statusTimer);controller?.abort();runtimeController?.abort();view?.destroy();});
