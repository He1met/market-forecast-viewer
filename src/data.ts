import{parseStrict,validateHistory,validateForecast,validateGrids,type History,type Forecast,type Grids}from'./contracts';
export type Dataset={history?:History;forecast?:Forecast;grids?:Grids;errors:string[]};
const files=['history.json','forecast.demo.json','grids.demo.json'];
function reason(e:unknown){if(e&&typeof e==='object'&&'issues'in e){const issue=(e as {issues:{path:(string|number)[];message:string}[]}).issues[0];return `${issue.path.join('.')}：${issue.message}`;}return e instanceof Error?e.message:String(e);}
export async function loadDataset(signal?:AbortSignal):Promise<Dataset>{const errors:string[]=[],result:Dataset={errors};const reads=await Promise.allSettled(files.map(async name=>{const r=await fetch('/data/'+name,{cache:'no-store',signal});if(!r.ok)throw Error(`HTTP ${r.status}，文件缺失或不可读`);return parseStrict(await r.text());}));const read=(i:number)=>{const r=reads[i];if(r.status==='rejected')throw r.reason;return r.value;};const fail=(i:number,e:unknown)=>errors.push(`public/data/${files[i]}：${reason(e)}。请修复或恢复有效文件后手动重载；生成DEMO前先校验历史。`);
try{result.history=await validateHistory(read(0));}catch(e){fail(0,e);return result;}
try{result.forecast=await validateForecast(read(1),result.history);}catch(e){fail(1,e);return result;}
try{result.grids=await validateGrids(read(2),result.history,result.forecast);}catch(e){fail(2,e);}return result;}
