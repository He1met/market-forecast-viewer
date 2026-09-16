import path from 'node:path';
import {recoveryArguments} from './m1-admin-args.mjs';
import {recoverInstallation} from './m1-admin.mjs';
const options=recoveryArguments(process.argv.slice(2)),runtimeHome=process.env.MFV_RUNTIME_HOME;
if(!runtimeHome||!path.isAbsolute(runtimeHome))throw Error('MFV_RUNTIME_HOME_REQUIRED');
console.log(JSON.stringify(await recoverInstallation({runtimeHome,...options})));
