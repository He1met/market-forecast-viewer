import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { type DisplayIndex, type RuntimeDisplay } from '../../src/m1-display';

const at='2026-09-13T07:00:00.000Z';
const forecastId='m1-20260913T070000000Z-00000000-0000-4000-8000-000000000014';
/** Browser-only synthetic runtime state. Never writes a business status or publication. */
function runtime():RuntimeDisplay{return {schema:'MFV:M1_RUNTIME_DISPLAY:v1',checked_at:at,
 release_integrity:'verified',
 configuration:{task_name:'M1 实验预测运行',frequency_hours:2,time_zone:null,enabled:true,next_run_at:null,read_back_at:at},
 paused:false,latest_attempt:{cycle_id:'synthetic-runtime-cycle',trigger:'scheduled',status:'running',stage:'generate',
 started_at:at,updated_at:at,completed_at:null,reason:null,forecast_id:null},
 last_success:{cycle_id:'synthetic-prior-success',completed_at:at,forecast_id:forecastId}};}
const emptyIndex=():DisplayIndex=>({schema:'MFV:M1_INDEX:v1',checked_at:new Date().toISOString(),latest_run_id:null,latest_attempt:null,runs:[]});
async function openExperiment(page:Page){await page.goto('/?test=1');await expect(page.locator('#load-status')).toContainText('已校验');await page.getByLabel('查看内容',{exact:true}).selectOption('experiment');await expect(page.locator('#runtime-panel')).toBeVisible();}
async function refresh(page:Page){await page.getByRole('button',{name:'读取最新索引',exact:true}).click();}

test('SYNTHETIC业务状态展示未配置、运行、失败、代码变更跳过和暂停，计划时间未知',async({page},info)=>{
 let value:RuntimeDisplay={...runtime(),configuration:null,release_integrity:'unconfigured',latest_attempt:null,last_success:null};
 await page.route('**/api/m1/index',route=>route.fulfill({json:emptyIndex()}));
 await page.route('**/api/m1/runtime',route=>route.fulfill({json:value}));
 await openExperiment(page);await expect(page.locator('#runtime-details')).toContainText('业务任务未配置');
 await expect(page.locator('#runtime-panel')).toContainText('关闭页面不会停止业务任务');
 value=runtime();await refresh(page);await expect(page.locator('#runtime-status')).toHaveText('运行中');
 await expect(page.locator('#runtime-details')).toContainText('每 2 小时');await expect(page.locator('#runtime-details')).toContainText('调度时区：未知');
 await expect(page.locator('#runtime-details')).toContainText('回读时启用');await expect(page.locator('#runtime-details')).toContainText('下次官方计划时间：未知');
 value.latest_attempt={...value.latest_attempt!,status:'failed',completed_at:at,reason:'runtime_failed'};
 await refresh(page);await expect(page.locator('#runtime-status')).toHaveText('运行失败');
 await expect(page.locator('#runtime-details')).toContainText('旧预报首次发布时间不变');await expect(page.locator('#runtime-details')).toContainText('最近业务成功：'+at);
 value.latest_attempt={...value.latest_attempt!,status:'skipped',reason:'code_changed'};
 await refresh(page);await expect(page.locator('#runtime-status')).toHaveText('本轮已跳过');await expect(page.locator('#runtime-details')).toContainText('代码或模型配置变更');
 value.paused=true;await refresh(page);await expect(page.locator('#runtime-status')).toHaveText('本地暂停标记生效');
 await expect(page.locator('#runtime-details')).toContainText('回读时启用');await expect(page.locator('#runtime-panel')).toContainText('暂停不等于终止当前进程');
 const directory=`artifacts/${process.env.CHART_STAGE??'m14'}/ui`;await mkdir(directory,{recursive:true});
 await page.locator('#runtime-panel').screenshot({path:`${directory}/synthetic-runtime-paused-${info.project.name}.png`});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 value.paused=false;value.latest_attempt={...value.latest_attempt!,status:'completed',reason:null,forecast_id:forecastId,stage:'done'};
 value.last_success={cycle_id:value.latest_attempt.cycle_id,completed_at:at,forecast_id:forecastId};
 await refresh(page);await expect(page.locator('#runtime-status')).toHaveText('成功完成');
 value.release_integrity='changed';await refresh(page);await expect(page.locator('#runtime-status')).toContainText('固定发布版本已改变');
 await expect(page.locator('#runtime-details')).toContainText('最近业务尝试：成功完成');await expect(page.locator('#runtime-details')).toContainText('未伪造新的运行尝试');
 value.release_integrity='unknown';await refresh(page);await expect(page.locator('#runtime-details')).toContainText('固定发布版本核验未知');
 await page.getByLabel('查看内容',{exact:true}).selectOption('demo');await expect(page.locator('#runtime-panel')).toBeHidden();await expect(page.locator('.demo-badge')).toContainText('DEMO');
});

