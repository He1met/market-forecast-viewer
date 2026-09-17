import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {requireEvidence} from '../scripts/evidence-context.mjs';
import {digest,canonical} from '../scripts/m1-files.mjs';
import {newRun,freezeInput,prepareAttempt,completeAttempt} from '../scripts/m1-archive.mjs';
import {closureInventory,closureImplementationFiles,legacyParser,listClosureIds} from '../scripts/m1-closures.mjs';
import {createDisplayReader} from '../scripts/m1-display.mjs';
import {scoreOldForecasts,ops} from '../scripts/m1-ops.mjs';
import {backup,restore} from '../scripts/m1-backup.mjs';
import {replayRestored} from '../scripts/m1-restore-replay.mjs';
import {archiveSnapshot} from '../scripts/m1-compatibility.mjs';
import {alertStore} from '../scripts/m1-alerts.mjs';
const codeRoot=requireEvidence().workspace,read=async p=>JSON.parse(await fs.readFile(p)),write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));},guard=async()=>{};
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(t){
 const base=await fs.mkdtemp(path.join(codeRoot,'artifacts/SYNTHETIC-closure-')),dataRoot=path.join(base,'data');await fs.mkdir(dataRoot);
 const prior=process.env.MFV_DATA_ROOT;process.env.MFV_DATA_ROOT=dataRoot;t.after(async()=>{if(prior===undefined)delete process.env.MFV_DATA_ROOT;else process.env.MFV_DATA_ROOT=prior;await fs.rm(base,{recursive:true,force:true});});
 await fs.cp(path.join(codeRoot,'artifacts/data-source/SYNTHETIC'),path.join(dataRoot,'data-source/SYNTHETIC'),{recursive:true});
 const template=path.join(codeRoot,'artifacts/forecast-runs/m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011');
 const input=await read(path.join(template,'input.json')),schema=await read(path.join(template,'output-schema.json')),raw=await fs.readFile(path.join(template,'attempt-001/raw-output.json'));
 const source=path.join(codeRoot,'src/m1-contracts.ts'),run=await newRun(path.join(dataRoot,'forecast-runs'));
 await freezeInput(run.runDir,input,'SYNTHETIC LEGACY CLOSURE',schema,{code_sha256:{[source]:digest(await fs.readFile(source))}});
 const a=await prepareAttempt(run.runDir);await fs.writeFile(a.rawFile,raw);const stream=[{type:'thread.started',thread_id:'SYNTHETIC-CLOSURE-THREAD'},{type:'item.completed',item:{id:'item0',type:'error',message:'Under-development features enabled: chronicle. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in /SYNTHETIC/config.toml.'}},{type:'turn.started'},{type:'item.completed',item:{id:'item1',type:'agent_message',text:raw.toString()}},{type:'turn.completed'}].map(x=>JSON.stringify(x)).join('\n')+'\n';
 await fs.writeFile(path.join(a.attemptDir,'events.jsonl'),stream);await fs.writeFile(path.join(a.attemptDir,'stderr.log'),'');
 await completeAttempt(run.runDir,a.attempt_id,{exit_code:-1,error:'CODEX_EVENT_REJECTED',cli_exit_code:0,turn_completed:true,unexpected_tool_events:1,model_thread_id:'SYNTHETIC-CLOSURE-THREAD',execution_mode:'official_codex_exec_frozen_stdin',model_identity:null,model_config:{cli_version:'codex-cli 0.154.0-alpha.6.2'}});
 // Synthetic-only migration to the exact old parser; rebind every frozen hash.
 const provenance=await read(path.join(run.runDir,'provenance.json'));provenance.code_sha256['scripts/m1-forecast.mjs']=legacyParser;await write(path.join(run.runDir,'provenance.json'),provenance);
 const manifest=await read(path.join(run.runDir,'manifest.json'));manifest.files['provenance.json']=digest(await fs.readFile(path.join(run.runDir,'provenance.json')));await write(path.join(run.runDir,'manifest.json'),manifest);
 const start=await read(path.join(a.attemptDir,'started.json'));start.frozen_manifest_sha256=digest(await fs.readFile(path.join(run.runDir,'manifest.json')));await write(path.join(a.attemptDir,'started.json'),start);
 const receipt=await read(path.join(a.attemptDir,'receipt.json'));receipt.started_sha256=digest(await fs.readFile(path.join(a.attemptDir,'started.json')));await write(path.join(a.attemptDir,'receipt.json'),receipt);
 const folder=path.join(dataRoot,'m1-closures',run.run_id),now=new Date().toISOString(),user={id:65616876,login:'He1met'};
 const history={id:11,html_url:'https://github.com/He1met/market-forecast-viewer/pull/7#issuecomment-11',user,body:'SYNTHETIC historical abandoned run '+run.run_id,created_at:now,updated_at:now},planning={id:12,number:23,html_url:'https://github.com/He1met/market-forecast-viewer/issues/23',user,body:'SYNTHETIC current planning closure',created_at:now,updated_at:now};
 await write(path.join(folder,'historical-report.json'),history);await write(path.join(folder,'planning-issue.json'),planning);
 const ref=async(name,obj)=>({url:obj.html_url,snapshot_sha256:digest(await fs.readFile(path.join(folder,name))),body_sha256:digest(obj.body)});
 const statement={schema:'MFV:LEGACY_CLOSURE:v1',run_id:run.run_id,role:'production',proposed_at:now,manifest_sha256:digest(await fs.readFile(path.join(run.runDir,'manifest.json'))),parser_sha256:legacyParser,original_inventory:await closureInventory(run.runDir),historical_report:await ref('historical-report.json',history),planning_issue:await ref('planning-issue.json',planning)};await write(path.join(folder,'statement.json'),statement);
 async function approve(){const implementation_files={};for(const f of closureImplementationFiles)implementation_files[f]=digest(await fs.readFile(path.join(codeRoot,f)));const decision={schema:'MFV:CLOSURE_REVIEW:v1',decision:'historical_unpublished_closure_approved',statement_sha256:digest(await fs.readFile(path.join(folder,'statement.json'))),reviewed_commit:'a'.repeat(40),implementation_files};await write(path.join(folder,'review.json'),{id:13,user,state:'COMMENTED',commit_id:'a'.repeat(40),submitted_at:new Date().toISOString(),html_url:'https://github.com/He1met/market-forecast-viewer/pull/24#pullrequestreview-13',body:'SYNTHETIC REVIEW ONLY\n```mfv-closure-review\n'+JSON.stringify(decision)+'\n```'});}
 await approve();const reader=createDisplayReader({root:codeRoot,dataRoot});return{base,dataRoot,...run,folder,reader,approve};
}

