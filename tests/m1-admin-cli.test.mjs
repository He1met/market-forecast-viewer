import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {learningArguments,releaseArguments} from '../scripts/m1-admin-args.mjs';
import {disableLearning} from '../scripts/m1-admin.mjs';
import {buildPackage} from '../scripts/m1-package-build.mjs';
import {atomic,readJson} from '../scripts/m1-files.mjs';
const sha='a'.repeat(40),release='b'.repeat(64);
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const home=path.join(root,'runtime'),data=path.join(root,'data');await fs.mkdir(home);await fs.mkdir(data);const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const config={schema:'MFV:INSTALLATION:v1',runtime_home:home,data_root:data,http_port:port===65535?port-1:port+1,mutex_port:port,forecast_paused:true,ops_paused:true,service_paused:true};await atomic(home,path.join(home,'installation.local.json'),config);await atomic(home,path.join(home,'current.json'),{release_id:release});return{root,home,data,config,options:{runtimeHome:home,dataRoot:data,port,releaseId:release,reason:'operator observed regression'}};}
test('maintenance CLI rejects missing/duplicate/unknown arguments before filesystem work',async t=>{
 const f=await fixture(t),destination=path.join(f.root,'candidate');
 for(const args of [[],['--commit','HEAD','--destination',destination],['--commit',sha,'--commit',sha],['--commit',sha,'--destination','relative'],['--commit',sha,'--destination',destination,'--activate']]){
  assert.throws(()=>releaseArguments(args));const result=spawnSync(process.execPath,['scripts/m1-release.mjs',...args],{encoding:'utf8'});assert.notEqual(result.status,0);await assert.rejects(()=>fs.stat(destination),/ENOENT/);
 }
 for(const args of [[],['enable'],['disable','--reason',' '],['disable','--reason','valid','ignored']]){
  assert.throws(()=>learningArguments(args));const result=spawnSync(process.execPath,['scripts/m1-installed.mjs','learning',...args],{encoding:'utf8',env:{...process.env,MFV_RUNTIME_HOME:f.home}});assert.notEqual(result.status,0);assert.match(result.stderr,/LEARNING_ARGUMENTS_INVALID/);
  const launcher=spawnSync(process.execPath,['runtime/launch.mjs',f.home,'learning',...args],{encoding:'utf8'});assert.notEqual(launcher.status,0);assert.match(launcher.stderr,/LAUNCH_ARGUMENTS_INVALID/);
 }
 assert.deepEqual(await fs.readdir(f.data),[]);
});
test('release rejects nonexistent commit and symlink parent without creating candidate',async t=>{
 const f=await fixture(t),destination=path.join(f.root,'candidate');
 await assert.rejects(()=>buildPackage({destination,buildSha:'0'.repeat(40)}));await assert.rejects(()=>fs.stat(destination),/ENOENT/);
 const link=path.join(f.root,'alias');await fs.symlink(f.data,link);await assert.rejects(()=>buildPackage({destination:path.join(link,'candidate'),buildSha:sha}),/SYMLINK_FORBIDDEN/);assert.deepEqual(await fs.readdir(f.data),[]);
});
test('learning disable preserves first effective run, controls, and pause state; stale release rejected',async t=>{
 const f=await fixture(t),file=path.join(f.data,'m1-learning/controls.json');
 await atomic(f.data,file,{disabled_scorers:['old'],revoked_revisions:['rev']});const before=await fs.readFile(path.join(f.home,'installation.local.json'),'utf8');
 await assert.rejects(()=>disableLearning({...f.options,releaseId:'c'.repeat(64)}),/PINNED_RELEASE_MISMATCH/);assert.equal((await readJson(f.data,file)).learning_disabled,undefined);
 const result=await disableLearning(f.options);assert.equal(result.status,'applied');assert.equal(result.controls.learning_disabled,true);assert.deepEqual(result.controls.disabled_scorers,['old']);
 await atomic(f.data,file,{...result.controls,first_run_id:'SYNTHETIC_FIRST'});const frozen=await fs.readFile(file,'utf8');const second=await disableLearning({...f.options,reason:'different retry reason'});assert.equal(second.status,'unchanged');assert.equal(await fs.readFile(file,'utf8'),frozen);assert.equal((await fs.readdir(path.join(f.data,'m1-learning/changes'))).length,1);assert.equal(await fs.readFile(path.join(f.home,'installation.local.json'),'utf8'),before);
});
test('failed disable intent keeps learning controls unchanged and releases mutex',async t=>{
 const f=await fixture(t),file=path.join(f.data,'m1-learning/controls.json');await atomic(f.data,file,{disabled_scorers:[],revoked_revisions:[]});const before=await fs.readFile(file,'utf8');await fs.writeFile(path.join(f.data,'m1-learning/changes'),'blocked');await assert.rejects(()=>disableLearning(f.options));assert.equal(await fs.readFile(file,'utf8'),before);await fs.unlink(path.join(f.data,'m1-learning/changes'));assert.equal((await disableLearning(f.options)).status,'applied');
});

