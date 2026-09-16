import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CATEGORY_IDS, METHOD_VERSION, PROMPT_VERSION } from '../../src/m1-contracts';
import { displayRunSchema, type DisplayRun, type DisplayIndex } from '../../src/m1-display';
import { evaluateForecast } from '../../src/m1-evaluation';
import type { Candle } from '../../src/contracts';

const snapshot=(page:Page)=>page.evaluate(()=>(window as any).chartTest.snapshot());
const at=(seconds:number)=>new Date(seconds*1000).toISOString();
const realRunId='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
const fixtureRunId='m1-20260913T030000000Z-00000000-0000-4000-8000-000000000013';

/** Browser-only synthetic values; never archived, published, or used as actual outcome evidence. */
function synthetic(elapsedHours=6,observedHours=elapsedHours,missingSteps:number[]=[],late=false):DisplayRun {
 const anchor=Math.floor(Date.now()/900000)*900-elapsedHours*3600;
 const prices=CATEGORY_IDS.map((_,index)=>Array<number>(96).fill(index===2?100.5:index===3?99.5:100));
 prices[0][0]=101;prices[1][0]=99;prices[5][0]=100.6;
 const run=displayRunSchema.parse({
  schema:'MFV:M1_DISPLAY:v1',run_id:fixtureRunId,
  history:{dataset_id:'history:'+'a'.repeat(64),instrument:'BTC-USDT-SWAP',market_type:'linear_perpetual',price_type:'trade',bar_seconds:900,
   start_time:anchor-1344*900,end_time:anchor,count:1344,downloaded_at:at(anchor+1),source:{provider:'OKX',endpoint:'https://www.okx.com/api/v5/market/history-candles'},
   candles:Array.from({length:1344},(_,index)=>({open_time:anchor-(1344-index)*900,close_time:anchor-(1343-index)*900,open:100,high:100.2,low:99.8,close:100,volume_contracts:1,volume_base:1,volume_quote:100,closed:true}))},
  forecast:{schema_version:'m1.0',method_version:METHOD_VERSION,prompt_version:PROMPT_VERSION,kind:'experimental_forecast',run_id:fixtureRunId,
   anchor_time:anchor,anchor_price:100,published_at:at(anchor+(late?1800:4)),generation_started_at:at(anchor+2),generation_ended_at:at(anchor+3),information_frozen_at:at(anchor+1),
   status:late?'late':'valid',eligible_as_latest:!late,data_cutoff:anchor,event_cutoff:null,event_mode:'market_only',event_risk_label:'未纳入事件风险',
   probability_kind:'subjective_uncalibrated',probability_label:'主观未校准；24h 类别概率仅用于 24h',range_kind:'model_range_estimate',range_label:'模型范围估计，未经校准',
   path_label:'代表路径不是类别的全部可能路径；显示插值不是成交轨迹',step_seconds:900,horizon_seconds:86400,future_count:96,
   scenarios:CATEGORY_IDS.map((id,index)=>({id,probability_24h:index===0?.5:.1,prices:prices[index],points:prices[index].map((price,node)=>({time:anchor+(node+1)*900,price})),support:['SYNTHETIC support'],counterevidence:['SYNTHETIC counterevidence'],invalidations:['SYNTHETIC invalidation']})),
   stages:[[1,24],[25,48],[49,96]].map(([start_step,end_step])=>({start_step,end_step,start_time:anchor+(start_step-1)*900,end_time:anchor+end_step*900,lower:99.7,upper:100.3,explanation:'SYNTHETIC uncalibrated range'})),
   summary:'SYNTHETIC browser fixture — 仅验证展示和断线，不是真实预报或观测',limitations:['SYNTHETIC values only']},
  model:{config:{provider:'official_codex',selection:'existing_local_cli_configuration',cli_version:'codex-cli 0.0.0',auth_method:'chatgpt_verified',sandbox:'read-only',output_schema:true,startup_warning_count:0},identity:null,identity_visibility:'not_exposed_by_jsonl'},
  hashes:{input_sha256:'b'.repeat(64),forecast_sha256:'c'.repeat(64)},evaluation:{status:'not_evaluated'},
 });
 const candles:Candle[]=Array.from({length:observedHours*4},(_,index):Candle=>{const close=100+(index+1)*.006+Math.sin(index*.4)*.08;return {open_time:anchor+index*900,close_time:anchor+(index+1)*900,open:100,high:Math.max(100,close)+.1,low:Math.min(100,close)-.1,close,volume_contracts:1,volume_base:1,volume_quote:100,closed:true};}).filter((_,index)=>!missingSteps.includes(index+1));
 run.evaluation={status:'available',revision_id:'evaluation-20260913T030000000Z-00000000-0000-4000-8000-000000000013',evaluation_sha256:'d'.repeat(64),result:evaluateForecast({forecast:run.forecast,forecastHash:run.hashes.forecast_sha256,candles,observedThrough:anchor+observedHours*3600,evaluatedAt:at(Math.max(anchor+observedHours*3600,anchor+(late?1800:4)))})};
 return displayRunSchema.parse(run);
}
function indexFor(run:DisplayRun):DisplayIndex {
 const expired=Date.now()/1000>=run.forecast.anchor_time+86400;
 const entry={run_id:run.run_id,created_at:run.forecast.information_frozen_at,published_at:run.forecast.published_at,status:run.forecast.status,reason:run.forecast.status==='late'?'publication_late' as const:expired?'forecast_expired' as const:null};
 return {schema:'MFV:M1_INDEX:v1',checked_at:new Date().toISOString(),latest_run_id:run.forecast.status==='valid'&&!expired?run.run_id:null,latest_attempt:{run_id:entry.run_id,created_at:entry.created_at,status:entry.status,reason:entry.reason},runs:[entry]};
}
async function fixtureRoutes(page:Page,run:DisplayRun){
 await page.route('**/api/m1/index',route=>route.fulfill({json:indexFor(run)}));
 await page.route('**/api/m1/runs/'+run.run_id,route=>route.fulfill({json:run}));
}
async function openExperiment(page:Page){await page.goto('/?test=1');await expect(page.locator('#load-status')).toContainText('已校验');await page.getByLabel('查看内容',{exact:true}).selectOption('experiment');await expect(page.locator('#load-status')).toContainText('实验档案已校验');}
async function evidence(page:Page,name:string,project:string,kind:'real'|'synthetic'){
 await mkdir('artifacts/m13/ui',{recursive:true});const file=`artifacts/m13/ui/${name}-${project}.png`;
 await page.screenshot({path:file,fullPage:true});await writeFile(file+'.json',JSON.stringify({visibility:'LOCAL_ONLY',evidence_kind:kind,user_approved:false,viewport:page.viewportSize(),dpr:await page.evaluate(()=>devicePixelRatio),screenshot_sha256:createHash('sha256').update(await readFile(file)).digest('hex'),snapshot:await snapshot(page)},null,2));
}
async function actualAligned(page:Page){
 await expect.poll(async()=>{const s=await snapshot(page);return s.actualCoordinates.length&&s.actualCoordinates.every((p:any)=>p.x!==null&&p.y!==null&&Math.abs(p.y-p.supportY)<=1);}).toBe(true);
 const state=await snapshot(page);
 // Verify rendered white actual-line pixels near the chart's price/time coordinates.
 const visible=await page.locator('#chart canvas').first().evaluate((canvas:HTMLCanvasElement,points:any[])=>{
  const context=canvas.getContext('2d')!,image=context.getImageData(0,0,canvas.width,canvas.height),scale=canvas.width/canvas.getBoundingClientRect().width;
  return points.filter(p=>{for(let x=Math.max(0,Math.floor((p.x-4)*scale));x<Math.min(canvas.width,(p.x+4)*scale);x++)for(let y=Math.max(0,Math.floor((p.y-4)*scale));y<Math.min(canvas.height,(p.y+4)*scale);y++){const i=(y*canvas.width+x)*4;if(image.data[i]>245&&image.data[i+1]>245&&image.data[i+2]>245&&image.data[i+3]>200)return true;}return false;}).length;
 },state.actualCoordinates);
 expect(visible).toBeGreaterThan(0);return state;
}

