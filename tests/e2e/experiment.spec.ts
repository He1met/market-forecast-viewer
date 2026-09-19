import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { displayTime } from '../../src/forecast-presentation';
import type { DisplayIndex, DisplayRun } from '../../src/m1-display';
const snapshot=(page:Page)=>page.evaluate(()=>(window as any).chartTest.snapshot());
const runId='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
async function openExperiment(page:Page){await page.goto('/?test=1');await expect(page.locator('#load-status')).toContainText('已校验');await page.getByLabel('查看内容',{exact:true}).selectOption('experiment');await expect(page.locator('#load-status')).toContainText('实验档案已校验');await expect.poll(async()=>(await snapshot(page)).runId).toBe(runId);}
async function stageAligned(page:Page){await expect.poll(async()=>(await snapshot(page)).stageRendered.length).toBe(3);await expect.poll(async()=>{const state=await snapshot(page);return Math.max(...state.stageRendered.flatMap((actual:any)=>{const expected=state.stageCoordinateCheck.find((x:any)=>x.id===actual.id);return ['startX','endX','lowerY','upperY'].map(key=>expected?.[key]===null?Infinity:Math.abs(actual[key]-expected[key]));}));}).toBeLessThanOrEqual(1);const s=await snapshot(page);expect(s.rangeKind).toBe('model_range_estimate');expect(s.vertices).toEqual([]);for(const actual of s.stageRendered){const expected=s.stageCoordinateCheck.find((x:any)=>x.id===actual.id);for(const key of ['startX','endX','lowerY','upperY']){expect(expected[key]).not.toBeNull();expect(Math.abs(actual[key]-expected[key])).toBeLessThanOrEqual(1);}if(expected.candleY!==null)expect(Math.abs(expected.upperY-expected.candleY)).toBeLessThanOrEqual(1);}return s;}
async function evidence(page:Page,name:string,project:string){const directory=`artifacts/${process.env.CHART_STAGE??'m12'}`;await mkdir(directory,{recursive:true});const file=`${directory}/${name}-${project}.png`;await page.screenshot({path:file,fullPage:true});await writeFile(file+'.json',JSON.stringify({visibility:'LOCAL_ONLY',user_approved:false,run_id:runId,screenshot_sha256:createHash('sha256').update(await readFile(file)).digest('hex'),viewport:page.viewportSize(),dpr:await page.evaluate(()=>devicePixelRatio),snapshot:await snapshot(page)},null,2));}
async function chartResizeSettled(page:Page){
 // autoSize uses ResizeObserver and a subsequent Canvas draw; changing the viewport only
 // settles CSS layout. The library rounds its chart dimensions down to even CSS pixels.
 // fancy-canvas uses ResizeObserverEntry.devicePixelContentBoxSize for its bitmap. That
 // browser value need not equal CSS * an emulated window.devicePixelRatio; do not impose
 // that unrelated bitmap assumption on the CSS coordinate/bounds regression.
 await expect(page.evaluate(()=>devicePixelRatio)).resolves.toBe(test.info().project.use.deviceScaleFactor??1);
 await expect.poll(()=>page.locator('#chart').evaluate(container=>{
  const table=container.querySelector('table'),canvas=container.querySelector('canvas');if(!table||!canvas)return {chartReady:false};
  const outer=container.getBoundingClientRect(),chart=table.getBoundingClientRect(),pane=canvas.getBoundingClientRect();
  const even=(n:number)=>Math.floor(n)-Math.floor(n)%2;
  const state=(window as any).chartTest.snapshot();
  return {chartReady:true,widthMatches:chart.width===even(outer.width),heightMatches:chart.height===even(outer.height),stageCount:state.stageRendered.length,
   stagesInPane:state.stageRendered.every((stage:any)=>stage.upperY>=0&&stage.lowerY<=pane.height),
   dimensions:{container:{width:outer.width,height:outer.height},chart:{width:chart.width,height:chart.height},pane:{width:pane.width,height:pane.height},bitmap:{width:canvas.width,height:canvas.height},dpr:devicePixelRatio},
   stageRendered:state.stageRendered,stageCoordinateCheck:state.stageCoordinateCheck};
 })).toMatchObject({chartReady:true,widthMatches:true,heightMatches:true,stageCount:3,stagesInPane:true});
}

