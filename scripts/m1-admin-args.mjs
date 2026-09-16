import path from 'node:path';
import {check} from './m1-files.mjs';
export function learningArguments(args) {
 if(args[0]==='plan-input'){
  check(args.length===7&&args[1]==='--input'&&['derivatives','calendar'].includes(args[2])&&args[3]==='--policy-sha'&&/^[a-f0-9]{64}$/.test(args[4]??'')&&args[5]==='--reason'&&typeof args[6]==='string'&&args[6].trim().length>0&&args[6].length<=2000,'LEARNING_ARGUMENTS_INVALID');
  return {action:'plan-input',input:args[2],policySha:args[4],reason:args[6].trim()};
 }
 check(args.length===3&&args[0]==='disable'&&args[1]==='--reason'&&typeof args[2]==='string'&&args[2].trim().length>0&&args[2].length<=2000,'LEARNING_ARGUMENTS_INVALID');
 return {reason:args[2].trim()};
}
export function releaseArguments(args) {
 check(args.length===4,'RELEASE_ARGUMENTS_INVALID');
 const values={};for(let i=0;i<args.length;i+=2){check(['--commit','--destination'].includes(args[i])&&!Object.hasOwn(values,args[i]),'RELEASE_ARGUMENTS_INVALID');values[args[i]]=args[i+1];}
 check(/^[a-f0-9]{40}$/.test(values['--commit']??''),'EXACT_COMMIT_REQUIRED');
 check(typeof values['--destination']==='string'&&path.isAbsolute(values['--destination']),'ABSOLUTE_DESTINATION_REQUIRED');
 return {buildSha:values['--commit'],destination:path.resolve(values['--destination'])};
}

export function rollbackArguments(args) {
 check(args.length===2&&args[0]==='--release'&&/^[a-f0-9]{64}$/.test(args[1]??''),'ROLLBACK_ARGUMENTS_INVALID');
 return {releaseId:args[1]};
}

export function deployArguments(args) {
 check(args.length===6,'DEPLOY_ARGUMENTS_INVALID');
 const values={};for(let i=0;i<args.length;i+=2){check(['--release','--approval','--config'].includes(args[i])&&!Object.hasOwn(values,args[i]),'DEPLOY_ARGUMENTS_INVALID');values[args[i]]=args[i+1];}
 check(/^[a-f0-9]{64}$/.test(values['--release']??''),'EXACT_RELEASE_REQUIRED');
 for(const key of ['--approval','--config'])check(typeof values[key]==='string'&&path.isAbsolute(values[key]),'ABSOLUTE_DEPLOY_FILE_REQUIRED');
 return {releaseId:values['--release'],approvalFile:path.resolve(values['--approval']),configFile:path.resolve(values['--config'])};
}
export function recoveryArguments(args) {
 check(args.length===2&&args[0]==='--transaction'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args[1]??''),'RECOVERY_ARGUMENTS_INVALID');
 return {transactionId:args[1]};
}