test('SYNTHETIC reviewed legacy closure clears only scoring via fallback and ops; no capture, immutable failure, idempotent',async t=>{
 const f=await fixture(t),before=await closureInventory(f.runDir),execution=alertStore(f.dataRoot,{stream:'execution'});
 await execution.observe({task:'forecast',observationId:'SYNTHETIC',at:new Date().toISOString(),confirmed:true,condition:{code:'FORECAST_FAILURE',object:'forecast',severity:'warning'},guard});const alerts=await fs.readFile(path.join(f.dataRoot,'m1-control/execution-alerts.json'));
 for(const scope of ['ops','forecast-fallback'])await write(path.join(f.dataRoot,`m1-control/${scope}-production-cursor.json`),{offset:0,unresolved:[{run_id:f.run_id,reason:'SCORING_FAILURE_UNPROVEN'}]});
 let calls=0;const transport=async()=>{calls++;throw Error('NO_CAPTURE');};
 for(let i=0;i<2;i++){const x=await scoreOldForecasts({codeRoot,dataRoot:f.dataRoot,mutex:{guard},signal:AbortSignal.timeout(10000),deadline:performance.now()+10000,outcomeTransport:transport});assert.equal(x.status,'completed');assert.equal(x.outcomes[0].reason,'historical_unpublished_closed_not_scoreable');}
 assert.equal((await read(path.join(f.dataRoot,'m1-control/ops-production-cursor.json'))).unresolved.length,1);
 const x=await ops({codeRoot,dataRoot:f.dataRoot,port:await freePort(),releaseId:'SYNTHETIC',outcomeTransport:transport,capacityStatfs:async()=>({blocks:100000000n,bfree:90000000n,bavail:90000000n,bsize:4096n})});assert.equal(x.status,'completed',JSON.stringify(x));assert.equal(x.outcomes[0].reason,'historical_unpublished_closed_not_scoreable');assert.equal(calls,0);
 assert.equal((await f.reader.runState(f.run_id,new Date().toISOString())).status,'failed');assert.deepEqual(await closureInventory(f.runDir),before);assert.deepEqual(await fs.readFile(path.join(f.dataRoot,'m1-control/execution-alerts.json')),alerts);
});

