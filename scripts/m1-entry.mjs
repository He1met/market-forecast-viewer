import {learningArguments} from './m1-admin-args.mjs';
import {assertInstallationSettled} from './m1-files.mjs';
import {notificationSummary} from './m1-notifications.mjs';
import {doctor,doctorExitCode} from './m1-doctor.mjs';
import {scoreOldForecasts} from './m1-ops.mjs';
import {capacitySnapshot,requireCapacity} from './m1-capacity.mjs';
import {setForecastPaused,disableLearning} from './m1-admin.mjs';
import fs from'node:fs/promises';import path from'node:path';import{fileURLToPath}from'node:url';import{validateInstallation,readJson,writeOnce,atomic,check,exists}from'./m1-files.mjs';import{verifyPackage}from'./m1-package.mjs';import{serve}from'./m1-server.mjs';import{cycle}from'./m1-cycle.mjs';import{prepareForecast}from'./m1-input.mjs';import{generateInstalled,generateCandidate}from'./m1-model.mjs';import{createDisplayReader}from'./m1-display.mjs';import{projectionStore}from'./m1-index.mjs';import{ops}from'./m1-ops.mjs';import{backup,restore}from'./m1-backup.mjs';import{replayRestored}from'./m1-restore-replay.mjs';import{caseStore}from'./m1-cases.mjs';import{collectCalendar,collectDerivatives}from'./m1-public-data.mjs';import{experimentStore,effectivePolicy}from'./m1-experiments.mjs';import{supplementary}from'./m1-supplementary.mjs';import{startService,serviceStatus}from'./m1-service.mjs';
export async function entry(command,home,releaseId,args=[]){
 await assertInstallationSettled(home);
 if(command==='learning')learningArguments(args);
 else check(args.length===0||(command==='doctor'&&args.length===1&&args[0]==='--full-audit'),'ENTRY_ARGUMENTS_INVALID');
 const codeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),config=await validateInstallation(path.join(home,'installation.local.json'));process.env.MFV_DATA_ROOT=config.data_root;process.env.MFV_RUNTIME_HOME=home;
 const manifest=await verifyPackage(codeRoot);check(manifest.release_id===releaseId,'PINNED_RELEASE_MISMATCH');
 const policy=manifest.policy.policy;
 const readCapacity=()=>capacitySnapshot(config.data_root,{policy:config.capacity});
 const approval=await readJson(home,path.join(home,'approvals',releaseId+'.json'));check(manifest.synthetic!==true&&approval.schema==='MFV:MAINTAINER_APPROVAL:v1'&&approval.release_id===releaseId&&approval.build_sha===manifest.build_sha&&approval.approved===true&&/^https:\/\/github\.com\/He1met\/market-forecast-viewer\/(?:pull|issues)\//.test(approval.source_url)&&Number.isFinite(Date.parse(approval.approved_at)),'RELEASE_NOT_APPROVED');
 if(command==='learning')return disableLearning({runtimeHome:home,dataRoot:config.data_root,port:config.mutex_port,releaseId,...learningArguments(args)});
 if(['pause','resume'].includes(command))return setForecastPaused({runtimeHome:home,releaseId,paused:command==='pause'});
 const readForecastControl=async()=>{const fresh=await validateInstallation(path.join(home,'installation.local.json'));check(fresh.data_root===config.data_root&&fresh.mutex_port===config.mutex_port,'INSTALLATION_CHANGED');return{paused:fresh.forecast_paused!==false,expectedSince:fresh.forecast_expected_since??null};};
 if(command==='notifications')return notificationSummary(config.data_root);
 if(command==='doctor')return doctor({codeRoot,config,manifest,fullAudit:args[0]==='--full-audit'});
 if(command==='serve')return serve({codeRoot,dataRoot:config.data_root,port:config.http_port,readStatusOptions:async()=>{const current=await validateInstallation(path.join(home,'installation.local.json'));check(current.data_root===config.data_root,'STATUS_DATA_ROOT_CHANGED');return{paused:current.forecast_paused!==false,opsPaused:current.ops_paused!==false,expectedSince:current.forecast_expected_since??null};}});
 if(command==='ops'){const service=await serviceStatus({runtimeHome:home,port:config.http_port});if(service.status==='exited'&&config.service_paused===false)await startService({runtimeHome:home,port:config.http_port,releaseId,paused:false,automatic:true});return ops({codeRoot,dataRoot:config.data_root,port:config.mutex_port,releaseId,policy:policy,capacityPolicy:config.capacity,paused:config.ops_paused!==false,readForecastControl,forecastPaused:config.forecast_paused!==false,expectedSince:config.forecast_expected_since??null,refreshInputs:async({signal})=>{await collectDerivatives(config.data_root,{signal});await collectCalendar(config.data_root,{signal});}});}
 if(command==='backup'){
  requireCapacity(await readCapacity());
  const localDay=new Date(Date.now()+8*3600000),date=localDay.toISOString().slice(0,10),result=await backup({dataRoot:config.data_root,runtimeHome:home,target:config.backup.target,deviceId:config.backup.device_id,minimumFreeBytes:Math.max(config.backup.minimum_free_bytes??0,(await readCapacity()).policy.reserve_bytes),port:config.mutex_port,releaseId,slotKey:'daily:'+date});
  if(result.status!=='completed')return result;
  const checksRoot=path.join(config.backup.target,'restore-checks');await fs.mkdir(checksRoot,{recursive:true});
  const pending=path.join(checksRoot,'pending.json');let checkState=await exists(pending)?await readJson(config.backup.target,pending):null;
  if(!checkState&&localDay.getUTCDay()===0){checkState={backup_id:result.manifest.id};await writeOnce(config.backup.target,pending,checkState);}
  if(checkState){const destination=path.join(checksRoot,checkState.backup_id),restored=await restore({target:config.backup.target,manifestFile:path.join(config.backup.target,'manifests',checkState.backup_id+'.json'),destination,resume:await exists(destination),maxMs:90000,maxFiles:2000,verify:async restoredRoot=>{
   const old=process.env.MFV_DATA_ROOT;process.env.MFV_DATA_ROOT=restoredRoot;try{return await replayRestored({codeRoot,dataRoot:restoredRoot});}finally{if(old===undefined)delete process.env.MFV_DATA_ROOT;else process.env.MFV_DATA_ROOT=old;}
  }});if(restored.schema==='MFV:RESTORE:v1'){await fs.unlink(pending);}return{...result,restore_check:restored};}return result;
 }
 check(command==='forecast','COMMAND_INVALID');return cycle({dataRoot:config.data_root,releaseId,mutexPort:config.mutex_port,paused:config.forecast_paused!==false,trigger:process.env.MFV_TRIGGER??'manual',
 readPaused:async()=> (await readForecastControl()).paused,
 readCapacity,
 scoreOld:options=>scoreOldForecasts({codeRoot,dataRoot:config.data_root,...options}),
 resolvePolicy:async({mutex})=>{await mutex.guard();return effectivePolicy(config.data_root,policy);},
 freeze:async({slot,signal,deadline,policy})=>{const events=path.join(config.data_root,'m1-calendar','market-only-'+slot.slot_id+'.json');if(!await exists(events))await writeOnce(config.data_root,events,{schema:'MFV:M1_EVENTS:v1',mode:'market_only',information_cutoff:new Date().toISOString(),sources:[],items:[],limitations:['未纳入事件风险']});return prepareForecast(events,{anchorTime:slot.anchor_time,signal,deadline,supplementaryBuilder:args=>supplementary(config.data_root,{...args,policy:policy}),learningBuilder:(features,cutoff)=>caseStore({codeRoot,dataRoot:config.data_root}).freeze(features,cutoff,policy)});},
 registerOpportunity:async(slot,options)=>(await caseStore({codeRoot,dataRoot:config.data_root}).controls()).learning_disabled?null:experimentStore(config.data_root).register(slot,options.policy,options),
 prepareCandidate:(registration,input,options)=>experimentStore(config.data_root).freezeCandidate(registration,input,{...options,learningBuilder:(features,cutoff,policy)=>caseStore({codeRoot,dataRoot:config.data_root}).freeze(features,cutoff,policy)}),
 runCandidate:generateCandidate,finishOpportunity:(registration,result)=>experimentStore(config.data_root).finish(registration,result),
 generate:async(prepared,options)=>{await caseStore({codeRoot,dataRoot:config.data_root}).recordFirstDisabledRun(prepared.run_id);return generateInstalled(prepared,options);},publishIndex:({mutex,deadline})=>projectionStore(config.data_root).update(createDisplayReader({root:codeRoot,dataRoot:config.data_root}),{limit:16,guard:mutex.guard,deadline})});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){entry(process.argv[2],process.argv[3],process.argv[4],process.argv.slice(5)).then(result=>{if(process.argv[2]!=='serve')console.log(JSON.stringify(result));if(process.argv[2]==='doctor')process.exitCode=doctorExitCode(result);}).catch(e=>{console.error(e.message);process.exitCode=1;});}
