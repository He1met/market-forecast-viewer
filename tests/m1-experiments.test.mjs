import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{experimentStore,effectivePolicy}from'../scripts/m1-experiments.mjs';
test('registered first-20 decision takes effect only later; shadow allows one rollback without oscillation',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-experiment-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const OriginalDate=Date;let now=OriginalDate.parse('2026-01-01T00:00:00Z');globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};t.after(()=>{globalThis.Date=OriginalDate;});
 const guard=async()=>{},store=experimentStore(root),baseline={predictor_version:'SYNTHETIC',model:'SYNTHETIC',reasoning_effort:'medium',additional_inputs:'none',feedback:'F0',lambda:0},candidate={...baseline,feedback:'F1'};
 await assert.rejects(()=>store.create(baseline,{...baseline,lambda:.1},{guard,factor:'feedback'}),/SINGLE_FACTOR/);
 const plan=await store.create(baseline,candidate,{guard});const metrics=new Map();
 async function fill(plan,dayOffset){for(let i=0;i<20;i++){const anchor=OriginalDate.parse('2026-01-01T17:45:00Z')/1000+(dayOffset+i)*86400;now=(anchor+120)*1000;const registration=await store.register({slot_id:'slot-'+dayOffset+'-'+i,anchor_time:anchor},plan.control,{guard});assert.ok(registration);assert.equal(await store.register({slot_id:'slot-'+dayOffset+'-'+i,anchor_time:anchor},plan.control,{guard}),null);const official='official-'+dayOffset+'-'+i,challenger='candidate-'+dayOffset+'-'+i;await fs.writeFile(path.join(registration.dir,'frozen.json'),JSON.stringify({official_run_id:official,candidate_run_id:challenger,candidate_input_hash:'SYNTHETIC'}));await attemptStart(root,challenger,new OriginalDate(now+2000).toISOString());await store.finish(registration,{started:true,candidate_status:'published'});metrics.set(official,{valid:true,timely:true,complete:true,started_at:new OriginalDate(now+1000).toISOString(),path_loss:2,brier:.3});metrics.set(challenger,{valid:true,timely:true,complete:true,started_at:new OriginalDate(now+2000).toISOString(),path_loss:1.8,brier:.31});}now+=86400000;}
 await fill(plan,0);const decision=await store.review({guard,readMetrics:async id=>metrics.get(id)});assert.equal(decision.decision,'promote');assert.equal(decision.complete_pairs,20);assert.deepEqual(await effectivePolicy(root,baseline,new OriginalDate(now).toISOString()),baseline);now++;assert.deepEqual(await effectivePolicy(root,baseline,new OriginalDate(now).toISOString()),candidate);
 const shadow=await store.active();assert.equal(shadow.phase,'rollback');assert.deepEqual(shadow.control,candidate);assert.deepEqual(shadow.candidate,baseline);await fill(shadow,21);const rollback=await store.review({guard,readMetrics:async id=>metrics.get(id)});assert.equal(rollback.decision,'promote');now++;assert.deepEqual(await effectivePolicy(root,baseline,new OriginalDate(now).toISOString()),baseline);assert.equal(await store.active(),null);assert.equal(await store.review({guard,readMetrics:async()=>{throw Error('must not reevaluate');}}),null);
});

