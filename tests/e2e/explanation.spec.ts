import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { seal } from '../../src/contracts';
const forecast=JSON.parse(await readFile('public/data/forecast.demo.json','utf8'));
const grids=JSON.parse(await readFile('public/data/grids.demo.json','utf8'));

test('生成依据键盘展开、文件统计同步与真实布局',async({page,browser},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/?test=1');await expect(page.locator('#load-status')).toContainText('已校验');
  await expect(page.getByText('概率：未计算（固定 DEMO）',{exact:true})).toBeVisible();
  const chart=await page.locator('#chart').boundingBox();expect(chart!.height).toBeGreaterThanOrEqual(345);
  const summary=page.locator('#generation summary');await summary.focus();await page.keyboard.press('Enter');
  await expect(page.locator('#generation')).toHaveAttribute('open','');
  await expect(page.locator('#generation-content')).toContainText(forecast.generator_version);
  await expect(page.locator('#generation-content')).toContainText(String(forecast.seed));
  for(const s of forecast.scenarios)await expect(page.locator('#generation-content')).toContainText(s.description);
  await expect(page.locator('#generation-content')).toContainText(String(forecast.anchor_price));
  for(const scheme of grids.schemes){
    await page.getByLabel('网格方案',{exact:true}).selectOption(scheme.id);
    const below=scheme.levels.filter((p:number)=>p<grids.anchor_price).length;
    const equal=scheme.levels.filter((p:number)=>p===grids.anchor_price).length;
    const above=scheme.levels.length-below-equal;
    await expect(page.locator('#grid-position')).toContainText(`价格线：锚点下 ${below} / 等于锚点 ${equal} / 锚点上 ${above}`);
    const percent=(p:number)=>{const n=(p/grids.anchor_price-1)*100;return `${n>0?'+':''}${n.toFixed(2)}%`;};
    await expect(page.locator('#grid-position')).toContainText(`下界 ${percent(scheme.lower_price)} / 上界 ${percent(scheme.upper_price)}`);
    await expect(page.locator('#grid-summary')).toContainText(`${scheme.interval_count} 区间 / ${scheme.levels.length} 条价格线`);
    await expect(page.locator('#position-label')).toContainText('未模拟底仓、未生成实际订单');
    await expect(page.locator('#position-label')).toContainText(scheme.initial_position_label);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await mkdir('artifacts/m01',{recursive:true});
  const expanded=`artifacts/m01/explanation-expanded-${info.project.name}.png`;
  await page.screenshot({path:expanded,fullPage:true});
  await summary.focus();await page.keyboard.press('Enter');await expect(page.locator('#generation')).not.toHaveAttribute('open','');
  await page.getByLabel('网格方案',{exact:true}).selectOption(grids.default_scheme_id);
  await page.getByRole('button',{name:'重置视图'}).click();
  const box=(await page.locator('#chart').boundingBox())!;
  const range=()=>page.evaluate(()=>(window as any).chartTest.snapshot().range);
  const old=await range();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.wheel(0,-200);
  await expect.poll(async()=>{const r=await range();return r.to-r.from;}).not.toBe(old.to-old.from);
  await page.getByRole('button',{name:'重置视图'}).click();await page.mouse.move(0,0);
  const closed=`artifacts/m01/explanation-default-${info.project.name}.png`;await page.screenshot({path:closed,fullPage:true});
  await writeFile(closed+'.json',JSON.stringify({browser:browser.version(),viewport:page.viewportSize(),dpr:await page.evaluate(()=>devicePixelRatio),user_approved:false,visibility:'LOCAL_ONLY',screenshots:await Promise.all([expanded,closed].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2));
  expect(errors).toEqual([]);
});

test('未知生成器保守说明、坏文件清除元数据与统计后恢复',async({page})=>{
  const unknown=await seal({...forecast,generator_version:'unknown-next-version'});
  await page.route('**/data/forecast.demo.json',route=>route.fulfill({json:unknown}));
  await page.goto('/?test=1');await expect(page.locator('#load-status')).toContainText('已校验');
  await page.locator('#generation summary').click();
  await expect(page.locator('#generation-content')).toContainText('算法尚未核实');
  await expect(page.locator('#generation-content')).not.toContainText('固定模板分段线性插值');
  await page.route('**/data/grids.demo.json',route=>route.fulfill({body:'{bad',contentType:'application/json'}));
  await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#errors')).toBeVisible();
  await expect(page.locator('#grid-position')).toHaveText('相对边界与锚点统计不可用');
  await expect(page.locator('#generation-content')).toContainText('网格元数据不可用');
  await page.unroute('**/data/forecast.demo.json');await page.route('**/data/forecast.demo.json',route=>route.fulfill({body:'{bad',contentType:'application/json'}));
  await page.getByRole('button',{name:'重载文件'}).click();
  await expect(page.locator('#generation-content')).toContainText('DEMO 元数据不可用');
  await expect(page.locator('#generation-content')).not.toContainText('unknown-next-version');
  await expect(page.getByLabel('网格方案',{exact:true})).toBeDisabled();
  await page.unroute('**/data/forecast.demo.json');await page.unroute('**/data/grids.demo.json');
  await page.getByRole('button',{name:'重载文件'}).click();await expect(page.locator('#load-status')).toContainText('已校验');
  await expect(page.locator('#generation-content')).toContainText(forecast.generator_version);
  await expect(page.locator('#grid-position')).toContainText('价格线：');
});
