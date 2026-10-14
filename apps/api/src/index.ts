// SPDX-License-Identifier: Apache-2.0
import {createApi} from './app.js';
import {createRemoteJWKSet} from 'jose';
import {connectRecords} from './database.js';
import {scanWithClamd} from './scanner.js';
import {sendHttpEvent,startOutboxWorker} from './workflows/outbox.js';
import {startWorkflowTimerWorker} from './workflows/timer-worker.js';
import {startWaitTimeoutWorker} from './workflows/timeouts.js';
import {startAutomationWorker} from './automations/worker.js';
import {createFilesystemStore} from './files/filesystem-store.js';
import {startFileStorageWorker} from './files/storage-worker.js';
import {bootstrapRuntime,startConfiguredWorkers} from './operations/runtime-lifecycle.js';

const runtime=await bootstrapRuntime(process.env,{
 createStore:createFilesystemStore,connect:connectRecords,
 createApp:(config,database)=>{
  const identity=config.identity?{issuer:config.identity.issuer,audience:config.identity.audience,key:createRemoteJWKSet(new URL(config.identity.jwksUrl))}:undefined;
  return createApi({workerUrl:config.workerUrl,identity,records:database?.repository,foundation:database?.foundation,
   entities:database?.entities,dataTools:database?.dataTools,reports:database?.reports,automations:database?.automations,modules:database?.modules,taskLifecycle:database?.taskLifecycle,organization:database?.organization,operations:database?.operations,events:database?.events,
   definitionRegistry:database?.definitionRegistry,directory:database?.directory,workflows:database?.workflows,readSharedFile:database?.workflows.readSharedFile,
   scan:config.scanner?content=>scanWithClamd(content,config.scanner!.host,config.scanner!.port):undefined});
 },
 startWorkers:(config,database,add)=>{
  if(!database)return;
  startConfiguredWorkers(config,{
   automations:()=>startAutomationWorker(database.automations),timers:()=>startWorkflowTimerWorker(database.workflows),
   waitTimeouts:()=>startWaitTimeoutWorker(database.workflows),
   outbox:()=>startOutboxWorker(database.jobs,job=>sendHttpEvent(job,config.connector!.url,config.connector!.token)),
   fileStorage:()=>startFileStorageWorker(()=>database.offloadFile()),
  },add);
 },
});
console.log(`API listening on port ${runtime.config.port}`);
let signalClose:Promise<void>|undefined;
for(const signal of ['SIGINT','SIGTERM'] as const){
 process.on(signal,()=>{
  signalClose??=runtime.close().then(()=>{process.exitCode=0;},()=>{console.error('Runtime shutdown failed');process.exitCode=1;});
 });
}
