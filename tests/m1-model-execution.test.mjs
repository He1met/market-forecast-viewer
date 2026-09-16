import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import net from'node:net';
import{newRun,freezeInput,prepareAttempt,completeAttempt,publishRun}from'../scripts/m1-archive.mjs';import{generateInstalled,generateCandidate,recordExecutionStart}from'../scripts/m1-model.mjs';import{businessMutex,managedProcess}from'../scripts/m1-mutex.mjs';import{digest}from'../scripts/m1-files.mjs';import{METHOD_VERSION,PROMPT_VERSION,CATEGORY_IDS,rawOutputJsonSchema}from'../src/m1-contracts.ts';
async function setup(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-execution-'));const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const mutex=await businessMutex({dataRoot:root,port,releaseId:'SYNTHETIC'});t.after(async()=>{await mutex.close();await fs.rm(root,{recursive:true,force:true});});const source=path.resolve('scripts/m1-model.mjs');
 async function run(){const r=await newRun(path.join(root,'m1-candidates'));await freezeInput(r.runDir,{anchor_time:Math.floor(Date.now()/900000)*900,anchor_price:100,events:{mode:'market_only',information_cutoff:new Date().toISOString(),sources:[],items:[],event_risk_incorporated:false}},'SYNTHETIC no model request',rawOutputJsonSchema,{code_sha256:{[source]:digest(await fs.readFile(source))}});return r;}
 return{root,mutex,run};}
test('real generation lifecycle separates preflight reservation, budget skip, and spawned failure',async t=>{
 const{root,mutex,run}=await setup(t),bin=path.join(root,'bin');await fs.mkdir(bin);const oldPath=process.env.PATH;
 t.after(()=>{process.env.PATH=oldPath;});process.env.PATH=bin+path.delimiter+'/usr/bin:/bin';
 for(const kind of ['preflight','budget','spawned']){
  await fs.writeFile(path.join(bin,'codex'),`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='--version')console.log('SYNTHETIC');else if(a.includes('--help'))console.log('--ignore-user-config --skip-git-repo-check --ephemeral');else if(a[0]==='login'){console.log(${JSON.stringify(kind==='preflight'?'SYNTHETIC not logged in':'Logged in using ChatGPT')});process.exit(${kind==='preflight'?1:0});}else{process.stdin.resume();process.stdin.on('end',()=>process.exit(2));}\n`,{mode:0o700});
  const r=await run();await assert.rejects(()=>generateInstalled(r,{mutex,timeoutMs:kind==='budget'?100:100000,beforePublish:async()=>assert.fail('must not publish')}),kind==='preflight'?/OFFICIAL_AUTH_REQUIRED/:kind==='budget'?/MODEL_BUDGET_TOO_SHORT/:/MODEL_ATTEMPT_REJECTED/);
  const dir=path.join(r.runDir,'attempt-001');assert.ok(await fs.stat(path.join(dir,'started.json')));
  if(kind!=='spawned')await assert.rejects(()=>fs.stat(path.join(dir,'execution-started.json')),/ENOENT/);
  else{const start=JSON.parse(await fs.readFile(path.join(dir,'execution-started.json')));assert.equal(start.mode,'managed_process');assert.ok(start.process.pid>1);assert.ok(start.process.identity);assert.equal(start.reservation_sha256,digest(await fs.readFile(path.join(dir,'started.json'))));assert.equal(start.run_id,r.run_id);}
 }
});
test('spawned timeout and interruption keep actual-start evidence; spawn failure has none',async t=>{
 const{root,mutex,run}=await setup(t);
 for(const kind of ['timeout','interrupted','spawn_failed']){const r=await run(),attempt=await prepareAttempt(r.runDir);const options={mutex,cwd:root,env:process.env,stdoutFile:path.join(attempt.attemptDir,'stdout'),stderrFile:path.join(attempt.attemptDir,'stderr'),timeoutMs:100,onStarted:async p=>{await recordExecutionStart(r.runDir,attempt,'managed_process',p);if(kind==='interrupted')throw Error('SYNTHETIC_INTERRUPTION');}};
  const execute=()=>managedProcess(kind==='spawn_failed'?path.join(root,'nonexistent'):process.execPath,['-e','setInterval(()=>{},1000)'],options);
  if(kind==='timeout')assert.equal((await execute()).timedOut,true);else await assert.rejects(execute,kind==='interrupted'?/SYNTHETIC_INTERRUPTION/:/ENOENT/);
  if(kind==='spawn_failed')await assert.rejects(()=>fs.stat(path.join(attempt.attemptDir,'execution-started.json')),/ENOENT/);else assert.equal(JSON.parse(await fs.readFile(path.join(attempt.attemptDir,'execution-started.json'))).mode,'managed_process');
 }
});

