import {learningArguments} from './m1-admin-args.mjs';
// Development convenience only; all business code runs from the pinned installed release.
import path from'node:path';import{spawn}from'node:child_process';
const home=process.env.MFV_RUNTIME_HOME,command=process.argv[2];
if(!home||!path.isAbsolute(home))throw Error('MFV_RUNTIME_HOME_REQUIRED');
if(!['forecast','ops','backup','doctor','serve','pause','resume','learning'].includes(command))throw Error('INSTALLED_COMMAND_INVALID');
const args=process.argv.slice(3),audit=command==='doctor'&&args.length===1&&args[0]==='--full-audit';
if(command==='learning')learningArguments(args);
else if(args.length&&!audit&&!(args.length===2&&args[0]==='--trigger'&&['manual','scheduled'].includes(args[1])))throw Error('INSTALLED_ARGUMENTS_INVALID');
const child=spawn(process.execPath,[path.join(home,'launch.mjs'),home,command,...((audit||command==='learning')?args:[])],{env:{...process.env,MFV_TRIGGER:(audit||command==='learning')?'manual':args[1]??'manual'},stdio:'inherit'});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
