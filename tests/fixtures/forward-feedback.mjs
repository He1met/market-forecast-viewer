// Synthetic clocks and outputs; actual archive, scoring and decision implementations.
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
export async function withFeedbackFixture({codeRoot,dataRoot,fixtureRoot},callback){
 await fs.mkdir(dataRoot,{recursive:true});
 const load=name=>import(pathToFileURL(path.join(codeRoot,name)).href);
 const {seal}=await load('src/contracts.ts'),{newRun,freezeInput,prepareAttempt,completeAttempt,publishRun}=await load('scripts/m1-archive.mjs');
 const {experimentStore}=await load('scripts/m1-experiments.mjs'),{readExperimentMetrics}=await load('scripts/m1-experiment-proof.mjs');
 const {createDisplayReader}=await load('scripts/m1-display.mjs'),{createOutcomeStore}=await load('scripts/m1-outcome-store.mjs'),{caseStore}=await load('scripts/m1-cases.mjs');
 const {atomic,digest,canonical}=await load('scripts/m1-files.mjs');
 const templateId='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011',folder=path.join(fixtureRoot,'forecast-runs',templateId);
 const template=JSON.parse(await fs.readFile(path.join(folder,'input.json'))),schema=JSON.parse(await fs.readFile(path.join(folder,'output-schema.json'))),raw=JSON.parse(await fs.readFile(path.join(folder,'attempt-001/raw-output.json')));
 const RealDate=Date,oldData=process.env.MFV_DATA_ROOT;let now=RealDate.parse('2026-07-01T00:00:00Z');
 globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};process.env.MFV_DATA_ROOT=dataRoot;
 try{
  const guard=async()=>{},store=experimentStore(dataRoot),baseline={predictor_version:'SYNTHETIC',model:'SYNTHETIC',reasoning_effort:'medium',feedback:'F0',lambda:0,additional_inputs:'none'};
  const plan=await store.create(baseline,{...baseline,feedback:'F1'},{guard}),pairs=[];
  const provenance={code_sha256:Object.fromEntries(await Promise.all(['src/contracts.ts','src/m1-contracts.ts','src/m1-evaluation.ts'].map(async f=>[f,digest(await fs.readFile(path.join(codeRoot,f)))])))};
  const learning=policy=>({predictor_identity:{model:policy.model,reasoning_effort:policy.reasoning_effort,predictor_version:policy.predictor_version,additional_inputs:policy.additional_inputs,feedback:policy.feedback},feedback_mode:policy.feedback,lambda:0,base:{probabilities:Array(6).fill(1/6)},feedback:policy.feedback==='F1'?{body:'SYNTHETIC historical feedback'}:null});
  for(let day=0;day<20;day++){
   const anchor=RealDate.parse('2026-07-01T17:45:00Z')/1000+day*86400;now=(anchor+120)*1000;
   const registration=await store.register({slot_id:'SYNTHETIC-'+day,anchor_time:anchor},baseline,{guard});
   const input=structuredClone(template),history=input.history,shift=anchor-input.anchor_time;
   history.start_time+=shift;history.end_time=anchor;history.downloaded_at=new Date().toISOString();history.candles=history.candles.map(c=>({...c,open_time:c.open_time+shift,close_time:c.close_time+shift}));
   history.source.request.requested_start_time=history.start_time;history.source.request.requested_end_time=anchor;history.source.raw_responses=[];
   const rows=history.candles.toReversed().map(c=>[String(c.open_time*1000),...[c.open,c.high,c.low,c.close,c.volume_contracts,c.volume_base,c.volume_quote].map(String),'1']);let after;
   for(let j=0;j<rows.length;j+=300){const ref='data-source/SYNTHETIC-FORWARD-'+day+'/page-'+j+'.json',page=rows.slice(j,j+300);await atomic(dataRoot,path.join(dataRoot,ref),{code:'0',msg:'SYNTHETIC',data:page});history.source.raw_responses.push({path:'artifacts/'+ref,sha256:digest(await fs.readFile(path.join(dataRoot,ref))),requested_at:new Date().toISOString(),params:{instId:'BTC-USDT-SWAP',bar:'15m',limit:300,...(after?{after}:{})},response_code:'0'});after=page.at(-1)[0];}
   delete history.dataset_id;delete history.content_sha256;input.history=await seal(history);input.anchor_time=anchor;input.events.information_cutoff=new Date().toISOString();input.model_context.learning=learning(baseline);
   now+=1000;const official=await newRun(path.join(dataRoot,'forecast-runs'));await freezeInput(official.runDir,input,'SYNTHETIC feedback forward',schema,provenance);
   const candidate=await store.freezeCandidate(registration,official,{guard,learningBuilder:async()=>learning(plan.candidate)});
   for(const [run,role] of [[official,'production'],[candidate,'candidate']]){
    now+=1000;const attempt=await prepareAttempt(run.runDir);await fs.writeFile(attempt.rawFile,JSON.stringify({...raw,anchor_time:anchor}));
    if(role==='candidate'){
     const startFile=path.join(run.runDir,attempt.attempt_id,'started.json'),start=JSON.parse(await fs.readFile(startFile));
     await atomic(dataRoot,path.join(run.runDir,attempt.attempt_id,'execution-started.json'),{schema:'MFV:EXECUTION_START:v1',run_id:run.run_id,attempt_id:attempt.attempt_id,input_sha256:start.input_sha256,reservation_sha256:digest(await fs.readFile(startFile)),mode:'managed_process',started_at:new Date().toISOString(),process:{pid:process.pid,identity:'SYNTHETIC output injection; no model process'}});
    }
    await completeAttempt(run.runDir,attempt.attempt_id,{exit_code:0,model_config:{provider:'official_codex',selection:'existing_local_cli_configuration',cli_version:'codex-cli 0.0.0',auth_method:'chatgpt_verified',sandbox:'read-only',output_schema:true,startup_warning_count:0},model_identity:null,model_identity_visibility:'not_exposed_by_jsonl'});await publishRun(run.runDir,attempt.rawFile,{attempt_id:attempt.attempt_id});
   }
   await store.finish(registration,{candidate_status:'published',candidate_invoked:true});
   now=(anchor+86400+180)*1000;
   const scored={};for(const [run,role] of [[official,'production'],[candidate,'candidate']]){
    const runsRoot=path.dirname(run.runDir),reader=createDisplayReader({root:codeRoot,dataRoot,runsRoot}),outcomes=createOutcomeStore({root:codeRoot,dataRoot,runsRoot}),published=await reader.readRun(run.run_id,{includeEvaluation:false});
    const capture=await outcomes.capture(published,{transport:async({file})=>{await fs.writeFile(file,JSON.stringify({code:'0',data:Array.from({length:96},(_,i)=>[String((anchor+i*900)*1000),...Array(4).fill(String(input.anchor_price)),'10','1','100','1']).reverse()}));return '200';}});
    if(capture.status!=='ok')throw Error('SYNTHETIC_FORWARD_CAPTURE_FAILED');scored[role]=await outcomes.evaluateCapture(published,capture.capture_id);
   }
   pairs.push({official,candidate,scored,registration});
  }
  const decision=await store.review({guard,policy:baseline,readMetrics:(id,role)=>readExperimentMetrics({codeRoot,dataRoot},id,role)});
  if(decision.decision!=='reject'||decision.complete_pairs!==20)throw Error('SYNTHETIC_FORWARD_DECISION_FAILED:'+JSON.stringify(decision));
  now+=86400000;
  const last=pairs.at(-1),fresh=await caseStore({codeRoot,dataRoot}).create(last.official.run_id,last.scored.production.revision_id);
  return await callback({store,plan,decision,baseline,pairs,fresh,guard,advance:ms=>{now+=ms;},digest,canonical});
 }finally{globalThis.Date=RealDate;if(oldData===undefined)delete process.env.MFV_DATA_ROOT;else process.env.MFV_DATA_ROOT=oldData;}
}
