// All bytes produced here are SYNTHETIC test data, never market or model evidence.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash}from'node:crypto';
import {requireEvidence}from'../../scripts/evidence-context.mjs';
import {seal}from'../../src/contracts.ts';import{generateDemo}from'../../scripts/demo-core.mjs';
import{newRun,freezeInput,prepareAttempt,completeAttempt,publishRun}from'../../scripts/m1-archive.mjs';
import{rawOutputJsonSchema,CATEGORY_IDS,METHOD_VERSION,PROMPT_VERSION}from'../../src/m1-contracts.ts';
requireEvidence();const hash=x=>createHash('sha256').update(x).digest('hex'),write=async(p,x)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx'});};
const anchor=Date.parse('2026-09-12T18:30:00Z')/1000,start=anchor-14*86400;
const candles=Array.from({length:1344},(_,i)=>{const price=100+Math.sin(i/20)*.2;return{open_time:start+i*900,close_time:start+(i+1)*900,open:price,high:price+.1,low:price-.1,close:price,volume_contracts:10,volume_base:1,volume_quote:100,closed:true};});
const rows=candles.toReversed().map(c=>[String(c.open_time*1000),...[c.open,c.high,c.low,c.close,c.volume_contracts,c.volume_base,c.volume_quote].map(String),'1']);let sources=[],after;
for(let i=0;i<rows.length;i+=300){const p=`artifacts/data-source/SYNTHETIC/page-${String(i/300+1).padStart(3,'0')}.json`,data=rows.slice(i,i+300);await write(p,{code:'0',msg:'SYNTHETIC FIXTURE',data});sources.push({path:p,sha256:hash(await fs.readFile(p)),requested_at:'2026-09-12T18:36:00.000Z',params:{instId:'BTC-USDT-SWAP',bar:'15m',limit:300,...(after?{after}:{})},response_code:'0'});after=data.at(-1)[0];}
const h=await seal({schema_version:'1.0.0',kind:'history',source:{provider:'OKX',endpoint:'https://www.okx.com/api/v5/market/history-candles',documentation_url:'https://www.okx.com/docs-v5/en/',request:{instId:'BTC-USDT-SWAP',bar:'15m',limit:300,requested_start_time:start,requested_end_time:anchor},raw_responses:sources},instrument:'BTC-USDT-SWAP',market_type:'linear_perpetual',price_type:'trade',base_currency:'BTC',quote_currency:'USDT',settle_currency:'USDT',time_unit:'s',timezone:'UTC',bar_seconds:900,downloaded_at:'2026-09-12T18:36:00.000Z',start_time:start,end_time:anchor,count:1344,quality:{excluded_unclosed_count:0,identical_duplicates_removed:0,gaps:[],conflicting_duplicates:[]},candles});
const demo=await generateDemo(h);await write('public/data/history.json',h);await write('public/data/forecast.demo.json',demo.forecast);await write('public/data/grids.demo.json',demo.grids);
// The archive fixture uses a deterministic test clock only in this isolated process.
const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-09-12T18:39:00.000Z']));}static now(){return RealDate.parse('2026-09-12T18:39:00.000Z');}};
const run=await newRun(),fixed='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011',dir=path.join(path.dirname(run.runDir),fixed);await fs.rename(run.runDir,dir);await fs.writeFile(path.join(dir,'run.json'),JSON.stringify({schema:'MFV:M1_RUN:v1',run_id:fixed,created_at:'2026-09-12T18:36:44.170Z',local_only:true}));
const price=h.candles.at(-1).close;const input={schema_version:'m1-input.0',history:h,anchor_time:anchor,anchor_price:price,features:{synthetic:true},events:{mode:'market_only',information_cutoff:'2026-09-12T18:36:00.000Z',sources:[],event_risk_incorporated:false},model_context:{synthetic:true}};
const code=Object.fromEntries(await Promise.all(['src/m1-contracts.ts','src/contracts.ts','src/m1-evaluation.ts'].map(async p=>[p,hash(await fs.readFile(p))])));
await freezeInput(dir,input,'SYNTHETIC ONLY — not a model invocation',rawOutputJsonSchema,{code_sha256:code,method_version:METHOD_VERSION,prompt_version:PROMPT_VERSION});const a=await prepareAttempt(dir);
const multipliers=[1,1,1.006,.994,1,1];const starts=[1.011,.989,1.006,.994,1,1.006];
const raw={schema_version:'m1.0',method_version:METHOD_VERSION,prompt_version:PROMPT_VERSION,anchor_time:anchor,anchor_price:price,scenarios:CATEGORY_IDS.map((id,i)=>({id,probability_24h:i===0?.5:.1,prices:Array.from({length:96},(_,k)=>price*(k===0?starts[i]:multipliers[i])),support:['SYNTHETIC'],counterevidence:['SYNTHETIC'],invalidations:['SYNTHETIC']})),stages:[[1,24],[25,48],[49,96]].map(([start_step,end_step])=>({start_step,end_step,lower:price*.98,upper:price*1.02,explanation:'SYNTHETIC'})),summary:'SYNTHETIC portable browser fixture',limitations:['SYNTHETIC: no market evidence']};
await write(a.rawFile,raw);await completeAttempt(dir,a.attempt_id,{exit_code:0,model_config:{provider:'official_codex',selection:'existing_local_cli_configuration',cli_version:'codex-cli 0.0.0',auth_method:'chatgpt_verified',sandbox:'read-only',output_schema:true,startup_warning_count:0},model_identity:null,model_identity_visibility:'not_exposed_by_jsonl'});await publishRun(dir,a.rawFile,a);
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-09-12T18:35:00.000Z']));}static now(){return RealDate.parse('2026-09-12T18:35:00.000Z');}};const failed=await newRun();await write(path.join(failed.runDir,'preparation-failure.json'),{at:new Date().toISOString(),status:'failed',error:'SYNTHETIC failure',visibility:'LOCAL_ONLY'});globalThis.Date=RealDate;
console.log(JSON.stringify({status:'SYNTHETIC_READY',run_id:fixed,candles:1344}));

const {createDisplayReader}=await import('../../scripts/m1-display.mjs');
const {createOutcomeStore}=await import('../../scripts/m1-outcome-store.mjs');
const display=await createDisplayReader().readRun(fixed,{includeEvaluation:false});
const store=createOutcomeStore();
const futureRows=Array.from({length:24},(_,i)=>[String((anchor+i*900)*1000),...Array(4).fill(String(price)),'10','1','100','1']).reverse();
const capture=await store.capture(display,{transport:async({file})=>{await write(file,{code:'0',msg:'SYNTHETIC',data:futureRows});return '200';}});
if(capture.status!=='ok')throw Error('SYNTHETIC_CAPTURE_FAILED');
await store.evaluateCapture(display,capture.capture_id);