test('SYNTHETIC归档实际叠加与6h成熟核对，预测hash和24h概率不变',async({page,request},info)=>{
 const run:DisplayRun=await (await request.get('/api/m1/runs/'+realRunId)).json();
 expect(run.evaluation.status,'Portable SYNTHETIC evaluation fixture required').toBe('available');
 if(run.evaluation.status!=='available')throw Error('SYNTHETIC evaluation is required');
 expect(run.evaluation.result.windows.h6.status).toBe('mature');expect(run.evaluation.result.forecast_hash).toBe(run.hashes.forecast_sha256);
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await openExperiment(page);
 await expect.poll(async()=>(await snapshot(page)).runId).toBe(realRunId);
 await expect(page.locator('[data-window="h6"]')).toContainText('已成熟 · 完整核对');await expect(page.locator('[data-window="h6"] .evaluation-brier')).toContainText('不适用');
 await expect(page.locator('[data-window="h12"] .evaluation-brier')).toContainText('不适用');await expect(page.locator('#evaluation-status')).toContainText('当次核对');
 const before=await actualAligned(page),labels=await page.locator('#legend').innerText();expect(before.actualCount).toBe(run.evaluation.result.actual_points.length);
 for(const hours of [6,12,24]){await page.getByLabel('未来展示窗口').selectOption(String(hours));expect((await snapshot(page)).forecastHash).toBe(run.hashes.forecast_sha256);expect(await page.locator('#legend').innerText()).toBe(labels);}
 await evidence(page,'real-default',info.project.name,'real');
 await page.locator('[data-window="h6"] summary').click();await expect(page.getByRole('table',{name:'6h 路径误差'}).locator('tbody tr')).toHaveCount(7);
 await page.locator('#evaluation-stages>summary').click();await expect(page.locator('#evaluation-stages')).toContainText('排除跨首次发布的柱');await expect(page.locator('#evaluation-stages')).toContainText('范围宽度');
 await expect(page.locator('#evaluation-content')).toContainText('样本不足');await evidence(page,'real-metrics',info.project.name,'real');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
});

