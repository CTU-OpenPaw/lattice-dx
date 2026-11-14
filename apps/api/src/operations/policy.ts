/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {randomUUID} from 'node:crypto';
export class OperationsError extends Error {constructor(public statusCode:400|503,message:string){super(message);}}
export function correlationId(_value?:unknown):string{
 return randomUUID();
}
export function parseCutoff(value:unknown):string{
 if(typeof value!=='string'||value.startsWith('0000')||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))throw new OperationsError(400,'before must be a UTC timestamp.');
 const date=new Date(value);
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,19)!==value.slice(0,19)||date.getTime()>Date.now())throw new OperationsError(400,'before must be a real timestamp in the past.');
 return date.toISOString();
}
