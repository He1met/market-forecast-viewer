import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,encode,check,readBytes,readJson,writeOnce,within,safePath} from './m1-files.mjs';
const here=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const allowedName=s=>typeof s==='string'&&!path.isAbsolute(s)&&!s.includes('\\')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..');
export async function tree(root,dir='') {const result=[];for(const e of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const name=path.posix.join(dir,e.name);check(!e.isSymbolicLink(),'PACKAGE_SYMLINK');if(e.isDirectory())result.push(...await tree(root,name));else{check(e.isFile(),'PACKAGE_FILE_TYPE');result.push(name);}}return result.sort();}
export async function verifyPackage(root) {
 const manifest=await readJson(root,path.join(root,'manifest.json'));
 check(manifest.schema==='MFV:RUNTIME_PACKAGE:v1'&&/^[a-f0-9]{40}$/.test(manifest.build_sha)&&manifest.source_kind==='git_archive'&&/^[a-f0-9]{64}$/.test(manifest.source_archive_sha256)&&typeof manifest.synthetic==='boolean','PACKAGE_MANIFEST_INVALID');
 check(manifest.platform===process.platform&&manifest.architecture===process.arch&&manifest.node_major===Number(process.versions.node.split('.')[0]),'PACKAGE_PLATFORM_MISMATCH');
 check(manifest.release_id===digest(encode({...manifest,release_id:undefined})),'RELEASE_ID_MISMATCH');
 const names=Object.keys(manifest.files);check(names.every(allowedName),'PACKAGE_PATH_INVALID');
 const actual=(await tree(root)).filter(x=>x!=='manifest.json');check(JSON.stringify(actual)===JSON.stringify(names.sort()),'PACKAGE_FILE_SET_MISMATCH');
 for(const [name,entry]of Object.entries(manifest.files)){const bytes=await readBytes(root,path.join(root,name),256*1024*1024);check(bytes.length===entry.bytes&&digest(bytes)===entry.sha256,'PACKAGE_HASH_MISMATCH:'+name);}
 const list=await readJson(root,path.join(root,'runtime/files.json'));check(manifest.imports&&Object.keys(manifest.imports).length===list.files.filter(x=>/\.(?:mjs|cjs|js|mts|cts|ts)$/.test(x)).length,'PACKAGE_IMPORT_GRAPH_MISSING');
 for(const [name,specs]of Object.entries(manifest.imports)){check(list.files.includes(name)&&Array.isArray(specs),'PACKAGE_IMPORT_GRAPH_INVALID');for(const spec of specs){if(spec.startsWith('.')){const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),spec));check([resolved,resolved+'.ts',resolved+'.mjs',resolved+'.js'].some(x=>list.files.includes(x)),'PACKAGE_IMPORT_GRAPH_OPEN');}else check(spec.startsWith('node:')||['tsx','zod'].includes(spec.split('/')[0]),'PACKAGE_IMPORT_EXTERNAL');}}
 check(!await fs.stat(path.join(root,'.git')).catch(()=>null),'PACKAGE_GIT_FORBIDDEN');
 return manifest;
}
/** Build in a new path, never install/activate. No artifacts, credentials or Git are copied. */