test('installed generation preserves the version-bound startup notice audit in its receipt',async t=>{
 const{root,mutex,run}=await setup(t),r=await run(),bin=path.join(root,'bin');await fs.mkdir(bin);
 const input=JSON.parse(await fs.readFile(path.join(r.runDir,'input.json'))),notice='Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
 const raw={schema_version:'m1.0',method_version:METHOD_VERSION,prompt_version:PROMPT_VERSION,anchor_time:input.anchor_time,anchor_price:100,
 scenarios:CATEGORY_IDS.map((id,i)=>({id,probability_24h:i===0?.5:.1,prices:Array.from({length:96},(_,n)=>n===0?[101,99,100.5,99.5,100,100.6][i]:[100,100,100.5,99.5,100,100][i]),support:['SYNTHETIC'],counterevidence:['SYNTHETIC'],invalidations:['SYNTHETIC']})),
 stages:[[1,24],[25,48],[49,96]].map(([start_step,end_step])=>({start_step,end_step,lower:98,upper:102,explanation:'SYNTHETIC'})),summary:'SYNTHETIC',limitations:['SYNTHETIC']};
 const frames=[{type:'thread.started',thread_id:'SYNTHETIC'},{type:'item.completed',item:{type:'error',message:notice}},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'SYNTHETIC'}},{type:'turn.completed'}];
 const fake=`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a[0]==='--version')console.log('codex-cli 0.154.0-alpha.6.2');else if(a.includes('--help'))console.log('--ignore-user-config --skip-git-repo-check --ephemeral');else if(a[0]==='login')console.log('Logged in using ChatGPT');else{process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(a[a.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify(raw))});for(const row of ${JSON.stringify(frames)})console.log(JSON.stringify(row));});}\n`;
 await fs.writeFile(path.join(bin,'codex'),fake,{mode:0o700});const old=process.env.PATH;process.env.PATH=bin+path.delimiter+'/usr/bin:/bin';t.after(()=>{process.env.PATH=old;});
 const published=await generateInstalled(r,{mutex,timeoutMs:100000,beforePublish:async()=>{}});assert.equal(published.forecast.run_id,r.run_id);
 const base=path.join(r.runDir,'attempt-001'),receipt=JSON.parse(await fs.readFile(path.join(base,'receipt.json')));
 assert.equal(receipt.exit_code,0);assert.equal(receipt.turn_completed,true);assert.equal(receipt.unexpected_tool_events,0);
 assert.equal(receipt.event_audit.events_sha256,digest(await fs.readFile(path.join(base,'events.jsonl'))));
 assert.equal(receipt.event_audit.invocation_sha256,digest(await fs.readFile(path.join(base,'invocation.json'))));
 assert.equal(receipt.event_audit.startup_notice_count,1);assert.equal(receipt.event_audit.startup_notices[0].message,notice);
 assert.equal(receipt.event_audit.cli_version,'codex-cli 0.154.0-alpha.6.2');assert.equal(receipt.event_audit.controlled_disabled_context,true);
 assert.equal(receipt.model_config.startup_warning_count,1);assert.equal(receipt.event_audit.unexpected_tool_count,0);
});

test('malformed JSON event shapes reject without losing the installed attempt receipt',async t=>{
 const{root,mutex,run}=await setup(t),bin=path.join(root,'bin');await fs.mkdir(bin);const old=process.env.PATH;process.env.PATH=bin+path.delimiter+'/usr/bin:/bin';t.after(()=>{process.env.PATH=old;});
 for(const invalid of [null,1,true,{type:123},{type:{}},{type:true}]) {
  const frames=[invalid,{type:'thread.started'},{type:'turn.started'},{type:'turn.completed'}];
  await fs.writeFile(path.join(bin,'codex'),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a[0]==='--version')console.log('codex-cli 0.154.0-alpha.6.2');else if(a.includes('--help'))console.log('--ignore-user-config --skip-git-repo-check --ephemeral');else if(a[0]==='login')console.log('Logged in using ChatGPT');else{process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(a[a.indexOf('--output-last-message')+1],'{}');for(const row of ${JSON.stringify(frames)})console.log(JSON.stringify(row));});}\n`,{mode:0o700});
  const r=await run();await assert.rejects(()=>generateInstalled(r,{mutex,timeoutMs:100000,beforePublish:async()=>assert.fail('must not publish')}),/MODEL_ATTEMPT_REJECTED/);
  const receipt=JSON.parse(await fs.readFile(path.join(r.runDir,'attempt-001/receipt.json')));
  assert.equal(receipt.exit_code,-1);assert.equal(receipt.cli_exit_code,0);assert.ok(receipt.event_audit.unexpected_event_count>0);assert.equal(receipt.event_audit.startup_notice_count,0);
  await assert.rejects(()=>fs.access(path.join(r.runDir,'publication')),/ENOENT/);
 }
});

test('deterministic probability candidate records execution without spawning a model',async t=>{
 const{mutex,run}=await setup(t),source=await run(),candidate=await run(),attempt=await prepareAttempt(source.runDir);
 const input=JSON.parse(await fs.readFile(path.join(source.runDir,'input.json')));
 const raw={schema_version:'m1.0',method_version:METHOD_VERSION,prompt_version:PROMPT_VERSION,anchor_time:input.anchor_time,anchor_price:100,
 scenarios:CATEGORY_IDS.map((id,i)=>({id,probability_24h:i===0?.5:.1,prices:Array.from({length:96},(_,n)=>n===0?[101,99,100.5,99.5,100,100.6][i]:[100,100,100.5,99.5,100,100][i]),support:['SYNTHETIC'],counterevidence:['SYNTHETIC'],invalidations:['SYNTHETIC']})),
 stages:[[1,24],[25,48],[49,96]].map(([start_step,end_step])=>({start_step,end_step,lower:98,upper:102,explanation:'SYNTHETIC'})),summary:'SYNTHETIC',limitations:['SYNTHETIC']};
 await fs.writeFile(attempt.rawFile,JSON.stringify(raw));await completeAttempt(source.runDir,attempt.attempt_id,{exit_code:0,model_config:{synthetic:true}});await publishRun(source.runDir,attempt.rawFile,{attempt_id:attempt.attempt_id});
 const result=await generateCandidate({...candidate,probabilityOnly:true,sourceRun:source},{mutex,beforePublish:async()=>{}});assert.equal(result.forecast.run_id,candidate.run_id);
 const start=JSON.parse(await fs.readFile(path.join(candidate.runDir,'attempt-001/execution-started.json')));assert.equal(start.mode,'deterministic_probability_postprocess');assert.equal(start.process,null);assert.equal(start.run_id,candidate.run_id);
});
