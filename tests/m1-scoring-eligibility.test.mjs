import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {requireEvidence} from '../scripts/evidence-context.mjs';
import {newRun,freezeInput,prepareAttempt,completeAttempt,publishRun} from '../scripts/m1-archive.mjs';
import {createDisplayReader} from '../scripts/m1-display.mjs';
import {ops,scoreOldForecasts,scanOpsBatch} from '../scripts/m1-ops.mjs';
import {auditCodexEvents} from '../scripts/m1-forecast.mjs';
import {modelArguments} from '../scripts/m1-model.mjs';
import {alertStore} from '../scripts/m1-alerts.mjs';

const context=requireEvidence(),codeRoot=context.workspace,hash=x=>createHash('sha256').update(x).digest('hex'),guard=async()=>{};
const template=path.join(codeRoot,'artifacts/forecast-runs/m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011');
const read=async p=>JSON.parse(await fs.readFile(p)),write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));};
async function inventory(root){const result={};async function walk(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isDirectory())await walk(p);else result[path.relative(root,p)]=hash(await fs.readFile(p));}}await walk(root);return result;}
async function fixture(t){
 const dataRoot=await fs.mkdtemp(path.join(codeRoot,'artifacts/SYNTHETIC-eligibility-'));
 const previous=process.env.MFV_DATA_ROOT;process.env.MFV_DATA_ROOT=dataRoot;
 t.after(async()=>{if(previous===undefined)delete process.env.MFV_DATA_ROOT;else process.env.MFV_DATA_ROOT=previous;await fs.rm(dataRoot,{recursive:true,force:true});});
 await fs.cp(path.join(codeRoot,'artifacts/data-source/SYNTHETIC'),path.join(dataRoot,'data-source/SYNTHETIC'),{recursive:true});
 const input=await read(path.join(template,'input.json')),schema=await read(path.join(template,'output-schema.json')),raw=await fs.readFile(path.join(template,'attempt-001/raw-output.json'));
 const source=path.join(codeRoot,'src/m1-contracts.ts');
 const provenance={code_sha256:{[source]:hash(await fs.readFile(source)),'scripts/m1-forecast.mjs':hash(await fs.readFile(path.join(codeRoot,'scripts/m1-forecast.mjs')))}};
 async function add({role='production',count=2,success=false,publish=false,open=false,audit=true,legacy=false}={}){
  const runsRoot=path.join(dataRoot,role==='production'?'forecast-runs':'m1-candidates');
  const run=await newRun(runsRoot);await freezeInput(run.runDir,input,'SYNTHETIC ELIGIBILITY ONLY',schema,provenance);
  for(let i=0;i<count;i++){
   const a=await prepareAttempt(run.runDir);if(open&&i===count-1)break;
   await fs.writeFile(a.rawFile,raw);
   const thread='SYNTHETIC-THREAD-'+a.attempt_id,workspace=path.join(a.attemptDir,'model-work'),cli_version='codex-cli 0.154.0-alpha.6.2';
   const invocation={schema:'MFV:MODEL_INVOCATION:v1',args:modelArguments({workspace,schema:path.join(run.runDir,'output-schema.json'),output:a.rawFile}),working_directory:workspace,cli_version,requested_model:'gpt-6-astra',requested_reasoning:'medium',provider:'official_codex',frozen_input_sha256:hash(await fs.readFile(path.join(run.runDir,'input.json')))};
   const notice='Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
   const events=[{type:'thread.started',thread_id:thread},...(!success?[{type:'item.completed',item:legacy?{id:'item_0',type:'error',message:notice}:{id:'item_0',type:'command_execution',command:'SYNTHETIC forbidden tool'}}]:[]),{type:'turn.started'},{type:'item.completed',item:{id:'item_1',type:'agent_message',text:raw.toString()}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}];
   const stream=events.map(e=>JSON.stringify(e)).join('\n')+'\n',invocationBytes=JSON.stringify(invocation);await fs.writeFile(path.join(a.attemptDir,'events.jsonl'),stream);await fs.writeFile(path.join(a.attemptDir,'invocation.json'),invocationBytes);
   const parsed=auditCodexEvents(stream,legacy?undefined:{kind:'installed_frozen_input',cli_version,args:invocation.args});
   const event_audit={schema:'MFV:CODEX_EVENT_AUDIT:v1',events_sha256:hash(stream),invocation_sha256:hash(invocationBytes),cli_version,controlled_disabled_context:parsed.controlled_disabled_context,startup_notice_count:parsed.startup_notice_count,startup_notices:parsed.startup_notices,unexpected_event_count:parsed.unexpected_count,unexpected_tool_count:parsed.unexpected_tool_count,turn_completed:parsed.turn_completed,failed:parsed.failed};
   const info={exit_code:success?0:-1,error:success?null:'MODEL_ATTEMPT_REJECTED',cli_exit_code:0,...(audit&&!legacy?{event_audit}:{}),unexpected_tool_events:parsed.unexpected_count,turn_completed:legacy?null:parsed.turn_completed,model_thread_id:thread,model_identity_visibility:'not_exposed_by_jsonl',model_config:{provider:'official_codex',selection:'existing_local_cli_configuration',cli_version,auth_method:'chatgpt_verified',sandbox:'read-only',output_schema:true,startup_warning_count:parsed.startup_warning_count}};
   await completeAttempt(run.runDir,a.attempt_id,info);
   if(publish)await publishRun(run.runDir,a.rawFile,{attempt_id:a.attempt_id});
  }
  if(legacy){
   // Synthetic migration fixture: reproduce the old frozen parser identity and
   // rebind its frozen/attempt hashes; never alter a real archive.
   const file=path.join(run.runDir,'provenance.json'),v=await read(file);v.code_sha256['scripts/m1-forecast.mjs']='9016c56108a71f3daacbaef25db705ab306a06ac4600889712ab892a680d7a4d';await write(file,v);
   const mfile=path.join(run.runDir,'manifest.json'),m=await read(mfile);m.files['provenance.json']=hash(await fs.readFile(file));await write(mfile,m);
   for(const attempt of ['attempt-001','attempt-002']){const startFile=path.join(run.runDir,attempt,'started.json'),start=await read(startFile);start.frozen_manifest_sha256=hash(await fs.readFile(mfile));await write(startFile,start);const receiptFile=path.join(run.runDir,attempt,'receipt.json'),receipt=await read(receiptFile);receipt.started_sha256=hash(await fs.readFile(startFile));await write(receiptFile,receipt);}
  }
  return{...run,reader:createDisplayReader({root:codeRoot,dataRoot,runsRoot})};
 }
 return{dataRoot,add};
}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}

