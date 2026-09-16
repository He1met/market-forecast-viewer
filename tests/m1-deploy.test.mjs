import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {commitInstallation} from '../scripts/m1-install-commit.mjs';
import {deployArguments} from '../scripts/m1-admin-args.mjs';
import net from 'node:net';
import {activate,rollback} from '../scripts/m1-admin.mjs';
import {verifyProtocolEvidence,installationProtocol,protocolFiles} from '../scripts/m1-install-protocol.mjs';
import {digest} from '../scripts/m1-files.mjs';
import {startService} from '../scripts/m1-service.mjs';
const release='a'.repeat(64),names=['launch.mjs','installation.local.json','current.json'];
async function fixture(t,existing=true){const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-deploy-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));if(existing)for(const name of names)await fs.writeFile(path.join(home,name),'old '+name);return home;}
const files=Object.fromEntries(names.map(n=>[n,'new '+n]));
test('deploy requires exact release and explicit absolute approval/config files',async()=>{
 const good=['--release',release,'--approval','/approval.json','--config','/config.json'];assert.equal(deployArguments(good).releaseId,release);
 for(const args of [[],good.slice(0,4),[...good,'--force'],['--release','HEAD',...good.slice(2)],['--release',release,'--approval','relative','--config','/config.json'],['--release',release,'--config','/x','--config','/y']]){
  assert.throws(()=>deployArguments(args));const r=spawnSync(process.execPath,['scripts/m1-deploy.mjs',...args],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/DEPLOY_ARGUMENTS_INVALID|EXACT_RELEASE_REQUIRED|ABSOLUTE_DEPLOY_FILE_REQUIRED/);
 }
});
test('installation commit reads back all files and records durable before images',async t=>{
 const home=await fixture(t);const result=await commitInstallation({runtimeHome:home,files,guard:async()=>{},rollbackGuard:async()=>assert.fail('no rollback')});
 assert.equal(result.status,'committed');for(const name of names)assert.equal(await fs.readFile(path.join(home,name),'utf8'),files[name]);
 const intent=JSON.parse(await fs.readFile(path.join(home,'installation-changes',result.id,'intent.json')));for(const item of intent.files)assert.equal(Buffer.from(item.before,'base64').toString(),'old '+item.name);
});
test('partial installation failure restores old bytes only after compatibility gate',async t=>{
 const home=await fixture(t);let guards=0,compatibility=0;
 await assert.rejects(()=>commitInstallation({runtimeHome:home,files,guard:async()=>{if(++guards===3)throw Error('SYNTHETIC_WRITE_INTERRUPTION');},rollbackGuard:async()=>{compatibility++;assert.equal(await fs.readFile(path.join(home,'launch.mjs'),'utf8'),files['launch.mjs']);}}),/SYNTHETIC_WRITE_INTERRUPTION/);
 assert.equal(compatibility,1);for(const name of names)assert.equal(await fs.readFile(path.join(home,name),'utf8'),'old '+name);
 const [id]=await fs.readdir(path.join(home,'installation-changes'));assert.equal(JSON.parse(await fs.readFile(path.join(home,'installation-changes',id,'recovery-state.json'))).status,'restored_before_images');
});
test('first installation failure removes only its own newly created files',async t=>{
 const home=await fixture(t,false);let guards=0;
 await assert.rejects(()=>commitInstallation({runtimeHome:home,files,guard:async()=>{if(++guards===4)throw Error('SYNTHETIC');},rollbackGuard:async()=>{}}),/SYNTHETIC/);
 for(const name of names)await assert.rejects(()=>fs.stat(path.join(home,name)),/ENOENT/);
});
test('changed files and incompatible old package require recovery without overwrite',async t=>{
 for(const mode of ['external','incompatible']){
  const home=await fixture(t);let guards=0;
  await assert.rejects(()=>commitInstallation({runtimeHome:home,files,guard:async()=>{if(++guards===3){if(mode==='external')await fs.writeFile(path.join(home,'launch.mjs'),'external');throw Error('SYNTHETIC');}},rollbackGuard:async()=>{if(mode==='incompatible')throw Error('OLD_PACKAGE_INCOMPATIBLE');}}),/INSTALL_COMMIT_RECOVERY_REQUIRED/);
  assert.equal(await fs.readFile(path.join(home,'launch.mjs'),'utf8'),mode==='external'?'external':files['launch.mjs']);
  assert.equal(await fs.readFile(path.join(home,'current.json'),'utf8'),'old current.json');
 }
});

