import {capacitySnapshot,requireCapacity} from './m1-capacity.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'all';
const commands = {
 package: [['node_modules/vite/bin/vite.js','build'],['--import','tsx','scripts/verify-package.mjs']],
 unit: [['node_modules/vitest/vitest.mjs', 'run', 'tests/data.test.ts', 'tests/demo-explanation.test.ts']],
 m1: [['node_modules/vitest/vitest.mjs','run','tests/m1-contracts.test.ts'], ['--import','tsx','--test','tests/m1-archive.test.mjs','tests/m1-runner.test.mjs','tests/m1-events.test.mjs','tests/m1-local-only.test.mjs']],
 display: [['node_modules/vitest/vitest.mjs','run','tests/chart-model.test.ts'],['--import','tsx','--test','tests/m1-display.test.mjs']],
 evaluation: [['node_modules/vitest/vitest.mjs','run','tests/m1-evaluation.test.ts'],['--import','tsx','--test','tests/m1-outcome-store.test.mjs']],
 runtime: [['--import','tsx','--test','tests/m1-runtime.test.mjs','tests/m1-runtime-display.test.mjs']],
 typecheck: [['node_modules/typescript/bin/tsc','--noEmit']],
 build: [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vite/bin/vite.js','build']],
 browser: [['node_modules/@playwright/test/cli.js','test']],
 demo: [['--import','tsx','scripts/make-demo.mjs']],
 smoke: [['-e', 'console.log("SYNTHETIC evidence wrapper smoke")']],
 'record-stage': [['--import','tsx','scripts/record-stage.mjs','c5']],
 bfcache: [['--import','tsx','scripts/verify-bfcache.mjs']],
 servers: [['--import','tsx','scripts/verify-local-servers.mjs']],
};
if (!commands[mode] && !['all','quality'].includes(mode)) throw Error('UNKNOWN_VERIFY_MODE');
const extra = process.argv.slice(3).filter(x => x !== '--');
if (extra.some(x=>/output|config|reporter|trace|repeat|retries/i.test(x)) || (extra.length && mode !== 'browser')) throw Error('UNSAFE_VERIFY_ARGUMENT');
const id = new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID(), evidence = path.join(root,'artifacts/evidence',id), work=path.join(evidence,'work');
await fs.mkdir(evidence,{recursive:true,mode:0o700});
const token=randomBytes(32).toString('hex'), hash=x=>createHash('sha256').update(x).digest('hex');
const context={schema:'MFV:EVIDENCE_CONTEXT:v1',id,evidence_root:evidence,workspace:work,started_at:new Date().toISOString(),parent_pid:process.pid,token_sha256:hash(token),mode,source_head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),synthetic:true};
await fs.writeFile(path.join(evidence,'context.json'),JSON.stringify(context,null,2)+'\n',{flag:'wx',mode:0o600});
const skipped=new Set(['artifacts','node_modules','.git','dist','.local','coverage','test-results','playwright-report']);
async function copy(from,to){await fs.mkdir(to,{recursive:true});for(const ent of await fs.readdir(from,{withFileTypes:true})){if(skipped.has(ent.name)||ent.name==='.DS_Store'||ent.name.startsWith('.env'))continue;const src=path.join(from,ent.name),dst=path.join(to,ent.name);if(ent.isSymbolicLink())throw Error('SOURCE_SYMLINK_FORBIDDEN');if(ent.isDirectory()){if(src===path.join(root,'public/data'))continue;await copy(src,dst);}else await fs.copyFile(src,dst);}}
let result={status:'failed',steps:[]};
try {
 requireCapacity(await capacitySnapshot(root));
 await copy(root,work);
 await fs.cp(path.join(root,'node_modules'),path.join(work,'node_modules'),{recursive:true,force:false,errorOnExist:true});
 for(const args of [['init','-b','feat/chart-mvp'],['add','.'],['-c','user.name=MFV Synthetic CI','-c','user.email=synthetic@example.invalid','commit','-m','SYNTHETIC verification checkout']])execFileSync('git',args,{cwd:work,stdio:'pipe'});
 const env={...process.env,MFV_EVIDENCE_CONTEXT:path.join(evidence,'context.json'),MFV_EVIDENCE_TOKEN:token,MFV_TEST_WORKSPACE:work,MFV_E2E_PORT:process.env.MFV_E2E_PORT??'5187'};
 delete env.NODE_PATH;delete env.NODE_OPTIONS;
 async function run(args){const n=result.steps.length+1,log=await fs.open(path.join(evidence,`step-${n}.log`),'wx');const started_at=new Date().toISOString();let child;
  const exit=await new Promise((resolve,reject)=>{child=spawn(process.execPath,args,{cwd:work,env,detached:true,stdio:['ignore',log.fd,log.fd]});let stopping=false,killTimer;const stop=()=>{if(stopping)return;stopping=true;try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);};const timer=setTimeout(stop,15*60*1000);process.once('SIGTERM',stop);process.once('SIGINT',stop);const clean=()=>{clearTimeout(timer);clearTimeout(killTimer);process.off('SIGTERM',stop);process.off('SIGINT',stop);};child.on('error',error=>{clean();reject(error);});child.on('close',(code,signal)=>{clean();resolve({code:stopping?1:code,signal});});});await log.close();result.steps.push({args,started_at,ended_at:new Date().toISOString(),...exit});if(exit.code!==0)throw Error(`VERIFY_STEP_FAILED:${n}:${exit.code}`);}
 await run(['--import','tsx','tests/fixtures/generate.mjs']);
 let list=commands[mode];if(!list){const names=(await fs.readdir(path.join(work,'tests'))).filter(x=>x.endsWith('.test.mjs')&&x!=='m1-backup-scale.test.mjs').sort().map(x=>'tests/'+x);list=[['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run',...(await fs.readdir(path.join(work,'tests'))).filter(x=>x.endsWith('.test.ts')).map(x=>'tests/'+x)],['--import','tsx','--test',...names],['--import','tsx','--test','--test-concurrency=1','tests/m1-backup-scale.test.mjs'],['node_modules/vite/bin/vite.js','build']];if(mode==='all')list.push(...commands.browser);}
 for(const args of list)await run([...args,...(mode==='browser'?extra:[])]);
 result.status='passed';
} catch(error){result.error=error.message;process.exitCode=1;}
const receiptFiles=[];async function inventory(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(['work','node_modules'].includes(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await inventory(file);else if(entry.isFile()){const bytes=await fs.readFile(file);receiptFiles.push({file:path.relative(evidence,file),bytes:bytes.length,sha256:hash(bytes)});}}}await inventory(evidence);result.files=receiptFiles;
result.completed_at=new Date().toISOString();result.evidence_id=id;
await fs.writeFile(path.join(evidence,'completed.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({...result,evidence_root:evidence},null,2));
