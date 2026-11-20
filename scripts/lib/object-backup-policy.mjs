/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {createHash} from 'node:crypto';
export const maxObjectManifestBytes=8*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const objectKey=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const fail=()=>{throw new Error('Invalid or incomplete object backup.');};
function exact(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))fail();
}
export function validateObjectInventory(value){
 if(!Array.isArray(value)||value.length>10000)fail();
 const files=new Set(),objects=new Set();let total=0;
 for(const entry of value){
  exact(entry,['fileId','objectKey','size','sha256']);
  if(typeof entry.fileId!=='string'||!uuid.test(entry.fileId)||typeof entry.objectKey!=='string'||!objectKey.test(entry.objectKey)||typeof entry.sha256!=='string'||!digest.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>1048576||files.has(entry.fileId)||objects.has(entry.objectKey))fail();
  files.add(entry.fileId);objects.add(entry.objectKey);total+=entry.size;if(total>1024*1024*1024)fail();
 }
 return value.map(({fileId,objectKey,size,sha256})=>({fileId,objectKey,size,sha256}));
}
export function verifyObjectBytes(bytes,entry){
 validateObjectInventory([entry]);
 if(!Buffer.isBuffer(bytes)||bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)fail();
}
export function compareObjectInventories(expected,actual){
 const normalized=value=>validateObjectInventory(value).sort((a,b)=>a.fileId.localeCompare(b.fileId));
 if(JSON.stringify(normalized(expected))!==JSON.stringify(normalized(actual)))fail();
}
export function validateFullManifest(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>maxObjectManifestBytes)fail();
 let manifest;try{manifest=JSON.parse(text);}catch{fail();}
 exact(manifest,['format','version','createdAt','scope','dump','inventory','count','totalBytes']);
 if(manifest.format!=='latticedx.full-backup'||manifest.version!==1||manifest.scope!=='database-and-objects'||typeof manifest.createdAt!=='string'||!Number.isFinite(Date.parse(manifest.createdAt)))fail();
 exact(manifest.dump,['name','sha256','bytes']);
 if(typeof manifest.dump.name!=='string'||!/^core-[a-f0-9]{32}\.dump$/.test(manifest.dump.name)||typeof manifest.dump.sha256!=='string'||!digest.test(manifest.dump.sha256)||!Number.isSafeInteger(manifest.dump.bytes)||manifest.dump.bytes<1||manifest.dump.bytes>256*1024*1024)fail();
 const inventory=validateObjectInventory(manifest.inventory);
 if(manifest.count!==inventory.length||manifest.totalBytes!==inventory.reduce((sum,entry)=>sum+entry.size,0))fail();
 return {...manifest,inventory};
}