test('SYNTHETIC实验run同图显示、单层阶段范围、概率依据与图形交互',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await openExperiment(page);
 await expect(page.locator('.demo-badge')).toContainText('Codex 实验预报');await expect(page.locator('.grid-controls')).toBeHidden();await expect(page.locator('.demo-context')).toBeHidden();
 await expect(page.locator('#probabilities')).toContainText('未来24h');await expect(page.locator('#experiment-summary')).toContainText('未纳入事件风险');if((await snapshot(page)).evaluationStatus==='available'){await expect(page.locator('#evaluation-status')).toContainText('当次核对');await expect(page.locator('[data-window="h6"]')).toContainText('完整核对');}else await expect(page.locator('#evaluation-status')).toContainText('6h 已到期 · 尚未核对');
 expect((await snapshot(page)).pathCount).toBe(6);expect((await snapshot(page)).gridLineCount).toBe(0);expect((await snapshot(page)).historyCount).toBe(1344);
 const colored=()=>page.locator('#chart canvas').first().evaluate((canvas:HTMLCanvasElement)=>{const p=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;let n=0;for(let i=0;i<p.length;i+=4)if((p[i]===86&&p[i+1]===190)||(p[i]===235&&p[i+1]===130))n++;return n;});await expect.poll(colored).toBeGreaterThan(100);
 const box=(await page.locator('#chart').boundingBox())!;const before=await snapshot(page);await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5);await page.mouse.wheel(0,-220);await expect.poll(async()=>{const s=await snapshot(page);return s.range.to-s.range.from;}).not.toBe(before.range.to-before.range.from);
 const from=(await snapshot(page)).range.from;await page.mouse.down();await page.mouse.move(box.x+box.width*.48,box.y+box.height*.5,{steps:10});await page.mouse.up();await expect.poll(async()=>(await snapshot(page)).range.from).not.toBe(from);
 const state=await snapshot(page),spacing=Math.abs(state.priceY2-state.priceY);await page.mouse.move(box.x+box.width-state.priceWidth/2,box.y+box.height*.45);await page.mouse.down();await page.mouse.move(box.x+box.width-state.priceWidth/2,box.y+box.height*.45+80,{steps:12});await page.mouse.up();await expect.poll(async()=>{const s=await snapshot(page);return Math.abs(s.priceY2-s.priceY);}).not.toBe(spacing);
 await stageAligned(page);await page.getByRole('button',{name:'重置视图'}).click();await stageAligned(page);await evidence(page,'experiment-default',info.project.name);
 await page.locator('#forecast-basis>summary').click();await page.locator('#scenario-evidence summary').first().click();await expect(page.locator('#scenario-evidence')).toContainText('反对依据');await expect(page.locator('#scenario-evidence')).toContainText('失效条件');await expect(page.locator('#scenario-evidence')).toContainText('事件定义');
 await page.getByText('来源与预报版本',{exact:true}).click();await expect(page.locator('#experiment-summary')).toContainText('实际模型标识：unknown');await evidence(page,'experiment-evidence',info.project.name);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
});

test('实验窗口和隐藏保留24h概率、纯未来与DEMO回切',async({page},info)=>{
 await openExperiment(page);const labels=await page.locator('#legend').innerText(),before=await snapshot(page);
 for(const hours of [6,12,24]){await page.getByLabel('未来展示窗口').selectOption(String(hours));await expect.poll(async()=>Number((await snapshot(page)).visibleTime.to)).toBe(before.anchor+hours*3600);expect(await page.locator('#legend').innerText()).toBe(labels);expect((await snapshot(page)).forecastHash).toBe(before.forecastHash);}
 for(const checkbox of await page.locator('#legend input').all())await checkbox.uncheck();expect((await snapshot(page)).visiblePaths).toEqual([]);expect(await page.locator('#legend').innerText()).toBe(labels);
 await page.evaluate(({from,to})=>(window as any).chartTest.setRange(from,to),{from:before.anchor+900,to:before.anchor+86400});await expect.poll(async()=>(await snapshot(page)).priceY).not.toBeNull();
 await page.setViewportSize({width:1100,height:820});await chartResizeSettled(page);const aligned=await stageAligned(page);const pane=(await page.locator('#chart').boundingBox())!;for(const stage of aligned.stageRendered){expect(stage.upperY).toBeGreaterThanOrEqual(0);expect(stage.lowerY).toBeLessThanOrEqual(pane.height);}await evidence(page,'experiment-future-hidden',info.project.name);
 await page.getByLabel('查看内容',{exact:true}).selectOption('demo');await expect(page.locator('#load-status')).toContainText('固定 DEMO');expect((await snapshot(page)).pathCount).toBe(3);expect((await snapshot(page)).gridLineCount).toBeGreaterThan(0);await expect(page.getByText('概率：未计算（固定 DEMO）',{exact:true})).toBeVisible();
});