test('decision transition recovers every write boundary without rescoring or duplicate rollback plans',async t=>{
 const OriginalDate=Date;let now=OriginalDate.parse('2026-01-01T00:00:00Z');globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};t.after(()=>{globalThis.Date=OriginalDate;});
 const baseline={predictor_version:'SYNTHETIC',model:'SYNTHETIC',reasoning_effort:'medium',additional_inputs:'none',feedback:'F0',lambda:0},candidate={...baseline,feedback:'F1'},guard=async()=>{};
 for(const kind of ['promote','reject','insufficient_evidence','rollback'])for(const boundary of ['intent','decision','decision_commit','policy',...(kind==='promote'?['rollback_plan']:[]),'active','completed']){
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-transition-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));now=OriginalDate.parse('2026-01-01T00:00:00Z');
  let crashed=false;const store=experimentStore(root,{afterTransitionWrite:async name=>{if(name===boundary&&!crashed){crashed=true;throw Error('INJECTED:'+name);}}});const plan=await store.create(baseline,candidate,{guard,phase:kind==='rollback'?'rollback':'forward'});
  const count=kind==='insufficient_evidence'?30:20;
  for(let i=0;i<count;i++){const anchor=OriginalDate.parse('2026-01-01T17:45:00Z')/1000+i*86400;now=(anchor+120)*1000;const r=await store.register({slot_id:'slot-'+i,anchor_time:anchor},baseline,{guard});await fs.writeFile(path.join(r.dir,'frozen.json'),JSON.stringify({official_run_id:'control-'+i,candidate_run_id:'candidate-'+i,candidate_input_hash:'SYNTHETIC'}));await attemptStart(root,'candidate-'+i,new OriginalDate(now+2000).toISOString());}
  now+=86400000;const readMetrics=async(id)=>({valid:true,timely:true,complete:kind!=='insufficient_evidence',path_loss:id.startsWith('control')?2:kind==='reject'?3:1.8,brier:.3});
  await assert.rejects(()=>store.review({guard,readMetrics}),/INJECTED/);assert.equal(crashed,true);
  const txFile=path.join(root,'m1-experiments/transition.json'),tx=JSON.parse(await fs.readFile(txFile));const decisionBytes=JSON.stringify(tx.decision);
  if(boundary!=='completed'){await assert.rejects(()=>effectivePolicy(root,baseline),/TRANSITION_PENDING/);await assert.rejects(()=>store.active(),/TRANSITION_PENDING/);}
  const resumed=experimentStore(root);if(boundary!=='completed')await resumed.review({guard,readMetrics:async()=>{throw Error('MUST_NOT_RESCORE');}});assert.equal(await resumed.recoverTransition({guard}),null);
  const final=JSON.parse(await fs.readFile(txFile));assert.equal(final.status,'completed');assert.equal(JSON.stringify(final.decision),decisionBytes);assert.equal(final.decision.decision,kind==='rollback'?'promote':kind);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(path.join(root,'m1-experiments',plan.id,'decision.json')))),decisionBytes);
  const dirs=(await fs.readdir(path.join(root,'m1-experiments'),{withFileTypes:true})).filter(x=>x.isDirectory());assert.equal(dirs.length,kind==='promote'?2:1);
  const active=await resumed.active();assert.equal(active?.id??null,tx.rollback?.id??null);now++;assert.deepEqual(await effectivePolicy(root,baseline),['promote','rollback'].includes(kind)?candidate:baseline);
 }
});

test('resumed transition refuses changed immutable decision and lost guard',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-transition-conflict-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const guard=async()=>{},store=experimentStore(root),plan=await store.create({feedback:'F0'},{feedback:'F1'},{guard});
 const decision={decision:'reject',experiment_id:plan.id,production_config:plan.control},dir=path.join(root,'m1-experiments');
 const {digest,canonical}=await import('../scripts/m1-files.mjs');await fs.writeFile(path.join(dir,'transition.json'),JSON.stringify({schema:'MFV:EXPERIMENT_TRANSITION:v1',status:'pending',plan_hash:digest(canonical(plan)),decision,policy:{},active:{},rollback:null}));
 await assert.rejects(()=>store.recoverTransition({guard:async()=>{throw Error('LOCK_LOST');}}),/LOCK_LOST/);
 await fs.writeFile(path.join(dir,plan.id,'decision.json'),JSON.stringify({...decision,decision:'promote'}));await assert.rejects(()=>store.recoverTransition({guard}),/TRANSITION_CONFLICT/);
});

async function attemptStart(root,id,at,executed=true){const dir=path.join(root,'m1-candidates',id,'attempt-001');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'started.json'),JSON.stringify({schema:'MFV:M1_ATTEMPT_START:v1',run_id:id,attempt_id:'attempt-001',input_sha256:'SYNTHETIC',started_at:at}));if(executed){const{digest}=await import('../scripts/m1-files.mjs');await fs.writeFile(path.join(dir,'execution-started.json'),JSON.stringify({schema:'MFV:EXECUTION_START:v1',run_id:id,attempt_id:'attempt-001',input_sha256:'SYNTHETIC',reservation_sha256:digest(await fs.readFile(path.join(dir,'started.json'))),mode:'managed_process',started_at:at,process:{pid:1234,identity:'SYNTHETIC'}}));}}