test('SYNTHETIC缺口停止实际线、部分指标保留且不计算Brier',async({page},info)=>{
 const run=synthetic(6,6,[5]);await fixtureRoutes(page,run);await openExperiment(page);
 await expect(page.locator('[data-window="h6"]')).toHaveAttribute('data-state','missing_data');await expect(page.locator('#evaluation-content')).toContainText('缺口后的 19 个已观测节点未绘线');
 const state=await actualAligned(page);expect(state.actualCount).toBe(4);expect(state.actualPoints.at(-1).time).toBe(run.forecast.anchor_time+4*900);
 for(const checkbox of await page.locator('#legend input').all())await checkbox.uncheck();
 await page.evaluate(({from,to})=>(window as any).chartTest.setRange(from,to),{from:run.forecast.anchor_time,to:run.forecast.anchor_time+21600});
 await actualAligned(page);expect((await snapshot(page)).visiblePaths).toEqual([]);expect((await snapshot(page)).actualCount).toBe(4);
 await page.locator('[data-window="h6"] summary').click();await expect(page.getByRole('table',{name:'6h 路径误差'}).locator('tbody tr')).toHaveCount(7);
 await expect(page.locator('[data-window="h24"] .evaluation-brier')).toContainText('尚不可评价');await evidence(page,'synthetic-gap',info.project.name,'synthetic');
});

test('SYNTHETIC当前已到期不把旧核对截止推进为完整评分',async({page},info)=>{
 const run=synthetic(24,6);await fixtureRoutes(page,run);await openExperiment(page);
 await expect(page.locator('#evaluation-status')).toContainText('24h 已到期');await expect(page.locator('[data-window="h24"]')).toHaveAttribute('data-state','partial');await expect(page.locator('[data-window="h24"]')).toContainText('24/96');
 await expect(page.locator('[data-window="h24"] .evaluation-brier')).toContainText('尚不可评价');await evidence(page,'synthetic-old-cutoff',info.project.name,'synthetic');
});