// Actual process death, not a caught exception. Each new process reacquires the
// ordinary business mutex. This is a synthetic file-control test, not activation.
const childSource=`
import {commitInstallation,recoverInstallationFiles} from './scripts/m1-install-commit.mjs';
import {businessMutex} from './scripts/m1-mutex.mjs';
import fs from 'node:fs/promises';import path from 'node:path';
const home=process.env.SYNTHETIC_HOME,data=path.join(home,'data');await fs.mkdir(data,{recursive:true});
const mutex=await businessMutex({dataRoot:data,port:Number(process.env.SYNTHETIC_PORT),releaseId:'SYNTHETIC_INSTALL_TEST',task:'admin'});
if(mutex.status!=='ACQUIRED')throw Error(mutex.status);let count=0;
const guard=async()=>{await mutex.guard();if(++count===Number(process.env.SYNTHETIC_KILL_BOUNDARY))process.kill(process.pid,'SIGKILL');};
try{
 if(process.env.SYNTHETIC_ACTION==='commit')await commitInstallation({runtimeHome:home,files:JSON.parse(process.env.SYNTHETIC_FILES),guard,rollbackGuard:async()=>{throw Error('unexpected caught failure');}});
 else {const {id}=JSON.parse(await fs.readFile(path.join(home,'installation-pending.json')));await recoverInstallationFiles({runtimeHome:home,id,guard,verifyTarget:async({transaction})=>{if(transaction.intent.runtime_home!==home)throw Error('SYNTHETIC_BINDING');}});}
}finally{await mutex.close();}
`;
const actualLauncher=await fs.readFile('runtime/launch.mjs','utf8');
async function actualFixture(t){const home=await fixture(t);await fs.writeFile(path.join(home,'launch.mjs'),actualLauncher);return home;}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function child(home,p,action,kill=0){return spawnSync(process.execPath,['--input-type=module','-e',childSource],{encoding:'utf8',timeout:15000,env:{...process.env,SYNTHETIC_HOME:home,SYNTHETIC_PORT:String(p),SYNTHETIC_ACTION:action,SYNTHETIC_KILL_BOUNDARY:String(kill),SYNTHETIC_FILES:JSON.stringify({...files,'launch.mjs':actualLauncher})}});}
test('SIGKILL at every commit boundary blocks new entry and recovers in a new process',async t=>{
 for(const boundary of [3,4,5,6]){
  const home=await actualFixture(t),p=await port(),dead=child(home,p,'commit',boundary);assert.equal(dead.signal,'SIGKILL',dead.stderr);
  for(const entry of [[path.join(home,'launch.mjs'),home,'forecast'],['scripts/m1-installed.mjs','forecast']]){const r=spawnSync(process.execPath,entry,{encoding:'utf8',env:{...process.env,MFV_RUNTIME_HOME:home}});assert.notEqual(r.status,0);assert.match(r.stderr,/INSTALLATION_RECOVERY_REQUIRED/);}
  await assert.rejects(()=>activate({runtimeHome:home}),/INSTALLATION_RECOVERY_REQUIRED/);await assert.rejects(()=>rollback({runtimeHome:home}),/INSTALLATION_RECOVERY_REQUIRED/);await assert.rejects(()=>startService({runtimeHome:home,port:p,paused:false}),/INSTALLATION_RECOVERY_REQUIRED/);
  const retry=child(home,p,'commit');assert.notEqual(retry.status,0);assert.match(retry.stderr,/INSTALLATION_RECOVERY_REQUIRED/);
  const restored=child(home,p,'recover');assert.equal(restored.status,0,restored.stderr);
  for(const name of names)assert.equal(await fs.readFile(path.join(home,name),'utf8'),name==='launch.mjs'?actualLauncher:boundary===6?files[name]:'old '+name);
  await assert.rejects(()=>fs.stat(path.join(home,'installation-pending.json')),/ENOENT/);
 }
});
test('SIGKILL at every recovery boundary is resumable; unknown bytes stay blocked',async t=>{
 for(const boundary of [3,4,5,6]){
  const home=await actualFixture(t),p=await port();assert.equal(child(home,p,'commit',5).signal,'SIGKILL');
  assert.equal(child(home,p,'recover',boundary).signal,'SIGKILL');const blocked=spawnSync(process.execPath,[path.join(home,'launch.mjs'),home,'forecast'],{encoding:'utf8'});assert.match(blocked.stderr,/INSTALLATION_RECOVERY_REQUIRED/);const done=child(home,p,'recover');assert.equal(done.status,0,done.stderr);
  for(const name of names)assert.equal(await fs.readFile(path.join(home,name),'utf8'),name==='launch.mjs'?actualLauncher:'old '+name);
 }
 const home=await actualFixture(t),p=await port();assert.equal(child(home,p,'commit',4).signal,'SIGKILL');await fs.writeFile(path.join(home,'launch.mjs'),'UNKNOWN');
 const rejected=child(home,p,'recover');assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/INSTALL_CHANGED_DURING_COMMIT/);assert.equal(await fs.readFile(path.join(home,'launch.mjs'),'utf8'),'UNKNOWN');await fs.stat(path.join(home,'installation-pending.json'));
});
test('legacy installed launcher without reviewed protocol is rejected without mutation',async t=>{
 const home=await fixture(t),file=path.join(home,'launch.mjs'),legacy="console.log('SYNTHETIC legacy launcher without a gate');\n";await fs.writeFile(file,legacy);
 const before=await fs.readFile(file),manifest={release_id:release,build_sha:'b'.repeat(40),files:{'runtime/launch.mjs':{sha256:digest(before)}}},approval={approved:true,release_id:release,build_sha:manifest.build_sha};
 assert.throws(()=>verifyProtocolEvidence({manifest,approval,launcher:before}),/LEGACY_INSTALLATION_PROTOCOL_UNSUPPORTED/);
 // A keyword or unapproved declaration cannot certify a historical installation.
 manifest.installation_protocol={schema:installationProtocol,files:Object.fromEntries(protocolFiles.map(f=>[f,'a'.repeat(64)]))};
 assert.throws(()=>verifyProtocolEvidence({manifest,approval,launcher:Buffer.from('installation-pending.json')}),/LEGACY_INSTALLATION_PROTOCOL_UNSUPPORTED/);
 assert.deepEqual(await fs.readFile(file),before);await assert.rejects(()=>fs.stat(path.join(home,'installation-pending.json')),/ENOENT/);
});
test('HTTP port migration fails before package lookup or any installation write',async t=>{
 const home=await fixture(t),data=path.join(home,'data');await fs.mkdir(data);const config={runtime_home:home,data_root:data,http_port:12001,mutex_port:12002};await fs.writeFile(path.join(home,'installation.local.json'),JSON.stringify(config));await fs.writeFile(path.join(home,'current.json'),JSON.stringify({release_id:release}));
 const before=await Promise.all(names.map(n=>fs.readFile(path.join(home,n))));
 await assert.rejects(()=>activate({runtimeHome:home,releaseId:release,approval:{},config:{...config,http_port:12003}}),/HTTP_PORT_MIGRATION_REQUIRES_SEPARATE_FLOW/);
 assert.deepEqual(await Promise.all(names.map(n=>fs.readFile(path.join(home,n)))),before);await assert.rejects(()=>fs.stat(path.join(home,'installation-pending.json')),/ENOENT/);
});
test('reviewed protocol binds every guarded file and actual installed launcher bytes',()=>{
 // Metadata validation only: this object is never installed or activated.
 const hashes=Object.fromEntries(protocolFiles.map(f=>[f,digest(f==='runtime/launch.mjs'?actualLauncher:f)]));
 const manifest={synthetic:false,release_id:release,build_sha:'b'.repeat(40),files:Object.fromEntries(Object.entries(hashes).map(([f,sha256])=>[f,{sha256}])),installation_protocol:{schema:installationProtocol,files:hashes}};
 const approval={schema:'MFV:MAINTAINER_APPROVAL:v1',approved:true,release_id:release,build_sha:manifest.build_sha,source_url:'https://github.com/He1met/market-forecast-viewer/pull/7',approved_at:'2026-09-16T00:00:00Z',installation_protocol:installationProtocol};
 verifyProtocolEvidence({manifest,approval,launcher:Buffer.from(actualLauncher)});
 assert.throws(()=>verifyProtocolEvidence({manifest,approval:{...approval,build_sha:'c'.repeat(40)},launcher:Buffer.from(actualLauncher)}),/PROTOCOL_APPROVAL_MISMATCH/);
 assert.throws(()=>verifyProtocolEvidence({manifest,approval,launcher:Buffer.from('legacy launcher')}),/INSTALLED_LAUNCHER_PROTOCOL_MISMATCH/);
 assert.throws(()=>verifyProtocolEvidence({manifest:{...manifest,installation_protocol:{...manifest.installation_protocol,files:{}}},approval,launcher:Buffer.from(actualLauncher)}),/INSTALL_PROTOCOL_BINDING_INVALID/);
});