test('坏索引、缺文件和跨run关联错误保留旧图并明确更新失败',async({page})=>{
 await openExperiment(page);const before=await snapshot(page);
 for(const kind of ['index','missing','association']){
  const pattern=kind==='index'?'**/api/m1/index':'**/api/m1/runs/*';
  await page.route(pattern,async route=>{if(kind==='index')await route.fulfill({json:{schema:'unknown'}});else if(kind==='missing')await route.fulfill({status:404,json:{error:'missing'}});else{const response=await route.fetch();const run=await response.json();run.forecast.anchor_time+=900;await route.fulfill({json:run});}});
  await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#load-status')).toContainText('加载失败');await expect(page.locator('#errors')).toContainText('不是本次最新成功');const after=await snapshot(page);expect(after.runId).toBe(before.runId);expect(after.forecastHash).toBe(before.forecastHash);expect(after.createdCharts).toBe(before.createdCharts);expect(after.activeCharts).toBe(1);
  await page.unroute(pattern);
 }
 await page.getByRole('button',{name:'返回最新'}).click();await expect(page.locator('#load-status')).toContainText('实验档案已校验');await expect(page.locator('#errors')).toBeHidden();
});

test('synthetic历史run切换、最新失败与迟到状态，不执行HTML',async({page,request})=>{
 const index:DisplayIndex=await (await request.get('/api/m1/index')).json();const run:DisplayRun=await (await request.get('/api/m1/runs/'+runId)).json();
 const synthetic=structuredClone(run);synthetic.evaluation={status:'not_evaluated'};synthetic.run_id=synthetic.forecast.run_id='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000001';synthetic.forecast.summary='SYNTHETIC browser fixture <img src=x onerror=window.injected=true>';synthetic.forecast.published_at=new Date((run.forecast.anchor_time+1800)*1000).toISOString();synthetic.forecast.status='late';synthetic.forecast.eligible_as_latest=false;
 const entry={run_id:synthetic.run_id,created_at:index.runs[0].created_at,published_at:synthetic.forecast.published_at,status:'late' as const,reason:'publication_late' as const};
 const failed={run_id:'m1-20260913T000000000Z-00000000-0000-4000-8000-000000000002',created_at:'2026-09-13T00:00:00.000Z',published_at:null,status:'failed' as const,reason:'generation_failed' as const};
 const latest_attempt={run_id:failed.run_id,created_at:failed.created_at,status:failed.status,reason:failed.reason};
 const mockIndex={...index,runs:[failed,...index.runs.filter(r=>r.status==='valid'),entry],latest_attempt};
 await page.route('**/api/m1/index',route=>route.fulfill({json:mockIndex}));await page.route('**/api/m1/runs/'+synthetic.run_id,route=>route.fulfill({json:synthetic}));
 await openExperiment(page);await expect(page.locator('#errors')).toContainText('模型生成失败');await expect(page.locator('#run-status')).toContainText('首次发布');
 await page.getByLabel('历史预报',{exact:true}).selectOption(synthetic.run_id);await expect.poll(async()=>(await snapshot(page)).runId).toBe(synthetic.run_id);await expect(page.locator('#run-status')).toContainText('迟到预报');await expect(page.locator('#experiment-summary')).toContainText('SYNTHETIC browser fixture');expect(await page.evaluate(()=>(window as any).injected)).toBeUndefined();expect(await page.locator('#experiment-summary img').count()).toBe(0);
 await page.getByLabel('历史预报',{exact:true}).selectOption(runId);await expect.poll(async()=>(await snapshot(page)).runId).toBe(runId);expect((await snapshot(page)).activeCharts).toBe(1);expect((await snapshot(page)).gridLineCount).toBe(0);
});