test('SYNTHETIC24h完整成熟后独立Brier与全部路径误差',async({page},info)=>{
 const run=synthetic(24);await fixtureRoutes(page,run);await openExperiment(page);
 await expect(page.locator('[data-window="h24"]')).toHaveAttribute('data-state','mature');await expect(page.locator('[data-window="h24"] .evaluation-brier')).toContainText('multiclass Brier');
 await page.locator('[data-window="h24"] summary').click();await expect(page.getByRole('table',{name:'24h 路径误差'}).locator('tbody tr')).toHaveCount(7);
 await page.locator('#evaluation-source>summary').click();await expect(page.locator('#evaluation-source')).toContainText('不除以类别数');await expect(page.locator('#evaluation-source')).toContainText('不合并为独立同分布样本');await evidence(page,'synthetic-full',info.project.name,'synthetic');
});

test('SYNTHETIC核对失败、未核对和迟到保持预测但没有实际评分',async({page})=>{
 const run=synthetic();run.evaluation={status:'not_evaluated'};await fixtureRoutes(page,run);await openExperiment(page);
 await expect(page.locator('#evaluation-status')).toContainText('6h 已到期 · 尚未核对');expect((await snapshot(page)).actualCount).toBe(0);await expect(page.locator('.evaluation-windows')).toHaveCount(0);
 for(const reason of ['evaluation_failed','evaluation_invalid','evaluation_incomplete'] as const){run.evaluation={status:'failed',reason};await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#load-status')).toContainText(reason==='evaluation_incomplete'?'核对尚未完成':'核对失败');expect((await snapshot(page)).actualCount).toBe(0);await expect(page.locator('#evaluation-status')).toContainText(reason==='evaluation_invalid'?'核对档案无效':reason==='evaluation_incomplete'?'核对尚未完成':'核对失败');expect((await snapshot(page)).forecastHash).toBe(run.hashes.forecast_sha256);}
 run.evaluation={status:'available',revision_id:'evaluation-20260913T030000000Z-00000000-0000-4000-8000-000000000013',evaluation_sha256:'d'.repeat(64),result:evaluateForecast({forecast:run.forecast,forecastHash:run.hashes.forecast_sha256,candles:[],observedThrough:run.forecast.anchor_time,evaluatedAt:run.forecast.published_at})};await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('[data-window="h6"]')).toHaveAttribute('data-state','not_due');await page.locator('[data-window="h6"] summary').click();await expect(page.getByRole('table',{name:'6h 路径误差'})).toContainText('不可评价');expect((await snapshot(page)).actualCount).toBe(0);
 const late=synthetic(6,6,[],true);await page.unroute('**/api/m1/index');await page.unroute('**/api/m1/runs/'+run.run_id);await fixtureRoutes(page,late);await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#run-status')).toContainText('迟到预报');await expect(page.locator('[data-window="h6"]')).toHaveAttribute('data-state','ineligible');await expect(page.locator('[data-window="h24"] .evaluation-brier')).toContainText('不适用（迟到发布');expect((await snapshot(page)).actualCount).toBe(0);
});

test('SYNTHETIC评分跨run哈希关联错误保留已加载旧图',async({page})=>{
 const run=synthetic();await fixtureRoutes(page,run);await openExperiment(page);const before=await snapshot(page);
 if(run.evaluation.status!=='available')throw Error('Missing fixture evaluation');run.evaluation.result.forecast_hash='e'.repeat(64);
 await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#load-status')).toContainText('加载失败');await expect(page.locator('#errors')).toContainText('不是本次最新成功');
 const after=await snapshot(page);expect(after.forecastHash).toBe(before.forecastHash);expect(after.evaluationRevision).toBe(before.evaluationRevision);expect(after.createdCharts).toBe(before.createdCharts);expect(after.actualCount).toBe(before.actualCount);
});
