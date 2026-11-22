/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {bad,exact,slug} from './policy.js';
import type {EntitySearch} from './types.js';
export type {EntitySearch} from './types.js';

export function parseEntitySearch(input:unknown):EntitySearch {
 const body=exact(input,['q','schemaId','schemaVersion','limit','offset']);
 if(Buffer.byteLength(JSON.stringify(body),'utf8')>4096) bad('Search body exceeds 4 KiB.');
 if(typeof body.q!=='string'||/[\u0000-\u001f\u007f-\u009f]/u.test(body.q)) bad('Invalid search text.');
 const q=body.q.trim();
 if(!q||Array.from(q).length>200||Buffer.byteLength(q,'utf8')>800) bad('Invalid search text.');
 function integer(value:unknown,fallback:number,min:number,max:number):number {
  if(value===undefined)return fallback;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)bad('Invalid search pagination or schema version.');
  return value;
 }
 const limit=integer(body.limit,50,1,100),offset=integer(body.offset,0,0,10000);
 const hasSchema=Object.hasOwn(body,'schemaId'),hasVersion=Object.hasOwn(body,'schemaVersion');
 if(hasSchema!==hasVersion)bad('Schema ID and version must appear together.');
 if(!hasSchema)return {q,limit,offset};
 if(body.schemaVersion===undefined)bad('Invalid schema version.');
 return {q,limit,offset,schemaId:slug(body.schemaId),schemaVersion:integer(body.schemaVersion,1,1,2147483647)};
}
