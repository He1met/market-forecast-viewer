import{canonical,digest,check}from'./m1-files.mjs';
export const categories=['surge_reversal','dip_rebound','uptrend','downtrend','narrow','other'];
export const lambdas=[0,.1,.25,.5];
const time=x=>Date.parse(x),mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
export function probabilities(p){check(Array.isArray(p)&&p.length===6&&p.every(x=>Number.isFinite(x)&&x>=0&&x<=1)&&Math.abs(p.reduce((s,x)=>s+x,0)-1)<1e-8,'PROBABILITY_INVALID');return p;}
export function brier(p,actual){probabilities(p);check(categories.includes(actual),'CATEGORY_INVALID');return p.reduce((s,x,i)=>s+(x-Number(categories[i]===actual))**2,0);}
export function mainScenario(p){probabilities(p);return categories[p.indexOf(Math.max(...p))];}
export function pathLoss(prices,actual,anchor){check(prices.length===96&&actual.length===96&&[...prices,...actual,anchor].every(x=>Number.isFinite(x)&&x>0),'COMPLETE_PATH_REQUIRED');return mean(prices.map((x,i)=>Math.abs(x-actual[i])))/anchor*100;}
export function nonoverlap(cases,cutoff,{limit=90,compatible=()=>true}={}){
 const available=cases.filter(c=>c.eligible===true&&time(c.available_at)<=time(cutoff)&&c.end_time*1000<=time(cutoff)&&compatible(c)).sort((a,b)=>a.start_time-b.start_time||a.id.localeCompare(b.id));
 const selected=[],seen=new Set();let end=-Infinity;
 for(const c of available){if(c.start_time<end||seen.has(c.opportunity_id))continue;selected.push(c);end=c.end_time;seen.add(c.opportunity_id);}return selected.slice(-limit);
}
export function baseRate(cases,cutoff,options){const sample=nonoverlap(cases,cutoff,options),counts=categories.map(k=>sample.filter(c=>c.actual_category===k).length);check(counts.reduce((s,x)=>s+x,0)===sample.length,'CASE_CATEGORY_INVALID');return{schema:'MFV:BASE_RATE:v1',version:'chronological-nonoverlap-laplace-v1',cutoff,sample_ids:sample.map(c=>c.id),counts,n:sample.length,probabilities:counts.map(x=>(x+1)/(sample.length+6))};}
export function shrink(raw,base,lambda){probabilities(raw);probabilities(base);check(lambdas.includes(lambda),'LAMBDA_INVALID');return raw.map((p,i)=>(1-lambda)*p+lambda*base[i]);}
export function fitLambda(cases,cutoff,identity){const sample=nonoverlap(cases,cutoff,{compatible:c=>canonical(c.predictor_identity)===canonical(identity)&&c.frozen_base?.version==='chronological-nonoverlap-laplace-v1'&&time(c.frozen_base.cutoff)<=time(c.frozen_at)});if(sample.length<20)return{lambda:0,reason:'insufficient_training',n:sample.length};const scores=lambdas.map(lambda=>({lambda,loss:mean(sample.map(c=>brier(shrink(c.raw_probabilities,c.frozen_base.probabilities,lambda),c.actual_category)))}));scores.sort((a,b)=>a.loss-b.loss||a.lambda-b.lambda);return{lambda:scores[0].lambda,reason:'past_training_only_requires_forward_validation',n:sample.length,scores,sample_ids:sample.map(c=>c.id)};}
export function numericFeatures(value,prefix='',out={}){for(const[k,v]of Object.entries(value??{})){const name=prefix?prefix+'.'+k:k;if(v&&typeof v==='object'&&!Array.isArray(v))numericFeatures(v,name,out);else if(Number.isFinite(v))out[name]=v;}return out;}
export function feedback(cases,features,cutoff){
 features=numericFeatures(features);cases=cases.map(c=>({...c,features:numericFeatures(c.features)}));
 const past=nonoverlap(cases,cutoff,{limit:Number.MAX_SAFE_INTEGER});const keys=Object.keys(features).filter(k=>Number.isFinite(features[k])).sort();const scales={};
 for(const k of keys){const a=past.map(c=>c.features[k]).filter(Number.isFinite);if(a.length<2)continue;const m=mean(a),sd=Math.sqrt(mean(a.map(x=>(x-m)**2)));if(Number.isFinite(sd)&&sd>0)scales[k]=sd;}
 const ranked=past.map(c=>{const keys=Object.keys(scales).filter(k=>Number.isFinite(c.features[k]));return{c,distance:keys.length?Math.sqrt(mean(keys.map(k=>((c.features[k]-features[k])/scales[k])**2))):Infinity};}).filter(x=>Number.isFinite(x.distance)).sort((a,b)=>a.distance-b.distance||a.c.id.localeCompare(b.c.id));
 const summary={builder:'numeric-similarity-v2-skip-zero-scale',eligible_history_count:past.length,usable_dimension_count:Object.keys(scales).length};
 const chosen=[];let body='';for(const {c,distance}of ranked){if(chosen.length===4)break;const item={id:c.id,revision:c.revision_id,distance,actual_category:c.actual_category,main_scenario:c.main_scenario,path_loss:c.path_loss,brier:c.brier,diagnostics:c.diagnostics??[]};const next=JSON.stringify({...summary,reason:'selected',cases:[...chosen,item]});if(Buffer.byteLength(next)>8192)continue;chosen.push(item);body=next;}
 body ||= JSON.stringify({...summary,reason:!Object.keys(scales).length?'insufficient_nonzero_scale':!ranked.length?'no_comparable_cases':'feedback_size_limit',cases:[]});return{schema:'MFV:FEEDBACK:v1',cutoff,case_ids:chosen.map(x=>x.id),revisions:chosen.map(x=>x.revision),body,sha256:digest(body),bytes:Buffer.byteLength(body)};
}
/** Evidence verifier is mandatory and reruns the corresponding scorer before case creation. */
export async function makeCase(run,revision,{verify,disabledScorers=[],revokedRevisions=[],committedAt=new Date().toISOString()}){
 check(typeof verify==='function','CASE_VERIFIER_REQUIRED');const verified=await verify(run,revision);check(verified?.hash_chain===true&&verified.recomputed_equal===true,'CASE_CHAIN_UNVERIFIED');
 check(!disabledScorers.includes(verified.scorer)&&!revokedRevisions.includes(revision.revision_id),'CASE_REVOKED');check(run.forecast.status==='valid'&&revision.result.windows.h24.status==='mature'&&revision.result.windows.h24.observed_count===96,'CASE_INELIGIBLE');
 const available_at=new Date(Math.max(time(committedAt),time(revision.result.evaluated_at),time(verified.sources_available_at))).toISOString();check(Number.isFinite(time(available_at)),'CASE_TIME_UNKNOWN');
 return{schema:'MFV:M1_CASE:v1',id:digest(canonical({run_id:run.run_id,revision_id:revision.revision_id})),revision_id:revision.revision_id,eligible:true,available_at,scorer:verified.scorer,opportunity_id:`${run.history.instrument}:${run.forecast.anchor_time}`,start_time:run.forecast.anchor_time,end_time:run.forecast.anchor_time+86400,actual_category:revision.result.windows.h24.actual_category,brier:revision.result.windows.h24.brier_score,forecast_hash:run.hashes.forecast_sha256,source_revision_hash:verified.revision_hash};
}
export function evaluateExperiment(plan,opportunities){
 check(plan.schema==='MFV:EXPERIMENT:v1'&&['feedback','probability','input'].includes(plan.factor),'EXPERIMENT_INVALID');check([...new Set([...Object.keys(plan.control),...Object.keys(plan.candidate)])].filter(k=>canonical(plan.control[k])!==canonical(plan.candidate[k])).length===1,'SINGLE_FACTOR_REQUIRED');
 const ordered=opportunities.slice().sort((a,b)=>a.anchor_time-b.anchor_time);check(new Set(ordered.map(x=>x.id)).size===ordered.length,'DUPLICATE_OPPORTUNITY');let end=-Infinity;for(const o of ordered){check(o.anchor_time>=end&&(!plan.created_at||time(plan.created_at)<=time(o.registered_at))&&time(o.registered_at)<Math.min(time(o.control?.started_at??'9999-01-01'),time(o.candidate?.started_at??'9999-01-01')),'OPPORTUNITY_NOT_PROSPECTIVE');end=o.anchor_time+86400;}
 const bounded=ordered.filter(o=>o.finished).slice(0,30);
 const complete=bounded.filter(o=>o.started&&o.complete&&o.control.valid&&o.candidate.valid&&o.control.timely&&o.candidate.timely),finished=bounded;
 if(complete.length<20)return{decision:finished.length>=30?'insufficient_evidence':'waiting',complete_pairs:complete.length,finished:finished.length,registered:ordered.length,started:bounded.filter(o=>o.started).length};
 const pairs=complete.slice(0,20),checkpoint=bounded.slice(0,bounded.indexOf(pairs.at(-1))+1),started=checkpoint.filter(o=>o.started),valid=started.filter(o=>o.candidate?.valid&&o.candidate.timely),timely=started.length?valid.length/started.length:0;
 const metric=plan.factor==='probability'?'brier':'path_loss';const avg=(p,side,key)=>mean(p.map(x=>x[side][key]));
 const old=avg(pairs,'control',metric),now=avg(pairs,'candidate',metric);const improvement=old>0?(old-now)/old:null;
 const halves=[pairs.slice(0,10),pairs.slice(10)].every(p=>avg(p,'candidate',metric)<=avg(p,'control',metric));
 const guard=plan.factor==='probability'?avg(pairs,'candidate','path_loss')<=avg(pairs,'control','path_loss')*1.05:avg(pairs,'candidate','brier')-avg(pairs,'control','brier')<=.02;
 return{decision:improvement!==null&&improvement>=.05&&halves&&guard&&timely>=.9?'promote':'reject',complete_pairs:20,registered:checkpoint.length,started:started.length,finished:checkpoint.length,pair_ids:pairs.map(x=>x.id),primary:metric,improvement,halves_nonworse:halves,guard_passed:guard,timely_valid_rate:timely,once_only:true};
}