test('SYNTHETIC ops production/candidate and forecast fallback retire only scoring failures, without capture or archive changes',async t=>{
 const f=await fixture(t),p=await f.add({legacy:true}),candidate=await f.add({role:'candidate',audit:true});
 const beforeP=await inventory(p.runDir),beforeC=await inventory(candidate.runDir);
 for(const [scope,role,id]of [['ops','production',p.run_id],['ops','candidate',candidate.run_id],['forecast-fallback','production',p.run_id]])await write(path.join(f.dataRoot,`m1-control/${scope}-${role}-cursor.json`),{offset:0,unresolved:[{run_id:id,reason:'PUBLICATION_MISSING'}]});
 const execution=alertStore(f.dataRoot,{stream:'execution'});await execution.observe({task:'forecast',observationId:'SYNTHETIC_FAILURE',at:new Date().toISOString(),confirmed:true,condition:{code:'FORECAST_FAILURE',object:'forecast',severity:'warning'},guard});const alerts=await fs.readFile(path.join(f.dataRoot,'m1-control/execution-alerts.json'));
 let captures=0;const outcomeTransport=async()=>{captures++;throw Error('CAPTURE_MUST_NOT_RUN');};
 const fallback=await scoreOldForecasts({codeRoot,dataRoot:f.dataRoot,mutex:{guard},signal:AbortSignal.timeout(10000),deadline:performance.now()+10000,outcomeTransport});
 assert.equal(fallback.status,'completed');assert.deepEqual(fallback.unresolved,[]);assert.equal(fallback.outcomes[0].reason,'terminal_failed_not_scoreable');
 // Fallback cannot clear ops' separate unresolved ledger.
 assert.equal((await read(path.join(f.dataRoot,'m1-control/ops-production-cursor.json'))).unresolved.length,1);
 const result=await ops({codeRoot,dataRoot:f.dataRoot,port:await freePort(),releaseId:'SYNTHETIC',outcomeTransport,capacityStatfs:async()=>({blocks:100000000n,bfree:90000000n,bavail:90000000n,bsize:4096n})});
 assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.outcomes.length,2);assert.ok(result.outcomes.every(x=>x.reason==='terminal_failed_not_scoreable'));assert.deepEqual(result.unresolved,[]);assert.equal(captures,0);
 await assert.rejects(fs.access(path.join(f.dataRoot,'m1-outcomes')),/ENOENT/);
 assert.deepEqual(await inventory(p.runDir),beforeP);assert.deepEqual(await inventory(candidate.runDir),beforeC);assert.deepEqual(await fs.readFile(path.join(f.dataRoot,'m1-control/execution-alerts.json')),alerts);
 assert.equal((await p.reader.runState(p.run_id,new Date().toISOString())).status,'failed');
 const index=await read(path.join(f.dataRoot,'m1-projections/index.json'));assert.equal(index.runs.find(x=>x.run_id===p.run_id).status,'failed');
});

