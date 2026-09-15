import path from'node:path';import{evaluateForecast as legacyEvaluate}from'../compat/m1-v1/src/m1-evaluation.ts';import{readJson,readBytes,digest,check,sourceCodeRoot}from'./m1-files.mjs';
/** The complete original source closure is retained, hash-bound, and reviewed with the adapter. */
export async function legacyScorer({classifierHash,scorerHash}){
 const folder=path.join(sourceCodeRoot,'compat/m1-v1'),manifest=await readJson(sourceCodeRoot,path.join(folder,'files.json'));
 check(manifest.schema==='MFV:COMPAT:v1'&&manifest.files['src/m1-contracts.ts']===classifierHash&&manifest.files['src/m1-evaluation.ts']===scorerHash,'UNKNOWN_SCORER');
 for(const [name,hash]of Object.entries(manifest.files)){check(!path.isAbsolute(name)&&!name.split('/').includes('..'),'COMPAT_PATH_INVALID');check(digest(await readBytes(sourceCodeRoot,path.join(folder,name)))===hash,'COMPAT_CODE_CHANGED');}
 return legacyEvaluate;
}
