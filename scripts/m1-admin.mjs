import {verifyTargetArchives,archiveSnapshot} from './m1-compatibility.mjs';
import fs from'node:fs/promises';import path from'node:path';import{randomUUID}from'node:crypto';import{pathToFileURL}from'node:url';import{readJson,writeOnce,atomic,exists,check,safePath,validateInstallation,readBytes}from'./m1-files.mjs';import{verifyPackage}from'./m1-package.mjs';import{businessMutex}from'./m1-mutex.mjs';import{stopService,serviceStatus,startService}from'./m1-service.mjs';
export async function stageRelease({packageRoot,runtimeHome}){const manifest=await verifyPackage(packageRoot);await fs.mkdir(runtimeHome,{recursive:true,mode:0o700});await safePath(runtimeHome,runtimeHome);const releases=path.join(runtimeHome,'releases');await fs.mkdir(releases,{recursive:true});const target=path.join(releases,manifest.release_id);if(await exists(target)){await verifyPackage(target);return{status:'already_staged',release_id:manifest.release_id};}const temp=path.join(releases,'.staging-'+randomUUID());await fs.cp(packageRoot,temp,{recursive:true,errorOnExist:true,force:false});await verifyPackage(temp);await fs.rename(temp,target);return{status:'staged',release_id:manifest.release_id,activated:false};}
export async function activate({runtimeHome,releaseId,approval,config,expectedCurrent=null}){
 check(/^[a-f0-9]{64}$/.test(releaseId),'RELEASE_ID_INVALID');const manifest=await verifyPackage(path.join(runtimeHome,'releases',releaseId));
 check(manifest.synthetic!==true,'SYNTHETIC_PACKAGE_CANNOT_ACTIVATE');
 check(approval.schema==='MFV:MAINTAINER_APPROVAL:v1'&&approval.release_id===releaseId&&approval.build_sha===manifest.build_sha&&approval.approved===true&&/^https:\/\/github\.com\/He1met\/market-forecast-viewer\/(?:pull|issues)\//.test(approval.source_url)&&Number.isFinite(Date.parse(approval.approved_at)),'EXACT_RELEASE_APPROVAL_REQUIRED');
 const checkFile=path.join(runtimeHome,'.installation-check-'+randomUUID()+'.json');await writeOnce(runtimeHome,checkFile,config);try{await validateInstallation(checkFile);}finally{await fs.unlink(checkFile);}
 check(config.runtime_home===runtimeHome&&config.forecast_paused===true&&config.ops_paused===true&&config.service_paused===true,'ACTIVATION_STARTS_PAUSED');
 const mutex=await businessMutex({dataRoot:config.data_root,port:config.mutex_port,releaseId,task:'admin'});check(mutex.status==='ACQUIRED',mutex.status);try{
 const service=await serviceStatus({runtimeHome,port:config.http_port});check(['not_started','exited'].includes(service.status),'STOP_OWNED_SERVICE_BEFORE_ACTIVATION');
 const previous=await exists(path.join(runtimeHome,'current.json'))?await readJson(runtimeHome,path.join(runtimeHome,'current.json')):null;
 if(expectedCurrent)check(JSON.stringify(previous)===JSON.stringify(expectedCurrent),'CURRENT_CHANGED_BEFORE_ROLLBACK');
 if(previous){const installed=await validateInstallation(path.join(runtimeHome,'installation.local.json'));check(installed.data_root===config.data_root&&installed.mutex_port===config.mutex_port,'INSTALLATION_CHANGED');check(installed.forecast_paused===true&&installed.ops_paused===true&&installed.service_paused===true,'PAUSE_BEFORE_ACTIVATION');}
 const compatibility=await verifyTargetArchives({packageRoot:path.join(runtimeHome,'releases',releaseId),dataRoot:config.data_root,releaseId});
 await mutex.guard();check((await archiveSnapshot(config.data_root)).sha256===compatibility.archive.sha256,'ARCHIVES_CHANGED_BEFORE_ACTIVATION');
 await writeOnce(runtimeHome,path.join(runtimeHome,'compatibility',randomUUID()+'.json'),compatibility);
 await writeOnce(runtimeHome,path.join(runtimeHome,'changes',randomUUID()+'.json'),{action:'activate',release_id:releaseId,previous,at:new Date().toISOString()});
 const approvalFile=path.join(runtimeHome,'approvals',releaseId+'.json');if(!await exists(approvalFile))await writeOnce(runtimeHome,approvalFile,approval);else check(JSON.stringify(await readJson(runtimeHome,approvalFile))===JSON.stringify(approval),'APPROVAL_ALREADY_DIFFERS');
 await atomic(runtimeHome,path.join(runtimeHome,'launch.mjs'),await readBytes(runtimeHome,path.join(runtimeHome,'releases',releaseId,'runtime/launch.mjs')));
 await atomic(runtimeHome,path.join(runtimeHome,'installation.local.json'),{...config,forecast_expected_since:null});await atomic(runtimeHome,path.join(runtimeHome,'current.json'),{schema:'MFV:CURRENT:v1',release_id:releaseId,build_sha:manifest.build_sha,previous_release_id:previous?.release_id??null,activated_at:new Date().toISOString()});return{status:'activated_paused',release_id:releaseId};
 }finally{await mutex.close();}
}
// The config rename commits pause state and its epoch together. Repeated resume
// preserves the epoch; an interrupted pre-commit intent cannot change it.
export async function setForecastPaused({runtimeHome,releaseId,paused,clock=()=>Date.now()}){
 check(typeof paused==='boolean','PAUSE_VALUE_INVALID');
 const file=path.join(runtimeHome,'installation.local.json'),before=await validateInstallation(file);
 const mutex=await businessMutex({dataRoot:before.data_root,port:before.mutex_port,releaseId,task:'admin'});
 check(mutex.status==='ACQUIRED',mutex.status);
 try{
  const config=await validateInstallation(file),current=await readJson(runtimeHome,path.join(runtimeHome,'current.json'));
  check(config.data_root===before.data_root&&config.mutex_port===before.mutex_port,'INSTALLATION_CHANGED');
  check(current.release_id===releaseId,'PINNED_RELEASE_MISMATCH');
  const at=new Date(clock()).toISOString(),oldEpoch=config.forecast_expected_since;
  const epoch=paused?null:config.forecast_paused===false&&Number.isFinite(Date.parse(oldEpoch))&&Date.parse(oldEpoch)<=Date.parse(at)?oldEpoch:at;
  const next={...config,forecast_paused:paused,forecast_expected_since:epoch};
  if(JSON.stringify(next)===JSON.stringify(config))return{status:'unchanged',forecast_paused:paused,forecast_expected_since:epoch};
  await writeOnce(runtimeHome,path.join(runtimeHome,'changes',randomUUID()+'.json'),{action:paused?'forecast_pause':'forecast_resume',phase:'intent',at,before:config,after:next});
  await mutex.guard();await atomic(runtimeHome,file,next);
  return{status:'applied',forecast_paused:paused,forecast_expected_since:epoch,official_task_changed:false};
 }finally{await mutex.close();}
}
export async function disableLearning({runtimeHome,dataRoot,port,releaseId,reason}){
 check(typeof reason==='string'&&reason.trim().length>0&&reason.length<=2000,'DISABLE_REASON_REQUIRED');
 check(typeof runtimeHome==='string'&&path.isAbsolute(runtimeHome),'RUNTIME_HOME_REQUIRED');
 const mutex=await businessMutex({dataRoot,port,releaseId,task:'admin'});check(mutex.status==='ACQUIRED',mutex.status);
 try{
  const config=await validateInstallation(path.join(runtimeHome,'installation.local.json')),current=await readJson(runtimeHome,path.join(runtimeHome,'current.json'));
  check(config.data_root===dataRoot&&config.mutex_port===port,'INSTALLATION_CHANGED');check(current.release_id===releaseId,'PINNED_RELEASE_MISMATCH');
  const file=path.join(dataRoot,'m1-learning/controls.json'),old=await exists(file)?await readJson(dataRoot,file):{disabled_scorers:[],revoked_revisions:[]};
  if(old.learning_disabled===true)return{status:'unchanged',controls:old};
  const next={...old,reason:reason.trim(),learning_disabled:true,effective_at:new Date().toISOString(),first_run_id:null};
  await writeOnce(dataRoot,path.join(dataRoot,'m1-learning/changes',randomUUID()+'.json'),{phase:'intent',controls:next});
  await mutex.guard();await atomic(dataRoot,file,next);return{status:'applied',controls:next};
 }finally{await mutex.close();}
}
export async function rollback({runtimeHome,releaseId}){const current=await readJson(runtimeHome,path.join(runtimeHome,'current.json'));check(current.previous_release_id,'NO_PREVIOUS_RELEASE');check(/^[a-f0-9]{64}$/.test(releaseId??'')&&releaseId===current.previous_release_id,'EXACT_PREVIOUS_RELEASE_REQUIRED');const approval=await readJson(runtimeHome,path.join(runtimeHome,'approvals',current.previous_release_id+'.json')),config=await readJson(runtimeHome,path.join(runtimeHome,'installation.local.json'));return activate({runtimeHome,releaseId,approval,expectedCurrent:current,config:{...config,forecast_paused:true,ops_paused:true,service_paused:true}});}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const command=process.argv[2];let result;
 if(command==='verify')result=await verifyPackage(path.resolve(process.argv[3]));
 else if(command==='stage')result=await stageRelease({packageRoot:path.resolve(process.argv[3]),runtimeHome:path.resolve(process.argv[4])});
 else if(command==='activate'){const runtimeHome=path.resolve(process.argv[3]),approvalPath=path.resolve(process.argv[5]),configPath=path.resolve(process.argv[6]);result=await activate({runtimeHome,releaseId:process.argv[4],approval:await readJson(path.dirname(approvalPath),approvalPath),config:await readJson(path.dirname(configPath),configPath)});}
 else if(command==='learning-disable'){const runtimeHome=path.resolve(process.argv[3]),config=await readJson(runtimeHome,path.join(runtimeHome,'installation.local.json')),current=await readJson(runtimeHome,path.join(runtimeHome,'current.json'));result=await disableLearning({runtimeHome,dataRoot:config.data_root,port:config.mutex_port,releaseId:current.release_id,reason:process.argv[4]});}
 else if(command==='rollback')result=await rollback({runtimeHome:path.resolve(process.argv[3]),releaseId:process.argv[4]});
 else if(['service-status','service-start','service-stop'].includes(command)){const runtimeHome=path.resolve(process.argv[3]),config=await readJson(runtimeHome,path.join(runtimeHome,'installation.local.json')),current=await readJson(runtimeHome,path.join(runtimeHome,'current.json'));const options={runtimeHome,port:config.http_port,releaseId:current.release_id,paused:config.service_paused!==false};result=await(command==='service-status'?serviceStatus(options):command==='service-start'?startService(options):stopService(options));}
 else throw Error('ADMIN_COMMAND_INVALID');console.log(JSON.stringify(result));
}
