// SPDX-License-Identifier: Apache-2.0
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {documentProcessTemplate}=require('../plugins/nocobase/plugin-lattice-foundation/src/server/native-process-template');

// Uses the same host APIs as the workflow designer; never writes workflow tables
// directly. Existing workflows are not edited or overwritten.
export async function configureNativeProcess(api,config) {
  const template=documentProcessTemplate(config);
  const workflow=await api('workflows:create',{method:'POST',values:template.workflow});
  try {
    const ids=new Map();
    for(const {upstreamKey,...node} of template.nodes) {
      const created=await api(`workflows/${workflow.id}/nodes:create`,{method:'POST',values:{...node,...(upstreamKey?{upstreamId:ids.get(upstreamKey)}:{})}});
      ids.set(node.key,created.id);
    }
    return {workflowId:workflow.id,key:workflow.key,nodeIds:Object.fromEntries(ids),enabled:false};
  }catch(error){
    // The failed new template stays disabled and can be inspected/removed by its
    // administrator. Never delete an existing workflow to make installation pass.
    throw new Error(`Native workflow ${workflow.id} remains disabled: ${error.message}`);
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
  const config={collection:args.collection,organizationId:args.organization,reviewerEmployeeId:args.reviewer,assigneeEmployeeId:args.assignee};
  documentProcessTemplate(config);
  const base=new URL(process.env.NOCOBASE_URL??'http://localhost:13000');
  if(!['localhost','127.0.0.1'].includes(base.hostname))throw Error('Local configuration only');
  let token;
  const api=async(path,{method='GET',values}={})=>{
    const response=await fetch(new URL('/api/'+path,base),{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(values?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(15000)});
    const body=await response.json();if(!response.ok)throw Error(`${path.split('?')[0]} HTTP ${response.status}`);return body.data;
  };
  token=(await api('auth:signIn',{method:'POST',values:{email:process.env.NOCOBASE_ADMIN_EMAIL??'admin@nocobase.com',password:process.env.NOCOBASE_ADMIN_PASSWORD??'admin123'}})).token;
  const report=await configureNativeProcess(api,config);console.log(JSON.stringify(report));
}