test('跨模式慢请求不得覆盖新选择，空实验索引明确显示',async({page})=>{
 await openExperiment(page);let calls=0;
 await page.route('**/api/m1/index',async route=>{calls++;await new Promise(resolve=>setTimeout(resolve,350));await route.fulfill({json:{schema:'MFV:M1_INDEX:v1',checked_at:new Date().toISOString(),latest_run_id:null,latest_attempt:null,runs:[]}}).catch(()=>{});});
 await page.getByRole('button',{name:'重载文件'}).click();await expect.poll(()=>calls).toBe(1);await page.getByLabel('查看内容',{exact:true}).selectOption('demo');await expect(page.locator('#load-status')).toContainText('固定 DEMO');await page.waitForTimeout(400);expect((await snapshot(page)).mode).toBe('demo');
 await page.getByLabel('查看内容',{exact:true}).selectOption('experiment');await expect(page.locator('#load-status')).toContainText('暂无实验预测');expect((await snapshot(page)).activeCharts).toBe(0);await expect(page.locator('#evaluation-status')).toContainText('暂无可核对');
});

test('历史run从索引消失和发布状态冲突不得静默换档',async({page,request})=>{
 const index:DisplayIndex=await (await request.get('/api/m1/index')).json();await openExperiment(page);const before=await snapshot(page);
 const failed=index.runs.find(r=>r.status==='failed')!;
 await page.route('**/api/m1/index',route=>route.fulfill({json:{...index,latest_run_id:null,latest_attempt:{run_id:failed.run_id,created_at:failed.created_at,status:failed.status,reason:failed.reason},runs:[failed]}}));
 await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#errors')).toContainText('所选历史预报已从索引缺失');expect((await snapshot(page)).runId).toBe(before.runId);expect((await snapshot(page)).createdCharts).toBe(before.createdCharts);
 await page.unroute('**/api/m1/index');const mismatch=structuredClone(index);mismatch.runs.find(r=>r.run_id===runId)!.published_at=new Date(Date.parse(index.runs[0].published_at!)+1000).toISOString();
 await page.route('**/api/m1/index',route=>route.fulfill({json:mismatch}));await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#errors')).toContainText('索引与预报状态或首次发布时间不一致');expect((await snapshot(page)).forecastHash).toBe(before.forecastHash);
});

test('synthetic过期预报仅供历史回看，原首次发布时间保留',async({page,request})=>{
 const original:DisplayRun=await (await request.get('/api/m1/runs/'+runId)).json();const offset=2*86400;
 const shift=(value:any,key=''):any=>{if(Array.isArray(value))return value.map(v=>shift(v));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shift(v,k)]));if(typeof value==='number'&&['anchor_time','data_cutoff','start_time','end_time','open_time','close_time','time'].includes(key))return value-offset;if(typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value))return new Date(Date.parse(value)-offset*1000).toISOString();return value;};
 const run:DisplayRun=shift(original);run.evaluation={status:'not_evaluated'};run.run_id=run.forecast.run_id='m1-20260910T183644170Z-00000000-0000-4000-8000-000000000003';run.forecast.summary='SYNTHETIC expired browser fixture';run.hashes={input_sha256:'0'.repeat(64),forecast_sha256:'1'.repeat(64)};
 const entry={run_id:run.run_id,created_at:'2026-09-10T18:36:44.170Z',published_at:run.forecast.published_at,status:'valid',reason:'forecast_expired'};
 await page.route('**/api/m1/index',route=>route.fulfill({json:{schema:'MFV:M1_INDEX:v1',checked_at:new Date().toISOString(),latest_run_id:null,latest_attempt:{run_id:entry.run_id,status:entry.status,created_at:entry.created_at,reason:entry.reason},runs:[entry]}}));await page.route('**/api/m1/runs/'+run.run_id,route=>route.fulfill({json:run}));
 await page.goto('/?test=1');await expect(page.locator('#load-status')).toContainText('已校验');await page.getByLabel('查看内容',{exact:true}).selectOption('experiment');await expect(page.locator('#run-status')).toContainText('预报已过期 · 历史回看');await expect(page.locator('#run-status')).toContainText(displayTime(run.forecast.published_at));expect((await snapshot(page)).latestRunId).toBeNull();await expect(page.locator('#evaluation-status')).toContainText('24h 已到期 · 尚未核对');
});
