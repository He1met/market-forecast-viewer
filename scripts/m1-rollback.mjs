import path from 'node:path';
import {rollbackArguments} from './m1-admin-args.mjs';
import {rollback} from './m1-admin.mjs';
const options=rollbackArguments(process.argv.slice(2)),runtimeHome=process.env.MFV_RUNTIME_HOME;
if(!runtimeHome||!path.isAbsolute(runtimeHome))throw Error('MFV_RUNTIME_HOME_REQUIRED');
console.log(JSON.stringify(await rollback({runtimeHome,...options})));
