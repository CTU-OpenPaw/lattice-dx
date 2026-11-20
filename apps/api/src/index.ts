/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
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
import {createTelemetry,type WorkerId,type WorkerObserver} from './operations/telemetry.js';
import {createHandoverBroker} from './ngsi-ld/handover-broker.js';
import {registerNativeRequestStorage} from './files/native-request-storage.js';

const telemetry=createTelemetry();
const observer=(worker:WorkerId):WorkerObserver=>(result,duration)=>telemetry.recordWorker(worker,result,duration);

const runtime=await bootstrapRuntime(process.env,{
 createStore:createFilesystemStore,connect:connectRecords,
 createApp:(config,database)=>{
  const token=process.env.NGSI_LD_NOTIFICATION_TOKEN,tenant=process.env.NGSI_LD_TENANT??'org-a';
  const ngsiLd=token?{token,tenant,subscriptionId:process.env.NGSI_LD_SUBSCRIPTION_ID||`urn:ngsi-ld:Subscription:latticedx:${tenant}:asset-context-v1`,repository:database?.ngsiLdContext}:undefined;
  const identity=config.identity?{issuer:config.identity.issuer,audience:config.identity.audience,key:createRemoteJWKSet(new URL(config.identity.jwksUrl))}:undefined;
  const handoverToken=process.env.ASSET_HANDOVER_TOKEN;
  const broker=handoverToken?createHandoverBroker({baseUrl:process.env.ASSET_HANDOVER_BROKER_URL||'http://orion-ld:1026',tenant}):undefined;
  if(handoverToken&&!database)throw Error('Asset handover requires PostgreSQL');
  const assetHandover=handoverToken?{token:handoverToken,tenant,deliver:(event:Parameters<NonNullable<typeof database>['assetHandover']>[0])=>database!.assetHandover(event,broker!)}:undefined;
  const scan = config.scanner ? (content:Buffer)=>scanWithClamd(content,config.scanner!.host,config.scanner!.port) : undefined;
  const app = createApi({workerUrl:config.workerUrl,identity,ngsiLd,assetHandover,systems:database?.systems,systemAccess:database?.systemAccess,telemetry,runtimeWorkers:config.workers,records:database?.repository,foundation:database?.foundation,
   agents:database?.agents,entities:database?.entities,contextLinks:database?.contextLinks,dataTools:database?.dataTools,reports:database?.reports,automations:database?.automations,modules:database?.modules,taskLifecycle:database?.taskLifecycle,organization:database?.organization,operations:database?.operations,events:database?.events,
   definitionRegistry:database?.definitionRegistry,directory:database?.directory,workflows:database?.workflows,readSharedFile:database?.workflows.readSharedFile,
   scan});
  const secret = process.env.DX_NATIVE_FILES_SECRET;
  const instance = process.env.DX_NATIVE_FILES_INSTANCE;
  if (secret || instance) {
   if (!secret || !instance || !database || !scan) throw Error('Native file service requires a paired instance, PostgreSQL and scanner');
   registerNativeRequestStorage(app,{secret,instance,repository:database.nativeRequestStorage,scan});
  }
  return app;
 },
 startWorkers:(config,database,add)=>{
  if(!database)return;
  startConfiguredWorkers(config,{
   automations:()=>startAutomationWorker(database.automations,1000,observer('automations')),timers:()=>startWorkflowTimerWorker(database.workflows,1000,observer('timers')),
   waitTimeouts:()=>startWaitTimeoutWorker(database.workflows,1000,observer('waitTimeouts')),
   outbox:()=>startOutboxWorker(database.jobs,job=>sendHttpEvent(job,config.connector!.url,config.connector!.token),1000,observer('outbox')),
   fileStorage:()=>startFileStorageWorker(()=>database.offloadFile(),1000,undefined,observer('fileStorage')),
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
