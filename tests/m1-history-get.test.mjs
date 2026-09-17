import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHistoryGetter} from '../scripts/m1-history-get.mjs';
import {downloadRunHistory,prepareForecast} from '../scripts/m1-input.mjs';
const url='https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=15m&limit=300';
const error=(code,extra={})=>Object.assign(Error('SYNTHETIC curl failure'),{code,stderr:'SYNTHETIC stderr',...extra});
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-history-get-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const output=args=>args[args.indexOf('--output')+1];
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
for(const kind of ['forecast','outcome']){
 test(`${kind}: only curl35 retries same page once, immutable failed response, shared deadline`,async t=>{
  const root=await fixture(t),file=path.join(root,'page-001.json');let clock=0;const calls=[];
  const get=createHistoryGetter({monotonic:()=>clock,execute:async(cmd,args,options)=>{calls.push({cmd,args,options});await fs.writeFile(output(args),calls.length===1?'SYNTHETIC FAILED BYTES':'SYNTHETIC SUCCESS');clock+=5000;if(calls.length===1)throw error(35);return{stdout:'200',stderr:''};}});
  const r=await get({url,file,kind,deadline:200000});assert.equal(r.http_code,'200');assert.equal(calls.length,2);
  assert.equal(calls[0].args.at(-1),calls[1].args.at(-1));assert.equal(calls[0].options.timeout-calls[1].options.timeout,5000);
  assert.equal(await fs.readFile(file,'utf8'),'SYNTHETIC SUCCESS');const base=path.join(root,'request-attempts/page-001');
  assert.equal(await fs.readFile(path.join(base,'attempt-001/response.bin'),'utf8'),'SYNTHETIC FAILED BYTES');
  assert.equal((await read(path.join(base,'attempt-001/result.json'))).exit_code,35);
  assert.equal((await read(path.join(base,'attempt-002/result.json'))).exit_code,0);
  await assert.rejects(get({url,file,kind,deadline:200000}),/EEXIST/);assert.equal(calls.length,2);
 });
 test(`${kind}: exhausted35 fails after exactly two attempts and commits no page`,async t=>{
  const root=await fixture(t);let count=0;const get=createHistoryGetter({execute:async()=>{count++;throw error(35);}});
  await assert.rejects(get({url,file:path.join(root,'page-001.json'),kind,deadline:performance.now()+200000}),/SYNTHETIC/);assert.equal(count,2);
  await assert.rejects(fs.stat(path.join(root,'page-001.json')),/ENOENT/);
 });
 for(const fault of [error(28),error(60),error(22),error('35'),error(35,{killed:true}),error(35,{signal:'SIGTERM'})])test(`${kind}: no retry ${fault.code}/${fault.killed}/${fault.signal}`,async t=>{
  const root=await fixture(t);let count=0;const get=createHistoryGetter({execute:async()=>{count++;throw fault;}});await assert.rejects(get({url,file:path.join(root,'page-001.json'),kind,deadline:performance.now()+200000}));assert.equal(count,1);
 });
 test(`${kind}: HTTP error is not retried`,async t=>{const root=await fixture(t);let count=0;const get=createHistoryGetter({execute:async(cmd,args)=>{count++;await fs.writeFile(output(args),'HTTP ERROR');return{stdout:'503'};}});await assert.rejects(get({url,file:path.join(root,'page-001.json'),kind,deadline:performance.now()+200000}),/HTTP_FAILED/);assert.equal(count,1);});
}
test('aborted before request, aborted between attempts, expired page, infinite deadline and model reserve forbid retry',async t=>{
 for(const mode of ['before','between','expired','infinite','reserve']){
  const root=await fixture(t);let clock=0,count=0;const controller=new AbortController();if(mode==='before')controller.abort();
  const get=createHistoryGetter({monotonic:()=>clock,execute:async()=>{count++;if(mode==='between')controller.abort();if(mode==='expired')clock=35000;throw error(35);}});
  await assert.rejects(get({url,file:path.join(root,'page-001.json'),kind:'forecast',signal:controller.signal,deadline:mode==='infinite'?Infinity:mode==='reserve'?90000:200000}));assert.equal(count,mode==='before'?0:1);
 }
});
test('deadline consumed by receipt work is checked before launch; late success never becomes accepted page',async t=>{
 const root=await fixture(t);let calls=0,ticks=0;const get=createHistoryGetter({monotonic:()=>++ticks<=4?0:40000,execute:async()=>{calls++;return{stdout:'200'};}});
 await assert.rejects(get({url,file:path.join(root,'page-001.json'),kind:'outcome',deadline:100000}));assert.equal(calls,0);
 const second=await fixture(t);let clock=0;const late=createHistoryGetter({monotonic:()=>clock,execute:async(cmd,args)=>{await fs.writeFile(output(args),'LATE');clock=30001;return{stdout:'200'};}});
 await assert.rejects(late({url,file:path.join(second,'page-001.json'),kind:'outcome',deadline:100000}),/DEADLINE/);await assert.rejects(fs.stat(path.join(second,'page-001.json')),/ENOENT/);
});
test('failed attempt receipt cannot be overwritten or bypassed to retry',async t=>{
 const root=await fixture(t);let count=0;const get=createHistoryGetter({execute:async(cmd,args)=>{count++;await fs.mkdir(path.join(path.dirname(output(args)),'result.json'));throw error(35);}});
 await assert.rejects(get({url,file:path.join(root,'page-001.json'),kind:'forecast',deadline:performance.now()+200000}),/EEXIST/);assert.equal(count,1);
});
async function historyFixture(t,mutate,failPage=5,exhausted=false){
 const root=await fixture(t),old=process.env.MFV_DATA_ROOT;process.env.MFV_DATA_ROOT=root;t.after(()=>{if(old===undefined)delete process.env.MFV_DATA_ROOT;else process.env.MFV_DATA_ROOT=old;});
 const anchor=Math.floor(Date.now()/900000)*900;const rows=Array.from({length:1500},(_,i)=>[String((anchor-(i+1)*900)*1000),'100','101','99','100','1','1','100','1']);
 const calls=[],counts=new Map();const historyGet=createHistoryGetter({execute:async(cmd,args)=>{
  const target=output(args),page=Number(target.match(/page-(\d{3})/)[1]);const n=(counts.get(page)??0)+1;counts.set(page,n);calls.push(args.at(-1));
  if(page===failPage&&(n===1||exhausted)){await fs.writeFile(target,'FAILED');throw error(35);}
  const u=new URL(args.at(-1)),after=Number(u.searchParams.get('after')??Infinity);let data=rows.filter(r=>Number(r[0])<after).slice(0,300);if(mutate)data=mutate(data,page,anchor);
  await fs.writeFile(target,JSON.stringify({code:'0',data}));return{stdout:'200'};
 }});
 return{root,anchor,historyGet,calls,counts,options:{anchorTime:anchor,historyGet,deadline:performance.now()+300000}};
}
test('forecast fifth page retry retains first four pages, one accepted page each, complete history and provenance',async t=>{
 const f=await historyFixture(t);const h=await downloadRunHistory('SYNTHETIC',f.options);assert.equal(h.count,1344);assert.equal(h.source.raw_responses.length,5);assert.deepEqual([...f.counts.values()],[1,1,1,1,2]);assert.equal(f.calls[4],f.calls[5]);
 const s=await read(path.join(f.root,'data-source/SYNTHETIC/request-attempts/page-005/attempt-002/result.json'));assert.equal(h.source.raw_responses[4].requested_at,s.requested_at);
});
test('forecast first-page retry across a market anchor fails instead of moving cutoff',async t=>{
 const f=await historyFixture(t,(rows,page,anchor)=>page===1?[[String(anchor*1000),'100','101','99','100','1','1','100','1'],...rows.slice(0,-1)]:rows,1);
 await assert.rejects(downloadRunHistory('SYNTHETIC',f.options),/ANCHOR_MISMATCH/);assert.equal(f.calls.length,2);
});
for(const mode of ['confirm','conflict','cursor','insufficient','bad-json'])test(`forecast original ${mode} gate remains closed without validation retries`,async t=>{
 const f=await historyFixture(t,(rows,page)=>{
  if(mode==='confirm'&&page===1)rows[0][8]='bad';
  if(mode==='conflict'&&page===1)rows.push([...rows[0].slice(0,4),'100.1',...rows[0].slice(5)]);
  if(mode==='cursor'&&page===2)rows=Array.from({length:300},(_,i)=>[String((f.anchor-(i+1)*900)*1000),'100','101','99','100','1','1','100','1']);
  if(mode==='insufficient')rows=rows.slice(0,1);
  return rows;
 },0);
 if(mode==='bad-json')f.options.historyGet=createHistoryGetter({execute:async(cmd,args)=>{f.calls.push(args.at(-1));await fs.writeFile(output(args),'not JSON');return{stdout:'200'};}});
 await assert.rejects(downloadRunHistory('SYNTHETIC',f.options));assert.ok(f.calls.length<=12);assert.ok([...f.counts.values()].every(x=>x===1));
});
test('failed preparation leaves source attempts but no frozen input, model or publication',async t=>{
 const f=await historyFixture(t,null,5,true);const events=path.join(f.root,'events.json');await fs.writeFile(events,JSON.stringify({mode:'market_only',information_cutoff:new Date().toISOString(),sources:[],items:[],limitations:['SYNTHETIC']}));
 await assert.rejects(prepareForecast(events,f.options),/SYNTHETIC/);const ids=await fs.readdir(path.join(f.root,'forecast-runs'));assert.equal(ids.length,1);assert.deepEqual((await fs.readdir(path.join(f.root,'forecast-runs',ids[0]))).sort(),['preparation-failure.json','run.json']);assert.equal(f.calls.length,6);
});

test('successful freeze binds helper source hash and preserves original slot anchor',async t=>{
 const f=await historyFixture(t);const events=path.join(f.root,'events.json');await fs.writeFile(events,JSON.stringify({mode:'market_only',information_cutoff:new Date().toISOString(),sources:[],items:[],limitations:['SYNTHETIC']}));
 const run=await prepareForecast(events,f.options);assert.equal(run.anchor_time,f.anchor);const p=await read(path.join(run.runDir,'provenance.json'));const{createHash}=await import('node:crypto');assert.equal(p.code_sha256['scripts/m1-history-get.mjs'],createHash('sha256').update(await fs.readFile('scripts/m1-history-get.mjs')).digest('hex'));
 assert.ok(!((await fs.readdir(run.runDir)).some(x=>x.startsWith('attempt-')||x==='publication')));
});
test('forecast retry reserves model time after first failure, not merely at page entry',async t=>{
 const root=await fixture(t);let clock=0,count=0;const get=createHistoryGetter({monotonic:()=>clock,execute:async()=>{count++;clock=1001;throw error(35);}});
 await assert.rejects(get({url,file:path.join(root,'page-001.json'),kind:'forecast',deadline:91000}));assert.equal(count,1);
});
