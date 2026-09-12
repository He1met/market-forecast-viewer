import{describe,it,expect}from'vitest';
import{readFile}from'node:fs/promises';
import{parseStrict,seal,validateHistory,validateForecast,validateGrids,canonical}from'../src/contracts';
// @ts-expect-error Node script shared with the CLI.
import{normalizeRows,verifySource}from'../scripts/data-utils.mjs';
// @ts-expect-error The deterministic fixture generator is a Node script.
import{generateDemo}from'../scripts/demo-core.mjs';
const read=async(p:string)=>parseStrict(await readFile('public/data/'+p,'utf8'));
const h=await validateHistory(await read('history.json'));
const f=await validateForecast(await read('forecast.demo.json'),h);
const g=await validateGrids(await read('grids.demo.json'),h,f);
describe('真实本地快照与固定演示',()=>{
 it('来源原始字节重建与1344柱固定窗口一致',async()=>{await verifySource(h);expect(h.candles).toHaveLength(1344);});
 it.each(['anchor','cursor','time','path'])('拒绝伪造来源元数据 %s',async name=>{const x=structuredClone(h);if(name==='anchor')x.end_time-=900;if(name==='cursor')x.source.raw_responses[0].params.after='1';if(name==='time')x.source.raw_responses[0].requested_at='2999-01-01T00:00:00Z';if(name==='path')x.source.raw_responses[1].path=x.source.raw_responses[0].path;await expect(verifySource(x)).rejects.toThrow();});
 it('同快照种子生成两次字节相同',async()=>{expect(await generateDemo(h)).toEqual(await generateDemo(h));expect(canonical((await generateDemo(h)).forecast)).toBe(canonical(f));});
 it.each(['{','{"a":1,"a":2}','{"a":1,"\\u0061":2}','[NaN]','{"a":1,}'])('拒绝坏JSON或重复键 %s',s=>expect(()=>parseStrict(s)).toThrow());
 it('缺文件明确失败',async()=>{await expect(read('not-present.json')).rejects.toThrow();});
 const badHistory=[['未知版本',(x:any)=>x.schema_version='2'],['未知字段',(x:any)=>x.fake=true],['错误品种',(x:any)=>x.instrument='ETH-USDT-SWAP'],['毫秒误传',(x:any)=>x.candles[0].open_time*=1000],['整体偏移1秒',(x:any)=>x.candles.forEach((c:any)=>{c.open_time++;c.close_time++;})],['未收盘',(x:any)=>x.candles[0].closed=false],['OHLC',(x:any)=>x.candles[0].high=1],['缺口',(x:any)=>x.candles.splice(10,1)],['重复',(x:any)=>x.candles[10]=x.candles[9]]]as const;
 it.each(badHistory)('拒绝 %s',async(_,mutate)=>{const x=structuredClone(h);mutate(x);await expect(validateHistory(await seal(x))).rejects.toThrow();});
 it('内容或ID篡改',async()=>{await expect(validateHistory({...h,count:1})).rejects.toThrow();await expect(validateHistory({...h,dataset_id:'history:wrong'})).rejects.toThrow();const x=structuredClone(h);x.candles[0].volume_base++;await expect(validateHistory(x)).rejects.toThrow('content_sha256 内容不匹配');});
 it('JSON数值边界',async()=>{const x=structuredClone(h);x.candles[0].close=Infinity;await expect(seal(x)).rejects.toThrow();});
 it.each(['anchor','id','node','band','stage','probability'])('拒绝未来错误 %s',async name=>{const x=structuredClone(f);if(name==='anchor')x.anchor_time-=900;if(name==='id')x.history_dataset_id='wrong';if(name==='node')x.scenarios[0].points[50].time+=1;if(name==='band')x.bands.points[0].inner_lower=x.bands.points[0].outer_upper+1;if(name==='stage')x.stages[0].end_time+=900;if(name==='probability')(x as any).demo_weight=1;await expect(validateForecast(await seal(x),h)).rejects.toThrow();});
 it('接受新增任意模式和方案数',async()=>{const x=structuredClone(g);x.schemes.push({...x.schemes[0],id:'custom',mode:{id:'custom-v4',label:'自定义演示模式'}});await expect(validateGrids(await seal(x),h,f)).resolves.toBeDefined();});
 it.each(['count','bounds','order','distribution','link'])('拒绝网格错误 %s',async name=>{const x=structuredClone(g);if(name==='count')x.schemes[0].levels.pop();if(name==='bounds')x.schemes[0].lower_price++;if(name==='order')x.schemes[0].levels[2]=x.schemes[0].levels[1];if(name==='distribution')x.schemes[0].levels[2]+=1;if(name==='link')x.history_content_sha256='0'.repeat(64);await expect(validateGrids(await seal(x),h,f)).rejects.toThrow();});
});
describe('明确合成的下载适配器单元样例，不是交付行情',()=>{
 const row=['1700000100000','100','110','90','105','10','1','100','1'];
 it('只排除未收盘，相同重复去重',()=>{const n=normalizeRows([row,row,[...row.slice(0,8),'0']]);expect(n.candles).toHaveLength(1);expect(n.quality).toMatchObject({excluded_unclosed_count:1,identical_duplicates_removed:1});});
 it('冲突重复失败',()=>{const r=[...row];r[4]='106';expect(()=>normalizeRows([row,r])).toThrow('冲突');});
 it.each(['','NaN','Infinity',' '])('非法数值 %s 不转0',v=>{const r=[...row];r[1]=v;expect(()=>normalizeRows([r])).toThrow();});
 it('非法confirm拒绝',()=>expect(()=>normalizeRows([[...row.slice(0,8),'2']])).toThrow());
});
