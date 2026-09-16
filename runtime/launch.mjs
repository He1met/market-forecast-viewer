// Stable installed launcher: resolve current once; every stage uses that pinned release.
import fs from'node:fs/promises';import path from'node:path';import{spawn}from'node:child_process';
const home=path.resolve(process.argv[2]??''),command=process.argv[3];
const args=process.argv.slice(4);
const learning=command==='learning'&&args.length===3&&args[0]==='disable'&&args[1]==='--reason'&&args[2].trim().length>0&&args[2].length<=2000;
if(args.length&&!learning&&!(command==='doctor'&&args.length===1&&args[0]==='--full-audit'))throw Error('LAUNCH_ARGUMENTS_INVALID');
if(!path.isAbsolute(process.argv[2]??'')||!['forecast','ops','serve','doctor','backup','pause','resume','notifications','learning'].includes(command))throw Error('LAUNCH_ARGUMENTS_INVALID');
if(command==='learning'&&!learning)throw Error('LAUNCH_ARGUMENTS_INVALID');
if(await fs.realpath(home)!==home)throw Error('RUNTIME_HOME_SYMLINK');
try{await fs.lstat(path.join(home,'installation-pending.json'));throw Error('INSTALLATION_RECOVERY_REQUIRED');}catch(error){if(error.code!=='ENOENT')throw error;}
const installation=JSON.parse(await fs.readFile(path.join(home,'installation.local.json'),'utf8'));
const current=JSON.parse(await fs.readFile(path.join(home,'current.json'),'utf8'));
if(!/^[a-f0-9]{64}$/.test(current.release_id))throw Error('CURRENT_RELEASE_INVALID');
const code=path.join(home,'releases',current.release_id);
if(await fs.realpath(code)!==code)throw Error('RELEASE_SYMLINK');
const child=spawn(process.execPath,['--import','tsx','scripts/m1-entry.mjs',command,home,current.release_id,...args],{cwd:code,env:{...process.env,MFV_RUNTIME_HOME:home,MFV_DATA_ROOT:installation.data_root},stdio:'inherit'});
child.once('error',e=>{console.error(e.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
