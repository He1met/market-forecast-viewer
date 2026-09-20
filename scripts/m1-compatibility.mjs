import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {check, digest, canonical, safePath, readBytes} from './m1-files.mjs';
import {verifyPackage} from './m1-package.mjs';
const execute = promisify(execFile);
const roots = ['forecast-runs', 'm1-candidates', 'm1-outcomes', 'm1-cases', 'm1-learning', 'm1-closures','m1-closure-implementations','m1-preparation-proofs','m1-observations','m1-slots','m1-experiments','m1-candidate-proofs'];
// Called under the business mutex. Hash every archive byte, including historical
// revisions and controls; never reuse an earlier compatibility receipt.
export async function archiveSnapshot(dataRoot) {
 const started = performance.now(), files = [];
 async function visit(name) {
  check(performance.now() - started < 30000, 'COMPATIBILITY_INVENTORY_TIMEOUT');
  const file = path.join(dataRoot, name);
  try {await safePath(dataRoot, file);} catch (error) {if(error.code === 'ENOENT') return; throw error;}
  const stat = await fs.lstat(file);
  if(stat.isDirectory()) {files.push({name, directory:true});for(const child of (await fs.readdir(file)).sort()) await visit(path.posix.join(name,child));}
  else {const bytes = await readBytes(dataRoot,file); files.push({name, bytes:bytes.length, sha256:digest(bytes)});}
 }
 for(const name of roots) await visit(name);
 return {sha256:digest(canonical(files)), files:files.length};
}
// Import readers from the exact target package in an isolated Node process.
// No business entry, capture, evaluate, index write, or model APIs are called.
const replay = `
import fs from 'node:fs/promises';import path from 'node:path';
import {createDisplayReader} from './scripts/m1-display.mjs';
import {createOutcomeStore} from './scripts/m1-outcome-store.mjs';
import {caseStore} from './scripts/m1-cases.mjs';
import * as closureModule from './scripts/m1-closures.mjs';
const {listClosureIds,auditClosureImplementations}=closureModule;
// The outer gate has already required explicit support when new roots exist.
const preparationModule=await fs.stat('./scripts/m1-preparation.mjs').then(()=>import('./scripts/m1-preparation.mjs')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const dataRoot=process.env.MFV_DATA_ROOT, root=process.cwd();
const names=async p=>{try{return await fs.readdir(p);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const candidateModule=await fs.stat('./scripts/m1-candidate-proof.mjs').then(()=>import('./scripts/m1-candidate-proof.mjs')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
if(candidateModule)for(const id of await candidateModule.listCandidateProofIds(dataRoot)){const result=await createDisplayReader({root,dataRoot,runsRoot:path.join(dataRoot,'m1-candidates')}).readScoringRun(id);if(result.status!=='candidate_not_invoked_not_scoreable')throw Error('CANDIDATE_PROOF_COMPATIBILITY_INVALID');}
let runs=0,captures=0,revisions=0,cases=0,failed_runs=0,closures=0,not_invoked_candidates=0;const known=new Set();
if(auditClosureImplementations)await auditClosureImplementations(dataRoot);
if(preparationModule){
 const proofs=await preparationModule.auditPreparationProofs(dataRoot);
 for(const id of new Set([...proofs.keys()].map(x=>x.split('/')[0]))){
  const result=await createDisplayReader({root,dataRoot}).readScoringRun(id);
  if(result.status!=='preparation_failed_not_scoreable')throw Error('PREPARATION_PROOF_COMPATIBILITY_INVALID');
 }
}
for(const id of await listClosureIds(dataRoot)){
 const result=await createDisplayReader({root,dataRoot}).readScoringRun(id);
 if(result.status!=='historical_unpublished_closed_not_scoreable')throw Error('CLOSURE_COMPATIBILITY_INVALID');closures++;
}
for(const name of ['forecast-runs','m1-candidates']){
 const runsRoot=path.join(dataRoot,name),reader=createDisplayReader({root,dataRoot,runsRoot}),store=createOutcomeStore({root,dataRoot,runsRoot});
 for(const id of await names(runsRoot)){
  if(known.has(id))throw Error('DUPLICATE_RUN_ID');known.add(id);
  let run;
  try{run=await reader.readRun(id,{includeEvaluation:false});}catch(error){
   const index=await reader.readIndex(),state=index.runs.find(x=>x.run_id===id);
   const contents=await names(path.join(runsRoot,id));
   if(state?.status==='skipped'&&(await reader.readScoringRun(id)).status==='candidate_not_invoked_not_scoreable'){not_invoked_candidates++;continue;}
   if(state?.status!=='failed'||contents.includes('publication')||(await names(path.join(dataRoot,'m1-outcomes',id))).length)throw error;
   failed_runs++;continue;
  }runs++;
  const folder=path.join(dataRoot,'m1-outcomes',id);
  for(const capture of await names(path.join(folder,'captures'))){await store.readCapture(run,capture);captures++;}
  for(const revision of await names(path.join(folder,'evaluations'))){await store.readRevision(run,revision);revisions++;}
 }
}
for(const id of await names(path.join(dataRoot,'m1-outcomes')))if(!known.has(id))throw Error('ORPHAN_OUTCOME');
for(const id of await names(path.join(dataRoot,'m1-cases'))){await caseStore({codeRoot:root,dataRoot}).read(id);cases++;}
console.log(JSON.stringify({status:'compatible',runs,captures,revisions,cases,failed_runs,closures,not_invoked_candidates}));
`;
export async function verifyTargetArchives({packageRoot, dataRoot, releaseId}) {
 const manifest = await verifyPackage(packageRoot);
 check(manifest.release_id === releaseId, 'COMPATIBILITY_TARGET_MISMATCH');
 // Old readers ignoring sidecars do not prove that their backup covers them.
 // Block rollback to such a package; never remove the new evidence to proceed.
 for(const name of ['m1-closure-implementations','m1-preparation-proofs','m1-candidate-proofs']){
  let present=false;try{await safePath(dataRoot,path.join(dataRoot,name));present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(present){
   const support='config/m1-evidence-roots.json';check(manifest.files[support],'TARGET_EVIDENCE_ROOT_UNSUPPORTED:'+name);
   const value=JSON.parse((await readBytes(packageRoot,path.join(packageRoot,support))).toString('utf8'));
   check(value.schema==='MFV:EVIDENCE_ROOT_SUPPORT:v1'&&Array.isArray(value.roots)&&value.roots.includes(name),'TARGET_EVIDENCE_ROOT_UNSUPPORTED:'+name);
  }
 }
 const before = await archiveSnapshot(dataRoot);
 const env = {...process.env, MFV_DATA_ROOT:dataRoot};delete env.NODE_OPTIONS;delete env.NODE_PATH;
 const {stdout} = await execute(process.execPath, ['--import','tsx','--input-type=module','-e',replay],
  {cwd:packageRoot, env, timeout:30000, killSignal:'SIGKILL', maxBuffer:1024*1024});
 const result = JSON.parse(stdout);
 check(result.status==='compatible' && ['runs','captures','revisions','cases'].every(k=>Number.isSafeInteger(result[k])&&result[k]>=0), 'COMPATIBILITY_RESULT_INVALID');
 check((await archiveSnapshot(dataRoot)).sha256===before.sha256, 'ARCHIVES_CHANGED_DURING_COMPATIBILITY');
 check((await verifyPackage(packageRoot)).release_id===releaseId, 'COMPATIBILITY_TARGET_CHANGED');
 return {schema:'MFV:COMPATIBILITY:v1',release_id:releaseId,build_sha:manifest.build_sha,
  archive:before,checked_at:new Date().toISOString(),...result,
  scope:'all forecasts, candidates, captures, evaluation revisions and eligible cases',read_only:true};
}