test('SYNTHETIC业务状态读取失败和坏契约不会挡住预报索引或暴露原始错误',async({page})=>{
 let bad=true;
 await page.route('**/api/m1/index',route=>route.fulfill({json:emptyIndex()}));
 await page.route('**/api/m1/runtime',route=>route.fulfill(bad?{status:422,json:{error:'SYNTHETIC_PRIVATE_PATH_AND_ERROR'}}:{json:runtime()}));
 await openExperiment(page);await expect(page.locator('#runtime-status')).toContainText('当前状态未知');await expect(page.locator('#load-status')).toContainText('暂无实验预测');
 await expect(page.locator('body')).not.toContainText('SYNTHETIC_PRIVATE_PATH_AND_ERROR');
 bad=false;await refresh(page);await expect(page.locator('#runtime-status')).toHaveText('运行中');
 await page.unroute('**/api/m1/runtime');await page.route('**/api/m1/runtime',route=>route.fulfill({json:{...runtime(),raw_error:'SYNTHETIC_PRIVATE_PATH_AND_ERROR'}}));
 await refresh(page);await expect(page.locator('#runtime-status')).toContainText('当前状态未知');await expect(page.locator('body')).not.toContainText('SYNTHETIC_PRIVATE_PATH_AND_ERROR');
});

test('SYNTHETIC最新业务失败保持真实原预报，分钟刷新仅GET运行状态',async({page,request},info)=>{
 const index:DisplayIndex=await (await request.get('/api/m1/index')).json();
 const chosen=index.latest_run_id??index.runs.find(run=>run.status==='valid'||run.status==='late')?.run_id;
 expect(chosen,'Portable SYNTHETIC archived forecast required').toBeTruthy();
 await page.route('**/api/m1/index',route=>route.fulfill({json:index}));
 const value=runtime();value.latest_attempt={...value.latest_attempt!,status:'failed',reason:'runtime_failed',completed_at:at};
 await page.route('**/api/m1/runtime',route=>route.fulfill({json:value}));
 await page.clock.install();await openExperiment(page);await expect(page.locator('#load-status')).toContainText('实验档案已校验');
 await expect(page.locator('#runtime-status')).toHaveText('运行失败');await expect(page.locator('#runtime-details')).toContainText('最近业务成功：');
 const snapshot=()=>page.evaluate(()=>(window as any).chartTest.snapshot());const before=await snapshot();expect(before.runId).toBe(chosen);
 const originalPublished=await page.locator('#run-status').innerText();
 const requests:{url:string,method:string}[]=[];
 page.on('request',event=>{if(event.url().includes('/api/m1/'))requests.push({url:new URL(event.url()).pathname,method:event.method()});});
 value.paused=true;await page.clock.fastForward(61000);await expect(page.locator('#runtime-status')).toHaveText('本地暂停标记生效');
 expect(requests.length).toBeGreaterThan(0);expect(requests.every(event=>event.url.startsWith('/api/m1/')&&event.method==='GET')).toBe(true);
 const after=await snapshot();expect(after.runId).toBe(before.runId);expect(after.forecastHash).toBe(before.forecastHash);expect(after.createdCharts).toBe(before.createdCharts);
 expect(await page.locator('#run-status').innerText()).toBe(originalPublished);
 const directory=`artifacts/${process.env.CHART_STAGE??'m14'}/ui`;await mkdir(directory,{recursive:true});
 await page.screenshot({path:`${directory}/synthetic-runtime-with-archived-forecast-${info.project.name}.png`,fullPage:true});
});

test('installed runtime renders stale inspection and preserves publication success',async({page},info)=>{
 let value:RuntimeDisplay={...runtime(),source:'installed',configuration:null,latest_attempt:null,
  inspection:{paused:false,freshness:'stale',last_observed_at:'2026-09-13T05:00:00.000Z',result:'ok'}};
 await page.route('**/api/m1/runtime',route=>route.fulfill({json:value}));
 await openExperiment(page);
 await expect(page.locator('#runtime-details')).toContainText('巡检信息陈旧（超过90分钟）');
 await expect(page.locator('#runtime-details')).toContainText('最近预报发布成功：');
 await expect(page.locator('#runtime-details')).toContainText('状态读取不会刷新巡检时间');
 value={...value,paused:true,inspection:{...value.inspection!,paused:true,result:'failed'}};await refresh(page);
 await expect(page.locator('#runtime-details')).toContainText('巡检：暂停；巡检信息陈旧');
 await expect(page.locator('#runtime-details')).toContainText('存在未解决异常');
 const directory='artifacts/m14';await mkdir(directory,{recursive:true});
 await page.locator('#runtime-panel').screenshot({path:`${directory}/synthetic-installed-stale-${info.project.name}.png`});
});
