import {readFile,writeFile,mkdir,rename,access} from 'node:fs/promises';
import {dirname} from 'node:path';
import{configuredRoots,dataReference}from'./m1-files.mjs';
import {parseStrict,check,candleSchema,canonical,sha256} from '../src/contracts.ts';
export async function readJson(path){return parseStrict(await readFile(path,'utf8'));}
export async function writeJson(path,data){await mkdir(dirname(path),{recursive:true});const tmp=path+'.tmp';await writeFile(tmp,JSON.stringify(data,null,2)+'\n');await rename(tmp,path);}
export async function exists(path){try{await access(path);return true;}catch{return false;}}
export function normalizeRows(rows,endTime){let excluded=0,duplicates=0;const map=new Map();for(const row of rows){check(Array.isArray(row)&&row.length===9,'OKX元组字段错误');check(row[8]==='0'||row[8]==='1','非法confirm');const nums=row.slice(0,8).map(v=>{check(typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v),'OKX数值字符串错误');const n=Number(v);check(Number.isFinite(n),'OKX非有限值');return n;});check(Number.isSafeInteger(nums[0])&&nums[0]%1000===0,'OKX毫秒时间错误');if(row[8]==='0'){excluded++;continue;}const [ts,open,high,low,close,vc,vb,vq]=nums;const c=candleSchema.parse({open_time:ts/1000,close_time:ts/1000+900,open,high,low,close,volume_contracts:vc,volume_base:vb,volume_quote:vq,closed:true});const old=map.get(c.open_time);if(old){check(canonical(old)===canonical(c),'冲突重复行情');duplicates++;}else map.set(c.open_time,c);}
 const all=[...map.values()].sort((a,b)=>a.open_time-b.open_time);const end=endTime??all.at(-1)?.close_time;check(end,'没有完整行情');return {end,candles:all.filter(c=>c.open_time>=end-14*86400&&c.close_time<=end),quality:{excluded_unclosed_count:excluded,identical_duplicates_removed:duplicates,gaps:[],conflicting_duplicates:[]}};}
export async function verifySource(h){
 const rows=[],paths=new Set();let previousOldest,previousTime=0;
 for(let i=0;i<h.source.raw_responses.length;i++){
  const r=h.source.raw_responses[i];check(!paths.has(r.path),'原始响应path重复');paths.add(r.path);
  const requested=Date.parse(r.requested_at);check(requested>=previousTime&&requested<=Date.parse(h.downloaded_at),'来源请求时间顺序错误');previousTime=requested;
  check(!r.params.before,'不支持before历史分页');if(i===0)check(!r.params.after,'首页不能带游标');else check(r.params.after===String(previousOldest),'分页after不等于前页最早时间');
  const bytes=await readFile(dataReference(r.path,configuredRoots().data_root));check(await sha256(bytes)===r.sha256,'原始响应hash不匹配');const body=parseStrict(bytes.toString('utf8'));check(body.code==='0'&&Array.isArray(body.data)&&body.data.length>0,'原始响应错误');
  const page=normalizeRows(body.data);if(i===0)check(page.end===h.end_time,'截止不是首页最新完整柱');
  const oldest=Math.min(...body.data.map(r=>Number(r[0])));check(i===0||oldest<previousOldest,'分页游标未递减');previousOldest=oldest;rows.push(...body.data);
 }
 const normalized=normalizeRows(rows,h.end_time);check(canonical(normalized.candles)===canonical(h.candles),'原始来源与规范化OHLC不一致');check(canonical(normalized.quality)===canonical(h.quality),'来源质量统计不一致');
}
