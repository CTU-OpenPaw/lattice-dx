// SPDX-License-Identifier: Apache-2.0
import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import {isAbsolute,parse,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {MAX_FILE_BYTES,type ObjectStore,type StoragePointer} from './object-store.js';
const keyPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const normalized=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function same(a:Stats,b:Stats){if(a.dev!==b.dev||a.ino!==b.ino||!b.isFile()||b.isSymbolicLink())throw new Error('Object identity changed');}
async function validateRoot(root:string) {
 if(!isAbsolute(root)||resolve(root)!==root)throw new Error('Storage root must be absolute and canonical');
 let current=parse(root).root;
 const anchor=await lstat(current);
 if(anchor.isSymbolicLink()||!anchor.isDirectory())throw new Error('Unsafe storage root anchor');
 for(const part of root.slice(current.length).split(/[\\/]/).filter(Boolean)) {
  current=join(current,part);const stat=await lstat(current);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Storage root ancestor is not an isolated directory');
  if(normalized(await realpath(current))!==normalized(current))throw new Error('Storage root resolution changed');
 }
 const stat=await lstat(root);
 // Portable mode bits cannot inspect Windows ACLs: operator-owned, isolated ACLs are required there.
 if(process.platform!=='win32'&&(stat.mode&0o022)!==0)throw new Error('Storage root is writable by other users');
 if(process.getuid&&stat.uid!==process.getuid())throw new Error('Storage root must be owned by the process user');
 return stat;
}
async function readHandle(handle:FileHandle,size:number,sha256:string) {
 const stat=await handle.stat();if(!stat.isFile()||stat.size!==size)throw new Error('Object size or type mismatch');
 const bytes=Buffer.alloc(size+1);let offset=0;
 while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead;}
 if(offset!==size||digest(bytes.subarray(0,offset))!==sha256)throw new Error('Object verification failed');
 same(stat,await handle.stat());return bytes.subarray(0,offset);
}
/** Root ownership/ACL isolation against local replacement is a deployment precondition.
 * Durable publication requires directory fsync (deployed Linux); Windows writes fail closed. */
export async function createFilesystemStore(root:string,testing?:{objectKey?:()=>string;write?:(handle:FileHandle,content:Buffer)=>Promise<void>;openRoot?:(root:string)=>Promise<{stat:()=>Promise<Stats>;sync:()=>Promise<void>;close:()=>Promise<void>}>}):Promise<ObjectStore> {
 const initial=await validateRoot(root);
 async function checkRoot(){const next=await validateRoot(root);if(initial.dev!==next.dev||initial.ino!==next.ino)throw new Error('Storage root changed');}
 async function readVerified(pointer:Extract<StoragePointer,{provider:'filesystem'}>) {
  if(!keyPattern.test(pointer.objectKey)||!Number.isInteger(pointer.size)||pointer.size<0||pointer.size>MAX_FILE_BYTES||!/^[a-f0-9]{64}$/.test(pointer.sha256))throw new Error('Invalid storage pointer');
  await checkRoot();const path=join(root,pointer.objectKey);const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||normalized(await realpath(path))!==normalized(path))throw new Error('Unsafe object');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {same(before,await handle.stat());const bytes=await readHandle(handle,pointer.size,pointer.sha256);same(before,await lstat(path));if(normalized(await realpath(path))!==normalized(path))throw new Error('Object resolution changed');await checkRoot();return bytes;}
  finally {await handle.close();}
 }
 return {readVerified,async writeVerified(content){
  if(!Buffer.isBuffer(content)||content.length>MAX_FILE_BYTES)throw new Error('Invalid object content');
  content=Buffer.from(content);
  await checkRoot();
  if(process.platform==='win32'&&!testing?.openRoot)throw new Error('Durable filesystem publication requires directory sync; Windows writes are unsupported');
  const directory=testing?.openRoot?await testing.openRoot(root):await open(root,constants.O_RDONLY|(constants.O_DIRECTORY??0)|(constants.O_NOFOLLOW??0));
  try {
  const pinned=await directory.stat();if(!pinned.isDirectory()||pinned.dev!==initial.dev||pinned.ino!==initial.ino)throw new Error('Storage root changed');
  await checkRoot();const objectKey=testing?.objectKey?.()??randomUUID();if(!keyPattern.test(objectKey))throw new Error('Invalid generated object key');
  const size=content.length;const sha256=digest(content);const path=join(root,objectKey);
  const handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  let identity:Stats;
  try {identity=await handle.stat();if(testing?.write)await testing.write(handle,content);else await handle.writeFile(content);await handle.sync();await readHandle(handle,size,sha256);same(identity,await lstat(path));}
  finally {await handle.close();}
  const bytes=await readVerified({provider:'filesystem',objectKey,size,sha256});
  same(identity!,await lstat(path));if(!bytes.equals(content))throw new Error('Object verification failed');
  // File fsync persists bytes; directory fsync persists the newly created name.
  await directory.sync();await checkRoot();
  return {objectKey,size,sha256};
  } finally {await directory.close();}
 }};
}
