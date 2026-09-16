import path from 'node:path';
import {deployArguments} from './m1-admin-args.mjs';
import {activate} from './m1-admin.mjs';
import {readJson} from './m1-files.mjs';
const {releaseId,approvalFile,configFile}=deployArguments(process.argv.slice(2)),runtimeHome=process.env.MFV_RUNTIME_HOME;
if(!runtimeHome||!path.isAbsolute(runtimeHome))throw Error('MFV_RUNTIME_HOME_REQUIRED');
const approval=await readJson(path.dirname(approvalFile),approvalFile),config=await readJson(path.dirname(configFile),configFile);
console.log(JSON.stringify(await activate({runtimeHome,releaseId,approval,config,healthCheck:true})));