test('registration, frozen candidate, budget skip and actual interrupted attempt have distinct counts',async t=>{
 const OriginalDate=Date;let now=OriginalDate.parse('2026-01-01T00:00:00Z');globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};t.after(()=>{globalThis.Date=OriginalDate;});
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-start-count-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=experimentStore(root),guard=async()=>{};await store.create({feedback:'F0'},{feedback:'F1'},{guard});
 for(let i=0;i<30;i++){const anchor=OriginalDate.parse('2026-01-01T17:45:00Z')/1000+i*86400;now=(anchor+120)*1000;const r=await store.register({slot_id:'slot-'+i,anchor_time:anchor},{feedback:'F0'},{guard});
  if(i>0)await fs.writeFile(path.join(r.dir,'frozen.json'),JSON.stringify({official_run_id:'control-'+i,candidate_run_id:'candidate-'+i,candidate_input_hash:'SYNTHETIC'}));
  if(i>=2)await attemptStart(root,'candidate-'+i,new OriginalDate(now+2000).toISOString(),i!==2);
  if(i===2)await fs.writeFile(path.join(root,'m1-candidates','candidate-'+i,'attempt-001/receipt.json'),JSON.stringify({execution_mode:'not_started_budget'}));
  await store.finish(r,{started:true,candidate_status:'synthetic_legacy_flag_must_not_count'});
 }
 now+=86400000;
 const result=await store.review({guard,readMetrics:async()=>null});assert.equal(result.decision,'insufficient_evidence');assert.equal(result.registered,30);assert.equal(result.finished,30);assert.equal(result.started,27);assert.equal(result.complete_pairs,0);
});

test('policy change pauses the experiment before any slot registration or scoring and preserves originals',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-policy-pause-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const guard=async()=>{},store=experimentStore(root),control={model:'SYNTHETIC',additional_inputs:'none',feedback:'F0'},plan=await store.create(control,{...control,feedback:'F1'},{guard});
 const file=path.join(root,'m1-experiments',plan.id,'plan.json'),before=await fs.readFile(file);
 assert.equal(await store.register({slot_id:'off-calendar',anchor_time:0},{...control,additional_inputs:'calendar'},{guard}),null);
 assert.equal(await store.active(),null);assert.equal(await store.paused(),true);const state=await fs.readFile(path.join(root,'m1-experiments/active.json'));
 assert.equal(await store.register({slot_id:'retry',anchor_time:0},control,{guard}),null);
 assert.equal(await store.review({policy:control,guard,readMetrics:async()=>{throw Error('must not score');}}),null);
 assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readFile(path.join(root,'m1-experiments/active.json')),state);
 await assert.rejects(()=>fs.stat(path.join(root,'m1-experiments',plan.id,'opportunities')),/ENOENT/);
 await assert.rejects(()=>store.create(control,{...control,additional_inputs:'calendar'},{guard,factor:'input'}),/EXPERIMENT_PAUSED/);
 await fs.mkdir(path.join(root,'other'));const other=experimentStore(path.join(root,'other'));const next=await other.create(control,{...control,additional_inputs:'calendar'},{guard,factor:'input'});
 const decision=await other.review({policy:{...control,model:'SYNTHETIC_NEW'},guard,readMetrics:async()=>{throw Error('must not score');}});
 assert.equal(decision.decision,'paused_version_changed');assert.equal(decision.id,next.id);
});

test('changed approved generation uses release baseline without erasing prior policy evidence; corruption still fails',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-policy-baseline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {atomic,digest,canonical}=await import('../scripts/m1-files.mjs');const baseline={model:'new',predictor_version:'new',reasoning_effort:'medium',additional_inputs:'none',feedback:'F0',lambda:0},old={...baseline,model:'old',feedback:'F1'},id='11111111-1111-1111-1111-111111111111';
 const decision={production_config:old};await atomic(root,path.join(root,'m1-experiments',id,'decision.json'),decision);
 const file=path.join(root,'m1-learning/production-policy.json');await atomic(root,file,{schema:'MFV:PRODUCTION_POLICY:v1',decision_id:id,decision_hash:digest(canonical(decision)),policy:old,effective_after:'2020-01-01T00:00:00Z'});const before=await fs.readFile(file);
 assert.deepEqual(await effectivePolicy(root,baseline),baseline);assert.deepEqual(await fs.readFile(file),before);
 await atomic(root,path.join(root,'m1-experiments',id,'decision.json'),{production_config:baseline});await assert.rejects(()=>effectivePolicy(root,baseline),/POLICY_DECISION_CHANGED/);
});