test('SYNTHETIC successful publication remains strict when publication or any key file is deleted',async t=>{
 const f=await fixture(t);
 for(const part of ['', 'manifest.json','forecast.json','receipt.json']){
  const r=await f.add({count:1,success:true,publish:true});assert.equal((await r.reader.readScoringRun(r.run_id)).status,'readable');
  await fs.rm(path.join(r.runDir,'publication',part),{recursive:true});await assert.rejects(r.reader.readScoringRun(r.run_id));
 }
});

test('SYNTHETIC interrupted, one failed, successful unpublished and preparation failures stay unresolved',async t=>{
 const f=await fixture(t);
 for(const options of [{count:1},{count:2,audit:false},{count:2,open:true},{count:1,success:true},{count:2,success:true}]){
  const r=await f.add(options);await assert.rejects(r.reader.readScoringRun(r.run_id));
 }
 const forged=await f.add({count:2,success:true});
 for(const attempt of ['attempt-001','attempt-002']){const file=path.join(forged.runDir,attempt,'receipt.json'),v=await read(file);v.exit_code=-1;v.error='MODEL_ATTEMPT_REJECTED';await write(file,v);}
 await assert.rejects(forged.reader.readScoringRun(forged.run_id),/SCORING_FAILURE_UNPROVEN/);
 for(const mutation of ['failed','unexpected_event_count']){
  for(const attempt of ['attempt-001','attempt-002']){const file=path.join(forged.runDir,attempt,'receipt.json'),v=await read(file);v.event_audit[mutation]=mutation==='failed'?true:1;await write(file,v);}
  await assert.rejects(forged.reader.readScoringRun(forged.run_id),/SCORING_AUDIT_MISMATCH/);
 }
 const r=await f.add();await write(path.join(r.runDir,'preparation-failure.json'),{status:'failed',at:new Date().toISOString()});await assert.rejects(r.reader.readScoringRun(r.run_id),/PREPARATION_FAILURE_INVALID/);
 const published=await f.add({count:1,success:true,publish:true});await write(path.join(published.runDir,'preparation-failure.json'),{status:'failed',at:new Date().toISOString()});await assert.rejects(published.reader.readScoringRun(published.run_id),/PREPARATION_FAILURE_INVALID/);
});

