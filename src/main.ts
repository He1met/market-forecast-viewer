import './styles.css';
import { loadDataset, type Dataset } from './data';
import { WeatherChart, colors } from './chart';
import { gridPosition, generationExplanation } from './demo-explanation';
import { loadDisplayIndex, loadDisplayRun, type DisplayRun, type DisplayIndex } from './m1-display';
import { toExperimentChart, CATEGORY_LABELS, CATEGORY_DEFINITIONS } from './chart-model';
const $ = (id:string) => document.getElementById(id)!;
let view:WeatherChart|undefined, dataset:Dataset={errors:[]}, request=0, controller:AbortController|undefined;
$('app').innerHTML=`<header><div class="brand"><span class="brand-icon">◒</span><div><h1>市场天气</h1><p>MARKET WEATHER / BTC</p></div></div><div class="demo-badge">DEMO 演示未来｜非交易信号</div><div class="header-note">本地历史快照 <span class="dot"></span></div></header><main><section class="market-head"><div><span class="eyebrow">OKX · USDT 线性永续</span><h2>BTC <span>/ USDT</span> <small>15m</small></h2></div><div id="metadata" class="metadata">正在读取本地数据…</div></section><section class="chart-shell"><div class="toolbar"><div id="legend"></div><div id="controls"><select id="window" aria-label="未来展示窗口"><option value="6">未来 6h</option><option value="12">未来 12h</option><option value="24" selected>未来 24h</option></select><button id="reset">重置视图</button><select id="timezone" aria-label="显示时区"><option value="local">浏览器时区</option><option value="UTC">UTC</option></select><button id="reload">重载文件</button></div></div><div class="demo-context"><p>未来为固定 DEMO 情景路径，不是本轮 Codex 市场预测；区间未经校准。 <strong>概率：未计算（固定 DEMO）</strong></p><details id="generation"><summary>生成依据</summary><div id="generation-content"></div></details></div><div id="chart" role="img" aria-label="BTC真实历史与DEMO未来图表"></div><div class="chart-foot"><span id="hover">移动十字线查看数据</span><span>滚轮缩放 · 拖动平移 · 拖动右轴缩放价格</span></div></section><div id="errors" role="alert" hidden></div><section class="grid-controls"><div class="grid-picker"><label for="scheme">DEMO 网格方案</label><select id="scheme" aria-label="网格方案"></select><label class="grid-visible"><input id="grid-visible" type="checkbox" checked>显示网格</label></div><div><div id="grid-summary"></div><small id="position-label"></small><p id="grid-position"></p></div><details id="levels"><summary>查看价格层级</summary><div id="level-values"></div></details></section><section id="detail" class="detail"><p>内层 / 外层示意区间 · 未经校准 · 路径仅为固定演示模板</p><span id="load-status" role="status">正在读取文件…</span></section><footer><span>数据来源 <a href="https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history" target="_blank" rel="noreferrer">OKX 官方公开接口</a> · <span id="dataset-id"></span></span><span>仅作演示 · <a href="/licenses/index.html" target="_blank">第三方声明</a> · <a href="/licenses/lightweight-charts-LICENSE.txt" target="_blank">Apache-2.0</a> · <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a></span></footer></main>`;
let experimentLoadFailed=false;
let activeMode:'demo'|'experiment'='demo', experiment:DisplayRun|undefined, experimentIndex:DisplayIndex|undefined;
const modeBar=document.createElement('section');modeBar.className='mode-bar';
modeBar.innerHTML='<label>查看内容 <select id="mode" aria-label="查看内容"><option value="demo">固定 DEMO</option><option value="experiment">Codex 实验预报</option></select></label><label id="run-picker" hidden>历史预报 <select id="run" aria-label="历史预报"></select></label><button id="latest" hidden>读取最新索引</button><span id="run-status" role="status"></span>';
document.querySelector('.chart-shell')!.before(modeBar);
const experimentDetails=document.createElement('section');experimentDetails.id='experiment-details';experimentDetails.hidden=true;
experimentDetails.innerHTML='<div id="experiment-summary"></div><div id="scenario-evidence"></div><section id="evaluation"><h3>实际走势与结果核对</h3><p id="evaluation-status"></p></section>';
$('detail').before(experimentDetails);
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
 if(next.history){view=new WeatherChart($('chart'),next.history,next.forecast,hover);view.setTimezone(select('timezone').value==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone);if(next.forecast)view.setWindow(Number(select('window').value));for(const [i,s]of(next.forecast?.scenarios??[]).entries()){const label=document.createElement('label');label.className='legend-item path-toggle';const input=document.createElement('input');input.type='checkbox';input.checked=visibility.get(s.id)??true;input.setAttribute('aria-label',s.name);view.setPath(s.id,input.checked);input.onchange=()=>view?.setPath(s.id,input.checked);const swatch=document.createElement('i');swatch.className='path-swatch';swatch.style.borderColor=colors[i%colors.length];swatch.style.borderStyle=['solid','dashed','dotted'][i%3];label.append(input,swatch,document.createTextNode(s.name));$('legend').append(label);}}
 select('scheme').replaceChildren();for(const s of next.grids?.schemes??[]){const option=document.createElement('option');option.value=s.id;option.textContent=`${s.name} / ${s.mode.label}`;select('scheme').append(option);}select('scheme').value=next.grids?.schemes.some(s=>s.id===previousScheme)?previousScheme:next.grids?.default_scheme_id??'';
 select('window').disabled=!next.forecast;select('scheme').disabled=!next.grids;($('grid-visible')as HTMLInputElement).disabled=!next.grids;($('reset')as HTMLButtonElement).disabled=!next.history;select('timezone').disabled=!next.history;updateGrid();updateMeta();updateExplanation();hover(undefined);$('load-status').textContent=next.errors.length?'加载存在错误 · 无效图层已清除':'本地文件已校验 · 固定 DEMO / 尚未接入评估';
}
$('reset').onclick=()=>view?.reset();$('window').onchange=()=>view?.setWindow(Number(select('window').value));$('timezone').onchange=()=>{view?.setTimezone(select('timezone').value==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone);updateMeta();updateExplanation();};$('scheme').onchange=updateGrid;$('grid-visible').onchange=updateGrid;$('reload').onclick=()=>void reload();
function setModePresentation(){
 const isExperiment=activeMode==='experiment';
 demoBadge.textContent=isExperiment?'Codex 实验预报 · 主观概率未校准 · 非交易信号':'DEMO 演示未来｜非交易信号';
 demoBadge.classList.toggle('experiment-badge',isExperiment);
 demoContext.hidden=isExperiment;gridControls.hidden=isExperiment;$('experiment-details').hidden=!isExperiment;
 $('chart').setAttribute('aria-label',isExperiment?'BTC真实历史与Codex实验预报图表':'BTC真实历史与DEMO未来图表');
 detailText.textContent=isExperiment?'模型范围估计 · 未经校准 · 代表折线不是类别全部可能路径':'内层 / 外层示意区间 · 未经校准 · 路径仅为固定演示模板';
 document.querySelector('footer>span:last-child')!.firstChild!.textContent=isExperiment?'实验展示 · ':'仅作演示 · ';
 $('run-picker').hidden=select('mode').value!=='experiment';$('latest').hidden=select('mode').value!=='experiment';
 if(!isExperiment)$('run-status').textContent='';
}
function showError(message:string){$('errors').textContent=message;$('errors').hidden=!message;}
function updateExperimentMeta(){
 const run=experiment;
 if(!run||!view){$('metadata').textContent='暂无可显示的实验预报';$('dataset-id').textContent='无实验快照';return;}
 const f=run.forecast;
 $('metadata').textContent=`数据截止 ${view.format(f.data_cutoff,true)}\n信息冻结 ${view.format(Date.parse(f.information_frozen_at)/1000,true)}\n首次发布 ${view.format(Date.parse(f.published_at)/1000,true)} · ${view.zone}`;
 $('dataset-id').textContent='实验 '+run.run_id;$('dataset-id').title=run.hashes.forecast_sha256;
 const states=[6,12,24].map(hours=>`${hours}h ${Date.now()/1000>=f.anchor_time+hours*3600?'已到期 · 尚未核对':'未到期'}`);
 $('evaluation-status').textContent=states.join('　 /　 ')+(f.status==='late'?'。此 run 发布迟到，不参与有效预报评分；仅可历史回看。':'。尚无已核验实际走势与评分；后续结果将叠加于原预测，原路径保持不变。');
}
function hoverExperiment(t:number|undefined){
 if(!view||!experiment||t===undefined){$('hover').textContent='移动十字线查看真实历史 / 实验代表路径';return;}
 const h=experiment.history,f=experiment.forecast,c=h.candles.find(c=>c.open_time===t);
 if(c){$('hover').textContent=`${view.format(t,true)} · 真实历史  O ${c.open}  H ${c.high}  L ${c.low}  C ${c.close}`;return;}
 const idx=(t-f.anchor_time)/f.step_seconds-1;
 if(!Number.isInteger(idx)||idx<0||idx>=f.future_count){$('hover').textContent=`${view.format(t,true)} · 实验锚点，无真实未来 OHLC`;return;}
 const stage=f.stages.find(s=>idx+1>=s.start_step&&idx+1<=s.end_step)!;
 $('hover').textContent=`${view.format(t,true)} · 实验代表路径 ${f.scenarios.filter(s=>view!.paths.get(s.id)?.options().visible).map(s=>CATEGORY_LABELS[s.id]+' '+s.points[idx].price.toFixed(2)).join(' / ')}\n模型范围 ${stage.lower.toFixed(2)}–${stage.upper.toFixed(2)} · 未经校准`;
}
function renderExperimentEvidence(){
 const run=experiment!;const f=run.forecast;const target=$('experiment-summary');target.replaceChildren();
 const add=(text:string)=>{const p=document.createElement('p');p.textContent=text;target.append(p);};
 add(f.summary);
 add(`概率来源：官方 Codex 主观判断，未经校准；未来24h类别概率属于完整事件类别，不表示精准命中某条折线。6/12h仅裁切视窗；隐藏路径不修改概率。`);
 add(`事件覆盖：${f.event_risk_label} · ${f.event_mode}。${f.limitations.join('；')}`);
 const metadata=document.createElement('details');const summary=document.createElement('summary');summary.textContent='来源与预报版本';metadata.append(summary);
 for(const text of [`run：${run.run_id}`,`来源：${run.history.source.provider} · ${run.history.instrument} · ${run.history.market_type} · ${run.history.price_type} · 15m · ${run.history.source.endpoint}`,
  `模型配置：${run.model.config.provider} · ${run.model.config.selection} · ${run.model.config.cli_version} · 实际模型标识：${run.model.identity??'unknown'} · 标识可见性：${run.model.identity_visibility}`,
  `方法：${f.method_version} · 提示词：${f.prompt_version} · 契约：${f.schema_version}`,
  `生成开始 ${f.generation_started_at} · 生成结束 ${f.generation_ended_at}`,
  `信息冻结 ${f.information_frozen_at} · 数据截止 ${new Date(f.data_cutoff*1000).toISOString()} · 事件截止 ${f.event_cutoff??'unknown'}`,
  `首次发布时间 ${f.published_at} · 原始发布状态 ${f.status}`,
  `输入 SHA ${run.hashes.input_sha256} · 预报 SHA ${run.hashes.forecast_sha256}`]){const p=document.createElement('p');p.textContent=text;metadata.append(p);}target.append(metadata);
 const scenarios=$('scenario-evidence');scenarios.replaceChildren();
 for(const s of f.scenarios){const item=document.createElement('details');item.className='scenario-card';const title=document.createElement('summary');title.textContent=`${CATEGORY_LABELS[s.id]} · 未来24h ${(s.probability_24h*100).toFixed(1)}%`;item.append(title);
  for(const text of [`事件定义（${f.method_version}）：${CATEGORY_DEFINITIONS[s.id]}`,`支持依据：${s.support.join('；')}`,`反对依据：${s.counterevidence.join('；')}`,`失效条件：${s.invalidations.join('；')}`]){const p=document.createElement('p');p.textContent=text;item.append(p);}scenarios.append(item);}
 const stages=document.createElement('details');const title=document.createElement('summary');title.textContent='分阶段模型范围与依据 · 未经校准';stages.append(title);
 for(const s of f.stages){const p=document.createElement('p');p.textContent=`${(s.start_step-1)/4}–${s.end_step/4}h：${s.lower}–${s.upper} USDT · ${s.explanation}`;stages.append(p);}target.append(stages);
}
const statusLabel={valid:'有效发布',late:'迟到发布',failed:'运行失败',incomplete:'尚未完成',invalid:'档案无效'};
const reasonLabel:Record<string,string>={forecast_expired:'预报已过期',publication_late:'发布迟到',preparation_failed:'输入准备失败',generation_failed:'模型生成失败',validation_failed:'输出校验失败',generation_incomplete:'生成尚未完成',publication_missing:'尚无有效发布',archive_invalid:'档案校验失败'};
function indexOptions(index:DisplayIndex,chosen:string|undefined){
 select('run').replaceChildren();
 for(const r of index.runs){const o=document.createElement('option');o.value=r.run_id;o.textContent=`${r.published_at??r.created_at} · ${statusLabel[r.status]}${r.reason?' · '+reasonLabel[r.reason]:''} · ${r.run_id}`;select('run').append(o);}
 if(chosen)select('run').value=chosen;select('run').disabled=!index.runs.length;
}
function experimentStatus(index:DisplayIndex,run:DisplayRun,statusOnly=false){
 const f=run.forecast;const latest=index.latest_attempt;
 const expired=Date.now()/1000>=f.anchor_time+f.horizon_seconds;
 const recentFailed=latest&&latest.run_id!==run.run_id&&latest.status!=='valid';
 const state=f.status==='late'?'迟到预报 · 无完整事前视域':expired?'预报已过期 · 历史回看':recentFailed?'旧快照 · 最近运行未成功':index.latest_run_id===run.run_id?'最新有效预报（发布时）':'历史回看 · 非最新有效预报';
 $('run-status').textContent=`${state} · 首次发布 ${f.published_at}`;
 const warning=latest&&!['valid'].includes(latest.status)?`最近运行 ${latest.run_id}：${statusLabel[latest.status]}${latest.reason?' · '+reasonLabel[latest.reason]:''}。当前所示仍为 ${run.run_id} 的原始快照。`:'';
 if(statusOnly)return;
 showError(warning);$('load-status').textContent=`实验档案已校验 · ${state} · 尚未接入评估`;
}
async function reloadExperiment(preferLatest=false){
 const id=++request;controller?.abort();controller=new AbortController();setModePresentation();
 $('load-status').textContent='正在校验实验档案 · 当前显示旧快照';
 try{
  const index=await loadDisplayIndex(controller.signal);
  const requested=preferLatest||activeMode!=='experiment'?undefined:select('run').value||undefined;
  if(requested&&!index.runs.some(r=>r.run_id===requested))throw Error('所选历史预报已从索引缺失，未自动替换其他 run');
  const chosen=requested??index.latest_run_id??index.runs.find(r=>r.status==='valid'||r.status==='late')?.run_id;
  if(!chosen){if(id!==request)return;view?.destroy();view=undefined;experiment=undefined;activeMode='experiment';experimentIndex=index;indexOptions(index,undefined);setModePresentation();$('legend').replaceChildren();$('experiment-summary').textContent='暂无已发布实验预报。';$('scenario-evidence').replaceChildren();$('evaluation-status').textContent='暂无可核对的已发布预测。';updateExperimentMeta();$('run-status').textContent=index.latest_attempt?`最近运行：${statusLabel[index.latest_attempt.status]} · ${index.latest_attempt.reason?reasonLabel[index.latest_attempt.reason]:'尚无有效发布'}`:'暂无实验预测';$('load-status').textContent='暂无实验预测 · 可切回固定 DEMO';showError('');select('window').disabled=true;return;}
  const run=await loadDisplayRun(chosen,controller.signal);if(id!==request)return;
  const indexed=index.runs.find(r=>r.run_id===chosen)!;
  if(indexed.published_at!==run.forecast.published_at||indexed.status!==run.forecast.status)throw Error('索引与预报状态或首次发布时间不一致');
  const projection=toExperimentChart(run);const visibility=activeMode==='experiment'&&experiment?.run_id===run.run_id?new Map([...view?.paths??[]].map(([key,s])=>[key,s.options().visible])):new Map<string,boolean>();
  view?.destroy();view=undefined;experimentLoadFailed=false;activeMode='experiment';experiment=run;experimentIndex=index;
  view=new WeatherChart($('chart'),projection.history,projection.forecast,hover);
  view.setTimezone(select('timezone').value==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone);view.setWindow(Number(select('window').value));
  $('legend').replaceChildren();const h=document.createElement('span');h.className='legend-item';h.textContent='▮ 当时真实历史 K 线';$('legend').append(h);
  for(const [i,s]of run.forecast.scenarios.entries()){const label=document.createElement('label');label.className='legend-item path-toggle';const input=document.createElement('input');input.type='checkbox';input.checked=visibility.get(s.id)??true;input.setAttribute('aria-label',CATEGORY_LABELS[s.id]);view.setPath(s.id,input.checked);input.onchange=()=>view?.setPath(s.id,input.checked);const swatch=document.createElement('i');swatch.className='path-swatch';swatch.style.borderColor=colors[i%colors.length];swatch.style.borderStyle=['solid','dashed','dotted'][i%3];label.append(input,swatch,document.createTextNode(`${CATEGORY_LABELS[s.id]} · 未来24h ${(s.probability_24h*100).toFixed(1)}%`));$('legend').append(label);}
  indexOptions(index,run.run_id);setModePresentation();renderExperimentEvidence();updateExperimentMeta();experimentStatus(index,run);hover(undefined);
  select('window').disabled=false;select('timezone').disabled=false;($('reset')as HTMLButtonElement).disabled=false;
 }catch(error){if(id!==request)return;experimentLoadFailed=true;const message=error instanceof Error?error.message:String(error);showError(`实验档案加载失败：${message}。请恢复有效档案后重载；当前${experiment?'仍显示旧预报 '+experiment.run_id:'显示内容未切换'}，不是本次最新成功。`);$('load-status').textContent='加载失败 · 保留旧快照，未更新成功';$('run-status').textContent=experiment?'旧快照 · 本次更新失败':'实验模式加载失败';}
}
async function reload(){if(select('mode').value==='experiment')await reloadExperiment();else await reloadDemo();}
$('mode').onchange=()=>void reload();$('run').onchange=()=>void reloadExperiment();$('latest').onclick=()=>void reloadExperiment(true);
if(new URLSearchParams(location.search).has('test'))Object.assign(window,{chartTest:{snapshot:()=>({...view?.diagnostics()??{historyCount:0,pathCount:0,gridLineCount:0,activeCharts:0},mode:activeMode,runId:experiment?.run_id,forecastHash:experiment?.hashes.forecast_sha256,latestRunId:experimentIndex?.latest_run_id}),setRange:(from:number,to:number)=>view?.setRange(from,to),reload}});
const statusTimer=window.setInterval(()=>{if(activeMode==='experiment'&&experiment&&experimentIndex){updateExperimentMeta();if(!experimentLoadFailed)experimentStatus(experimentIndex,experiment,true);}},60000);
void reload();window.addEventListener('pagehide',(event)=>{if(event.persisted)return;window.clearInterval(statusTimer);controller?.abort();view?.destroy();});