test('rollback requires exact previous release and leaves pointers untouched on invalid target',async t=>{
 const {rollbackArguments}=await import('../scripts/m1-admin-args.mjs');
 const {rollback}=await import('../scripts/m1-admin.mjs');
 const f=await fixture(t),file=path.join(f.home,'current.json');
 await atomic(f.home,file,{release_id:release,previous_release_id:'c'.repeat(64)});
 const before=await fs.readFile(file);
 for(const args of [[],['--release','previous'],['--release','c'.repeat(64),'extra'],['--bad','c'.repeat(64)]]){
  assert.throws(()=>rollbackArguments(args));
  const result=spawnSync(process.execPath,['scripts/m1-rollback.mjs',...args],{env:{...process.env,MFV_RUNTIME_HOME:f.home},encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/ROLLBACK_ARGUMENTS_INVALID/);
 }
 await assert.rejects(()=>rollback({runtimeHome:f.home,releaseId:release}),/EXACT_PREVIOUS_RELEASE_REQUIRED/);
 assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readdir(f.data),[]);
});

test('compatibility snapshot includes historical bytes and rejects symlinks',async t=>{
 const {archiveSnapshot}=await import('../scripts/m1-compatibility.mjs');const f=await fixture(t);
 const dir=path.join(f.data,'m1-outcomes','SYNTHETIC','evaluations','old');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'result.json');await fs.writeFile(file,'old');
 const before=await archiveSnapshot(f.data);await fs.writeFile(file,'changed');assert.notEqual((await archiveSnapshot(f.data)).sha256,before.sha256);
 await fs.symlink(f.home,path.join(f.data,'m1-candidates'));await assert.rejects(()=>archiveSnapshot(f.data),/SYMLINK_FORBIDDEN/);
});

test('input plan CLI requires bounded input, exact policy and reason; pinned state and prerequisite gates hold',async t=>{
 const {planInputExperiment}=await import('../scripts/m1-input-plan.mjs');const {digest,canonical}=await import('../scripts/m1-files.mjs');
 const f=await fixture(t),baseline={predictor_version:'SYNTHETIC',model:'SYNTHETIC',reasoning_effort:'medium',additional_inputs:'none',feedback:'F0',lambda:0};
 const args=['plan-input','--input','calendar','--policy-sha',digest(canonical(baseline)),'--reason','controlled comparison'];
 assert.equal(learningArguments(args).input,'calendar');
 for(const bad of [args.slice(0,-1),[...args,'extra'],args.map(x=>x==='calendar'?'both':x),args.map(x=>x===args[4]?'HEAD':x)]){
  assert.throws(()=>learningArguments(bad),/LEARNING_ARGUMENTS_INVALID/);const result=spawnSync(process.execPath,['runtime/launch.mjs',f.home,'learning',...bad],{encoding:'utf8'});assert.match(result.stderr,/LAUNCH_ARGUMENTS_INVALID/);
 }
 const options={...f.options,codeRoot:process.cwd(),baseline,...learningArguments(args)};
 await assert.rejects(()=>planInputExperiment({...options,releaseId:'c'.repeat(64)}),/PINNED_RELEASE_MISMATCH/);
 await assert.rejects(()=>planInputExperiment({...options,policySha:'0'.repeat(64)}),/INPUT_PLAN_POLICY_CHANGED/);
 await assert.rejects(()=>planInputExperiment(options),/FEEDBACK_COMPARISON_REQUIRED/);
 const controls=path.join(f.data,'m1-learning/controls.json');await atomic(f.data,controls,{learning_disabled:true});await assert.rejects(()=>planInputExperiment(options),/LEARNING_DISABLED/);
 assert.equal((await readJson(f.home,path.join(f.home,'installation.local.json'))).forecast_paused,true);
});