test('SYNTHETIC corruption, forged receipt identity, audit tampering and symlink paths cannot become ineligible',async t=>{
 const f=await fixture(t);
 const mutations=[
  async r=>fs.appendFile(path.join(r.runDir,'input.json'),' '),
  async r=>{const p=path.join(r.runDir,'attempt-001/receipt.json'),v=await read(p);v.run_id='SYNTHETIC_FORGED';await write(p,v);},
  async r=>{const p=path.join(r.runDir,'attempt-001/receipt.json'),v=await read(p);v.started_sha256='a'.repeat(64);await write(p,v);},
  async r=>fs.appendFile(path.join(r.runDir,'attempt-001/raw-output.json'),' '),
  async r=>fs.appendFile(path.join(r.runDir,'attempt-001/events.jsonl'),'SYNTHETIC_TAMPER'),
  async r=>{const p=path.join(r.runDir,'attempt-001/receipt.json'),v=await read(p);v.event_audit.unexpected_event_count=0;await write(p,v);},
  async r=>{const p=path.join(r.runDir,'attempt-002');await fs.rename(p,p+'-outside');await fs.symlink(p+'-outside',p);},
  async r=>fs.symlink(path.join(f.dataRoot,'nonexistent'),path.join(r.runDir,'publication')),
  async r=>fs.mkdir(path.join(r.runDir,'.publication-SYNTHETIC.tmp')),
 ];
 for(const mutate of mutations){const r=await f.add({audit:true});await mutate(r);await assert.rejects(r.reader.readScoringRun(r.run_id));}
});

test('SYNTHETIC publication traces contradict failed attempts; missing entire run stays archive_missing',async t=>{
 const f=await fixture(t),r=await f.add();
 await fs.mkdir(path.join(f.dataRoot,'m1-outcomes',r.run_id),{recursive:true});await assert.rejects(r.reader.readScoringRun(r.run_id),/SCORING_PUBLICATION_EVIDENCE/);await fs.rm(path.join(f.dataRoot,'m1-outcomes'),{recursive:true});
 await write(path.join(f.dataRoot,'m1-task-status/last-forecast-success.json'),{forecast_id:r.run_id});await assert.rejects(r.reader.readScoringRun(r.run_id),/SCORING_PUBLICATION_EVIDENCE/);await fs.rm(path.join(f.dataRoot,'m1-task-status'),{recursive:true});
 await write(path.join(f.dataRoot,'m1-projections/index.json'),{schema:'MFV:PROJECTIONS:v1',runs:[{run_id:r.run_id,status:'valid',published_at:new Date().toISOString()}]});await assert.rejects(r.reader.readScoringRun(r.run_id),/SCORING_PUBLICATION_EVIDENCE/);
 await write(path.join(f.dataRoot,'m1-control/ops-production-cursor.json'),{offset:0,unresolved:[{run_id:r.run_id,reason:'PUBLICATION_MISSING'}]});await fs.rm(r.runDir,{recursive:true});
 const batch=await scanOpsBatch({dataRoot:f.dataRoot,role:'production',ids:[],guard,visit:()=>{throw Error('UNREACHABLE');}});assert.equal(batch.unresolved[0].reason,'archive_missing');
});


test('SYNTHETIC legacy rejection requires its exact parser, notice, invocation and old receipt semantics',async t=>{
 const f=await fixture(t);
 for(const role of ['production','candidate']){const r=await f.add({role,legacy:true});assert.equal((await r.reader.readScoringRun(r.run_id)).status,'terminal_failed_not_scoreable');}
 for(const mutate of [
  async r=>{const file=path.join(r.runDir,'attempt-001/events.jsonl'),lines=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);lines.splice(1,1);await fs.writeFile(file,lines.map(x=>JSON.stringify(x)).join('\n'));},
  async r=>{const file=path.join(r.runDir,'attempt-001/receipt.json'),v=await read(file);v.unexpected_tool_events=0;await write(file,v);},
  async r=>{const file=path.join(r.runDir,'attempt-001/invocation.json'),v=await read(file);v.frozen_input_sha256='a'.repeat(64);await write(file,v);},
  async r=>{const file=path.join(r.runDir,'attempt-001/invocation.json'),v=await read(file);v.args.push('--enable','code_mode');await write(file,v);},
 ]){const r=await f.add({legacy:true});await mutate(r);await assert.rejects(r.reader.readScoringRun(r.run_id));}
});
