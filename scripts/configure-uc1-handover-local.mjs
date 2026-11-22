/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import { dockerContextArgs } from './lib/docker-context.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),envPath=resolve(root,'.env.integration');
const workflowId='LatticeUC1AssetHandover';
async function main(){
 if(process.argv.slice(2).some(a=>!['--install-n8n','--enable-auto'].includes(a)))throw Error('Usage: node scripts/configure-uc1-handover-local.mjs [--install-n8n] [--enable-auto]');
 let text=await readFile(envPath,'utf8');const env=parseEnv(text);
 for(const key of ['ASSET_HANDOVER_TOKEN','UC1_HANDOVER_WEBHOOK_TOKEN']){
  if([...text.matchAll(new RegExp('^\\s*'+key+'\\s*=','gm'))].length>1)throw Error('Duplicate handover configuration entry');
  if(!env[key]){env[key]=randomBytes(32).toString('hex');text+=(text.endsWith('\n')?'':'\n')+key+'='+env[key]+'\n';}
  if(!/^[A-Za-z0-9._~-]{32,256}$/.test(env[key]))throw Error('Invalid handover configuration');
 }
 if(env.ASSET_HANDOVER_TOKEN===env.UC1_HANDOVER_WEBHOOK_TOKEN)throw Error('Separate webhook and adapter credentials required');
 if(process.argv.includes('--enable-auto')){
  const directory=resolve(root,'output/backups');await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'integration-before-uc1-auto-'+randomUUID()+'.env'),await readFile(envPath),{mode:0o600,flag:'wx'});
  const cutoff=env.WORKFLOW_OUTBOX_EVENT_TYPE==='asset.handed_over'&&env.WORKFLOW_OUTBOX_ORGANIZATION_ID==='org-a'&&env.WORKFLOW_OUTBOX_CREATED_AFTER?env.WORKFLOW_OUTBOX_CREATED_AFTER:new Date().toISOString();
  const settings={WORKFLOW_EVENT_URL:'http://n8n:5678/webhook/latticedx/uc1/handovers',WORKFLOW_EVENT_TOKEN:env.UC1_HANDOVER_WEBHOOK_TOKEN,WORKFLOW_OUTBOX_WORKER:'true',WORKFLOW_OUTBOX_EVENT_TYPE:'asset.handed_over',WORKFLOW_OUTBOX_ORGANIZATION_ID:'org-a',WORKFLOW_OUTBOX_CREATED_AFTER:cutoff};
  for(const [key,value] of Object.entries(settings)){
   const pattern=new RegExp('^\\s*'+key+'\\s*=.*$','gm'),matches=[...text.matchAll(pattern)];if(matches.length>1)throw Error('Duplicate outbox configuration');
   text=matches.length?text.replace(pattern,key+'='+JSON.stringify(value)):text+(text.endsWith('\n')?'':'\n')+key+'='+JSON.stringify(value)+'\n';
  }
  console.log('Automatic outbox configured only for org-a / asset.handed_over created at or after '+cutoff+'. Prior env backed up locally; recreate API to apply.');
 }
 await writeFile(envPath,text,{mode:0o600});
 console.log('Handover credentials retained/configured in ignored .env.integration; no secret printed.'+(process.argv.includes('--enable-auto')?'':' Global outbox settings unchanged.'));
 if(!process.argv.includes('--install-n8n'))return;
 const compose=[...dockerContextArgs(), 'compose','--env-file',envPath,'-f',resolve(root,'infra/compose/integration.yml')];
 function run(args,input){return execFileSync('docker',[...compose,...args],{cwd:root,input,windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:120000,maxBuffer:4*1024*1024});}
 const list=String(run(['exec','-T','n8n','n8n','list:workflow']));
 const existing=list.split(/\r?\n/).find(line=>line.startsWith(workflowId+'|'));
 if(existing&&existing!==workflowId+'|LatticeDX - UC1 Asset Handover')throw Error('Reserved workflow ID belongs to another workflow');
 const template=JSON.parse(await readFile(resolve(root,'infra/config/n8n/uc1-handover.json'),'utf8'));
 template.id=workflowId;template.versionId=randomUUID();
 const credentials=[
  {id:'LatticeUC1WebhookCredential',name:'LatticeDX UC1 Handover Webhook',type:'httpHeaderAuth',data:{name:'Authorization',value:'Bearer '+env.UC1_HANDOVER_WEBHOOK_TOKEN}},
  {id:'LatticeUC1AdapterCredential',name:'LatticeDX UC1 Handover Adapter',type:'httpHeaderAuth',data:{name:'Authorization',value:'Bearer '+env.ASSET_HANDOVER_TOKEN}},
 ];
 for(const node of template.nodes)if(node.credentials){const ref=node.credentials.httpHeaderAuth;ref.id=credentials.find(c=>c.name===ref.name).id;}
 async function importJson(command,value){
  const path='/tmp/latticedx-uc1-'+randomUUID()+'.json';
  try{
   run(['exec','-T','n8n','node','-e',"require('node:fs').writeFileSync(process.argv[1],require('node:fs').readFileSync(0),{mode:0o600,flag:'wx'})",path],JSON.stringify(value));
   run(['exec','-T','n8n','n8n',command,'--input',path]);
  }finally{run(['exec','-T','n8n','node','-e',"require('node:fs').rmSync(process.argv[1],{force:true})",path]);}
 }
 await importJson('import:credentials',credentials);
 await importJson('import:workflow',[template]);
 run(['exec','-T','n8n','n8n','publish:workflow','--id',workflowId]);
 run(['restart','n8n']);
 console.log('Installed/published only '+workflowId+' and its two reserved local credentials; existing workflows retained. n8n restarted.');
}
main().catch(()=>{console.error('UC1 setup failed; raw CLI output withheld. No tokens printed.');process.exitCode=1;});