test('SYNTHETIC damaged, missing, added bytes/empty dirs, open attempts, source/review identity and duplicate keys fail closed',async t=>{
 const mutations=[
  f=>fs.appendFile(path.join(f.runDir,'attempt-001/raw-output.json'),' '),
  f=>fs.unlink(path.join(f.runDir,'attempt-001/receipt.json')),
  f=>fs.mkdir(path.join(f.runDir,'new-empty-dir')),
  f=>fs.mkdir(path.join(f.runDir,'attempt-002')),
  f=>fs.writeFile(path.join(f.runDir,'new-file'),'SYNTHETIC'),
  f=>fs.unlink(path.join(f.folder,'review.json')),
  f=>fs.appendFile(path.join(f.folder,'historical-report.json'),' '),
  async f=>{const p=path.join(f.folder,'review.json'),v=await read(p);v.user.id=1;await write(p,v);},
  async f=>{const p=path.join(f.folder,'review.json'),v=await read(p);v.state='CHANGES_REQUESTED';await write(p,v);},
  async f=>{const p=path.join(f.folder,'review.json'),v=await read(p);v.body=v.body.replace('historical_unpublished_closure_approved','engineering_passed');await write(p,v);},
  async f=>{const p=path.join(f.folder,'review.json'),v=await read(p);v.commit_id='b'.repeat(40);await write(p,v);},
  async f=>{const p=path.join(f.folder,'statement.json'),v=await read(p);v.parser_sha256='f'.repeat(64);await write(p,v);await f.approve();},
  async f=>{const p=path.join(f.folder,'statement.json'),v=await read(p);v.schema='UNKNOWN';await write(p,v);await f.approve();},
  async f=>{const p=path.join(f.folder,'statement.json'),v=await read(p);v.original_inventory[0].path='../outside';await write(p,v);await f.approve();},
  async f=>{const p=path.join(f.folder,'statement.json'),s=await fs.readFile(p,'utf8');await fs.writeFile(p,s.replace('{','{"schema":"duplicate",'));},
  async f=>{const p=path.join(f.folder,'review.json');await fs.rename(p,p+'.saved');await fs.symlink(p+'.saved',p);},
  async f=>{const p=path.join(f.folder,'review.json'),v=await read(p);v.body=v.body.replaceAll('a'.repeat(64),'b'.repeat(64));v.body=v.body.replace('scripts/m1-closures.mjs','../outside');await write(p,v);},
 ];
 for(const mutate of mutations){const f=await fixture(t);await mutate(f);await assert.rejects(f.reader.readScoringRun(f.run_id));}
});

test('SYNTHETIC publication, success, outcomes and index traces contradict a closure',async t=>{
 for(const mutate of [f=>fs.mkdir(path.join(f.runDir,'publication')),f=>fs.mkdir(path.join(f.runDir,'.publication-temp')),f=>fs.mkdir(path.join(f.dataRoot,'m1-outcomes',f.run_id),{recursive:true}),f=>write(path.join(f.dataRoot,'m1-task-status/last-forecast-success.json'),{forecast_id:f.run_id}),f=>write(path.join(f.dataRoot,'m1-projections/index.json'),{schema:'MFV:PROJECTIONS:v1',runs:[{run_id:f.run_id,status:'valid'}]})]){const f=await fixture(t);await mutate(f);await assert.rejects(f.reader.readScoringRun(f.run_id));}
});

test('SYNTHETIC closure bytes survive backup/restore and replay; corruption invalidates resumed replay and inventory',async t=>{
 const f=await fixture(t),target=path.join(f.base,'backup');await fs.mkdir(target);const before=await archiveSnapshot(f.dataRoot),files=await closureInventory(f.folder);
 const b=await backup({dataRoot:f.dataRoot,target,port:await freePort(),releaseId:'SYNTHETIC'});assert.equal(b.status,'completed');assert.equal(b.manifest.files.filter(x=>x.name.startsWith('m1-closures/')).length,4);
 const destination=path.join(f.base,'restored');const verify=async root=>{process.env.MFV_DATA_ROOT=root;return replayRestored({codeRoot,dataRoot:root,limit:30});};
 const restored=await restore({target,manifestFile:path.join(target,'manifests',b.manifest.id+'.json'),destination,verify});assert.equal(restored.replay.passed,true);assert.deepEqual(await closureInventory(path.join(destination,'m1-closures',f.run_id)),files);
 await fs.appendFile(path.join(destination,'m1-closures',f.run_id,'review.json'),'invalid');await assert.rejects(replayRestored({codeRoot,dataRoot:destination,limit:30}));
 process.env.MFV_DATA_ROOT=f.dataRoot;await fs.appendFile(path.join(f.folder,'historical-report.json'),' ');assert.notEqual((await archiveSnapshot(f.dataRoot)).sha256,before.sha256);
 await fs.mkdir(path.join(f.dataRoot,'m1-closures','not-a-run'));await assert.rejects(listClosureIds(f.dataRoot));
});
