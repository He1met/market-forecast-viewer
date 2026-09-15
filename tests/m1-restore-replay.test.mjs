import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { replayRestored } from '../scripts/m1-restore-replay.mjs';

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-restore-replay-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
function reader(ids,{broken=()=>false,onRead=()=>{}}={}) {
 return {listRunIds:async()=>ids,runState:async id=>({run_id:id,status:broken(id)?'invalid':'valid',reason:null,
  created_at:'2026-09-12T18:36:00Z',published_at:'2026-09-12T18:39:00Z'}),
  readRun:async id=>{onRead(id);return {run_id:id,hashes:{forecast_sha256:'SYNTHETIC_'+id},evaluation:{status:'none'}};}};
}
const emptyCases={controls:async()=>({learning_disabled:false}),read:async()=>{throw Error('UNEXPECTED_CASE');}};

test('restore cannot certify a copied index or one batch; both roles finish all reconstructed views',async t=>{
 const root=await fixture(t),ids=Array.from({length:17},(_,i)=>'SYNTHETIC_'+i);
 await fs.mkdir(path.join(root,'m1-projections'));const original='{"SYNTHETIC_COPIED_INDEX":true}';
 await fs.writeFile(path.join(root,'m1-projections/index.json'),original);
 const args={dataRoot:root,readers:{production:reader(ids),candidate:reader(['CANDIDATE'])},cases:emptyCases,limit:16};
 const first=await replayRestored(args);assert.equal(first.status,'incomplete');assert.equal(first.production,16);
 const second=await replayRestored(args);assert.equal(second.status,'incomplete');assert.equal(second.projections.production,false);
 let final;for(let i=0;i<4;i++){final=await replayRestored(args);if(final.passed)break;}
 assert.equal(final.passed,true);assert.equal(final.forecast_count,17);assert.equal(final.candidate_count,1);
 const rebuilt=JSON.parse(await fs.readFile(path.join(root,'restore-derived/production/m1-projections/index.json')));
 assert.deepEqual(new Set(rebuilt.runs.map(x=>x.run_id)),new Set(ids));assert.equal(rebuilt.summary.valid_runs,17);
 assert.equal(await fs.readFile(path.join(root,'m1-projections/index.json'),'utf8'),original);
});

test('corrupt candidate blocks restore after production succeeds; repaired candidate resumes exact cursor',async t=>{
 const root=await fixture(t);let broken=true,productionReads=0;
 const args={dataRoot:root,readers:{production:reader(['P'],{onRead:()=>productionReads++}),
  candidate:reader(['C'],{broken:()=>broken})},cases:emptyCases};
 await assert.rejects(()=>replayRestored(args),/RESTORE_ARCHIVE_INVALID:candidate/);
 const state=JSON.parse(await fs.readFile(path.join(root,'restore-replay-v2.json')));
 assert.equal(state.production.length,1);assert.equal(state.candidate.length,0);assert.equal(productionReads,1);
 broken=false;assert.equal((await replayRestored(args)).passed,true);
 // Production is read once more to build its new projection, not restarted as a replay.
 assert.equal(productionReads,2);
});

test('changed archive inventory refuses resume and projection corruption never becomes success',async t=>{
 const root=await fixture(t),ids=['P','Q'];let reads=0;
 const production=reader(ids,{broken:()=>reads>=2,onRead:()=>reads++});
 const args={dataRoot:root,readers:{production,candidate:reader([])},cases:emptyCases,limit:1};
 assert.equal((await replayRestored(args)).status,'incomplete');ids.push('NEW');
 await assert.rejects(()=>replayRestored(args),/RESTORE_REPLAY_OBJECTS_CHANGED/);ids.pop();
 assert.equal((await replayRestored(args)).status,'incomplete');
 await assert.rejects(()=>replayRestored(args),/RESTORE_PROJECTION_INVALID/);
});

test('learning replay keeps revoked cases distinct, resumes across batches, and retries summary write failure',async t=>{
 const root=await fixture(t),ids=['a'.repeat(64),'b'.repeat(64)];await fs.mkdir(path.join(root,'m1-cases'));
 for(const id of ids)await fs.mkdir(path.join(root,'m1-cases',id));
 let calls=0;const cases={controls:async()=>({learning_disabled:true}),read:async id=>{calls++;
  if(id===ids[1])throw Error('SCORER_OR_REVISION_DISABLED');return {brier:0.25,revision_id:'SYNTHETIC_REVISION'};}};
 const args={dataRoot:root,readers:{production:reader([]),candidate:reader([])},cases,limit:1};
 assert.equal((await replayRestored(args)).status,'incomplete');assert.equal((await replayRestored(args)).status,'incomplete');
 const summary=path.join(root,'restore-derived/learning-summary.json');await fs.mkdir(summary,{recursive:true});
 await assert.rejects(()=>replayRestored(args),/EISDIR|ENOTEMPTY/);assert.equal(calls,2);await fs.rmdir(summary);
 const final=await replayRestored(args);assert.equal(final.passed,true);assert.equal(final.case_count,1);assert.equal(final.excluded_case_count,1);assert.equal(calls,2);
 const value=JSON.parse(await fs.readFile(summary));assert.equal(value.learning_disabled,true);assert.equal(value.mean_brier,0.25);
});
