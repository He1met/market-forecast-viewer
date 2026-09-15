import test from'node:test';import assert from'node:assert/strict';import{brier,pathLoss,mainScenario,baseRate,feedback,shrink,fitLambda}from'../scripts/m1-learning.mjs';
test('feedback skips zero scale and single observations with explicit insufficient evidence',()=>{
 const cases=Array.from({length:3},(_,i)=>({id:String(i),eligible:true,start_time:i*86400,end_time:(i+1)*86400,opportunity_id:String(i),available_at:new Date((i+1)*86400*1000).toISOString(),revision_id:String(i),features:{constant:100,missing:null}}));
 const cutoff='1970-01-05T00:00:00.000Z';
 for(const sample of [[],cases.slice(0,1),cases]){
  const packet=feedback(sample,{constant:101,missing:1},cutoff),body=JSON.parse(packet.body);
  assert.deepEqual(packet.case_ids,[]);assert.equal(body.reason,'insufficient_nonzero_scale');assert.equal(body.usable_dimension_count,0);assert.ok(packet.bytes<=8192);
 }
});
test('feedback ignores constant dimensions and remains invariant to feature units',()=>{
 const cases=Array.from({length:3},(_,i)=>({id:String(i),eligible:true,start_time:i*86400,end_time:(i+1)*86400,opportunity_id:String(i),available_at:new Date((i+1)*86400*1000).toISOString(),revision_id:String(i),features:{x:i*2,constant:100}}));
 const cutoff='1970-01-05T00:00:00.000Z',a=feedback(cases,{x:3,constant:1e9},cutoff),b=feedback(cases.map(c=>({...c,features:{x:c.features.x*1000,constant:-7}})),{x:3000,constant:0},cutoff);
 assert.deepEqual(a.case_ids,b.case_ids);const body=JSON.parse(a.body),converted=JSON.parse(b.body);for(let i=0;i<body.cases.length;i++)assert.ok(Math.abs(body.cases[i].distance-converted.cases[i].distance)<1e-12);assert.deepEqual(a.case_ids,['1','2','0']);assert.equal(body.usable_dimension_count,1);assert.ok(Math.abs(body.cases[0].distance-Math.sqrt(3/8))<1e-12);
 assert.deepEqual(a,feedback([...cases,{...cases[0],id:'future',available_at:'1970-01-06T00:00:00.000Z',features:{x:100}}],{x:3,constant:1e9},cutoff));
});
test('independent hand-calculated Brier goldens and fixed main path',()=>{assert.equal(brier([1,0,0,0,0,0],'surge_reversal'),0);assert.equal(brier([1,0,0,0,0,0],'dip_rebound'),2);const p=[.6,.1,.1,.1,.05,.05];assert.ok(Math.abs(brier(p,'surge_reversal')-.195)<1e-12);assert.ok(Math.abs(brier(p,'dip_rebound')-1.195)<1e-12);assert.equal(mainScenario([.5,.5,0,0,0,0]),'surge_reversal');assert.equal(pathLoss(Array(96).fill(102),Array(96).fill(100),100),2);assert.throws(()=>pathLoss([100],[100],100));});
test('historical availability and overlapping opportunities cannot contaminate rates or frozen feedback',()=>{const cases=Array.from({length:3},(_,i)=>({id:String(i),eligible:true,start_time:100+i*86400,end_time:100+(i+1)*86400,opportunity_id:String(i),available_at:new Date((100+(i+1)*86400)*1000).toISOString(),actual_category:'narrow',features:{x:i},revision_id:String(i)}));const cutoff=cases[1].available_at,a=baseRate(cases,cutoff);assert.equal(a.n,2);assert.deepEqual(a.counts,[0,0,0,0,2,0]);assert.deepEqual(baseRate([...cases,{...cases[0],id:'duplicate'}],cutoff),a);const f=feedback(cases,{x:1},cutoff);assert.deepEqual(feedback([...cases,{...cases[2],id:'future'}],{x:1},cutoff),f);assert.ok(f.bytes<=8192);assert.equal(fitLambda(cases,cutoff,{}).lambda,0);assert.deepEqual(shrink([1,0,0,0,0,0],a.probabilities,0),[1,0,0,0,0,0]);});

test('prospective experiment has one first-20 checkpoint and preserves failure denominator and 30 cap',async()=>{
 const {evaluateExperiment}=await import('../scripts/m1-learning.mjs');const plan={schema:'MFV:EXPERIMENT:v1',factor:'feedback',control:{feedback:'F0'},candidate:{feedback:'F1'}};
 const pairs=Array.from({length:20},(_,i)=>({id:String(i),anchor_time:100000+i*86400,registered_at:new Date((100000+i*86400)*1000).toISOString(),started:true,finished:true,complete:true,control:{valid:true,timely:true,started_at:new Date((100001+i*86400)*1000).toISOString(),path_loss:2,brier:.3},candidate:{valid:true,timely:true,started_at:new Date((100002+i*86400)*1000).toISOString(),path_loss:1.8,brier:.31}}));
 assert.equal(evaluateExperiment(plan,pairs.slice(0,19)).decision,'waiting');assert.equal(evaluateExperiment(plan,pairs).decision,'promote');
 const failed=Array.from({length:3},(_,i)=>({...pairs[0],id:'failed'+i,anchor_time:100000-(3-i)*86400,registered_at:new Date((100000-(3-i)*86400)*1000).toISOString(),complete:false,control:null,candidate:null}));
 const rejected=evaluateExperiment(plan,[...failed,...pairs]);assert.equal(rejected.decision,'reject');assert.equal(rejected.registered,23);assert.equal(rejected.started,23);assert.equal(rejected.timely_valid_rate,20/23);
 const late=[];for(let i=0;i<31;i++)late.push({...pairs[i%20],id:String(i),anchor_time:100000+i*86400,registered_at:new Date((100000+i*86400)*1000).toISOString(),complete:i>=11,control:{...pairs[0].control,started_at:new Date((100001+i*86400)*1000).toISOString()},candidate:{...pairs[0].candidate,started_at:new Date((100002+i*86400)*1000).toISOString()}});
 assert.equal(evaluateExperiment(plan,late).decision,'insufficient_evidence');
 const guard=pairs.map(p=>({...p,candidate:{...p.candidate,brier:.321}}));assert.equal(evaluateExperiment(plan,guard).decision,'reject');
 assert.throws(()=>evaluateExperiment({...plan,candidate:{feedback:'F1',lambda:.1}},pairs),/SINGLE_FACTOR/);
});
