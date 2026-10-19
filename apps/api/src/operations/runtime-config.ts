// SPDX-License-Identifier: Apache-2.0
import {isAbsolute,resolve} from 'node:path';
export interface RuntimeConfig {
 databaseUrl?:string;host:string;port:number;workerUrl:string;
 identity?:{issuer:string;jwksUrl:string;audience:string};scanner?:{host:string;port:number};
 connector?:{url:string;token:string};storage:{provider:'postgres'|'filesystem';root?:string};
 workers:{automations:boolean;timers:boolean;waitTimeouts:boolean;outbox:boolean;fileStorage:boolean};
}
function invalid(field:string):never {throw new Error(`Invalid runtime configuration: ${field}.`);}
function url(value:string,field:string,protocols=['http:','https:']) {
 try {const parsed=new URL(value);if(!protocols.includes(parsed.protocol)||!parsed.hostname)invalid(field);}catch{invalid(field);}return value;
}
function port(value:string|undefined,fallback:number,field:string){if(value===undefined)return fallback;if(!/^\d+$/.test(value))invalid(field);const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<1||parsed>65535)invalid(field);return parsed;}
/** Pure validation: never opens a database, file or socket, and never echoes values. */
export function parseRuntimeConfig(env:NodeJS.ProcessEnv):RuntimeConfig {
 const flag=(key:string)=>{const value=env[key];if(value===undefined||value==='false')return false;if(value==='true')return true;return invalid(key);};
 const workers={automations:flag('ENTITY_AUTOMATION_WORKER'),timers:flag('WORKFLOW_TIMER_WORKER'),waitTimeouts:flag('WORKFLOW_WAIT_TIMEOUT_WORKER'),outbox:flag('WORKFLOW_OUTBOX_WORKER'),fileStorage:flag('FILE_STORAGE_WORKER')};
 const databaseUrl=env.DATABASE_URL===undefined?undefined:url(env.DATABASE_URL,'DATABASE_URL',['postgres:','postgresql:']);
 if(Object.values(workers).some(Boolean)&&!databaseUrl)invalid('worker database prerequisite');
 const provider=env.FILE_STORAGE_PROVIDER??'postgres';if(provider!=='postgres'&&provider!=='filesystem')invalid('FILE_STORAGE_PROVIDER');
 const root=env.FILE_STORAGE_ROOT;if(root!==undefined&&(!isAbsolute(root)||resolve(root)!==root))invalid('FILE_STORAGE_ROOT');
 if(provider==='filesystem'&&!root)invalid('filesystem root prerequisite');
 if(workers.fileStorage&&(provider!=='filesystem'||!root))invalid('storage worker prerequisite');
 const issuer=env.OIDC_ISSUER,jwksUrl=env.OIDC_JWKS_URL;
 if((issuer!==undefined)!==(jwksUrl!==undefined))invalid('OIDC identity pair');
 const identity=issuer!==undefined&&jwksUrl!==undefined?{issuer:url(issuer,'OIDC_ISSUER'),jwksUrl:url(jwksUrl,'OIDC_JWKS_URL'),audience:env.OIDC_AUDIENCE??'dx-api'}:undefined;
 if(identity&&!identity.audience.trim())invalid('OIDC_AUDIENCE');
 const eventUrl=env.WORKFLOW_EVENT_URL?.trim()?env.WORKFLOW_EVENT_URL:undefined,eventToken=env.WORKFLOW_EVENT_TOKEN?.trim()?env.WORKFLOW_EVENT_TOKEN:undefined;
 if((eventUrl!==undefined)!==(eventToken!==undefined))invalid('workflow connector pair');
 const connector=eventUrl!==undefined&&eventToken!==undefined?{url:url(eventUrl,'WORKFLOW_EVENT_URL'),token:eventToken}:undefined;
 if(connector&&!connector.token.trim())invalid('WORKFLOW_EVENT_TOKEN');
 if(workers.outbox&&!connector)invalid('outbox connector prerequisite');
 const scannerPort=port(env.CLAMD_PORT,3310,'CLAMD_PORT');if(env.CLAMD_HOST!==undefined&&!env.CLAMD_HOST.trim())invalid('CLAMD_HOST');
 const host=env.API_HOST??'127.0.0.1';if(!host.trim())invalid('API_HOST');
 return {databaseUrl,host,port:port(env.API_PORT,4000,'API_PORT'),workerUrl:url(env.WORKER_URL??'http://127.0.0.1:4001','WORKER_URL'),identity,scanner:env.CLAMD_HOST?{host:env.CLAMD_HOST,port:scannerPort}:undefined,connector,storage:{provider,root},workers};
}
