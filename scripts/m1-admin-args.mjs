import path from 'node:path';
import {check} from './m1-files.mjs';
export function learningArguments(args) {
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
