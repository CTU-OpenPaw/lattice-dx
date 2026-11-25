/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,readdir,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {defaultRun,installWorkspace} from './install-workspace.mjs';
import {dockerContextArgs,resolveDockerContext} from './lib/docker-context.mjs';
import {resolveNocoBaseVersion} from './lib/nocobase-externals.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export function cleanInstallPlan(id,port=13004,{blankSlate=false}={}){
  if(!/^[a-f0-9]{12}$/.test(id)||!Number.isInteger(port)||port<13004||port>13999)throw Error('Use a generated clean-lab ID and port13004–13999');
  const project='lattice-native-clean-'+id,directory=resolve(root,'output/native-clean',id),sourceRoot=join(directory,'source');
  const origin='http://localhost:'+port,overlayPath=join(directory,'overlay.yml');
  const blankEnv=blankSlate?'      LATTICE_SKIP_DEMO_SEED: "1"\n':'';
  const overlay=`# Local disposable native lab; never production credentials.\nservices:\n  nocobase-db:\n    volumes:\n      - clean-db:/var/lib/postgresql/data\n  nocobase:\n    ports: !override\n      - "127.0.0.1:${port}:80"\n    environment:\n      DX_BRIDGE_CALLBACK_URL: ${origin}/api/dxActions:callback\n      DX_NATIVE_AUTH_ORIGIN: ${origin}\n      DX_NATIVE_CONTEXT_AUTO_SYNC: "false"\n${blankEnv}    volumes:\n      - clean-storage:/app/nocobase/storage\nvolumes:\n  clean-db:\n  clean-storage:\n`;
  const composeArgs=[...dockerContextArgs(),'compose','-p',project,'-f','infra/compose/native-rehearsal.yml','-f',overlayPath];
  return {project,directory,sourceRoot,origin,overlayPath,overlay,composeArgs,blankSlate:Boolean(blankSlate)};
}
export function parseCleanInstallArgs(args=[]){
  let port=13004,blankSlate=false,keep=false;
  for(const arg of args){
    if(/^--port=\d+$/.test(arg))port=Number(arg.slice(7));
    else if(arg==='--blank-slate')blankSlate=true;
    else if(arg==='--keep')keep=true;
    else throw Error('Usage: node scripts/native-clean-install.mjs [--port=13004] [--blank-slate] [--keep]');
  }
  return {port,blankSlate,keep};
}
export async function runBlankSlateLifecycleCheck(origin){
  const loginRes=await fetch(origin+'/api/auth:signIn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:process.env.NOCOBASE_ADMIN_EMAIL??'admin@nocobase.com',password:process.env.NOCOBASE_ADMIN_PASSWORD??'admin123'}),redirect:'error',signal:AbortSignal.timeout(15000)});
  const loginJson=await loginRes.json();
  const token=loginJson?.data?.token;
  if(!loginRes.ok||!token)throw Error('Blank-slate admin signIn failed: HTTP '+loginRes.status);
  const hdrs={'content-type':'application/json',authorization:'Bearer '+token,'X-Role':'root'};
  const apiCall=async(path,{method='GET',values}={})=>{
    const r=await fetch(origin+'/api/'+path,{method,headers:hdrs,redirect:'error',...(values!==undefined?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(30000)});
    const j=await r.json().catch(()=>({}));
    return {ok:r.ok,status:r.status,data:j?.data!==undefined?j.data:j};
  };
  const profRes=await apiCall('dxosAi:listProfiles');
  if(!profRes.ok||!(profRes.data?.profiles||[]).some(p=>p?.username==='dxos-architect'))throw Error('dxos-architect missing on blank-slate install');
  const appKey='blank-slate-check';
  const parentCol='latticeCustomBlankDepts',childCol='latticeCustomBlankTasks';
  const mcpRes=await fetch(origin+'/api/dxos-mcp',{
    method:'POST',
    headers:{...hdrs,accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dxos_provision_role_workspace',arguments:{
      operation:'build_enterprise_app',appKey,portalSlug:'services',pageTitle:'Blank Slate Check',
      roleName:'ldx_blank_ops',roleTitle:'Blank Ops',
      collections:[
        {collectionName:childCol,collectionTitle:'Công việc Blank',fields:[{name:'title',type:'string'},{name:'status',type:'select',enum:['todo','done']},{name:'dept',type:'belongsTo',target:parentCol}]},
        {collectionName:parentCol,collectionTitle:'Phòng ban Blank',fields:[{name:'name',type:'string'}]},
      ],
    }}}),
    redirect:'error',signal:AbortSignal.timeout(45000),
  });
  const mcpJson=await mcpRes.json();
  if(!mcpRes.ok||mcpJson?.error||mcpJson?.result?.isError)throw Error('Blank-slate MCP build failed: '+JSON.stringify(mcpJson));
  const built=JSON.parse(mcpJson.result.content[0].text||'{}');
  if(!built.built||built.collections?.[0]!==parentCol||built.collections?.[1]!==childCol)throw Error('Blank-slate topological order mismatch');
  const listRes=await apiCall('dxosAi:listBuiltApps');
  if(!listRes.ok||!(listRes.data?.apps||[]).some(a=>a.appKey===appKey))throw Error('listBuiltApps missing blank-slate app');
  const metaRes=await apiCall('dxosBlocks:collectionsMeta');
  const metaNames=new Set((metaRes.data?.collections||[]).map(c=>c.name));
  if(!metaNames.has(parentCol)||!metaNames.has(childCol))throw Error('collectionsMeta missing blank-slate collections');
  const rebuildRes=await apiCall('dxosAi:rebuildBuiltApp',{method:'POST',values:{appKey}});
  if(!rebuildRes.ok||rebuildRes.data?.appVersion!==2)throw Error('Blank-slate rebuildBuiltApp v2 failed');
  const exportRes=await apiCall('dxosAi:exportBuiltAppBundle?appKey='+encodeURIComponent(appKey));
  if(!exportRes.ok||exportRes.data?.metadata?.schemaVersion!=='latticedx.solution-bundle/v3')throw Error('Blank-slate exportBuiltAppBundle v3 failed');
  const tdRes=await apiCall('dxosAi:teardownBuiltApp',{method:'POST',values:{appKey,keepData:false}});
  if(!tdRes.ok||!tdRes.data?.torndown)throw Error('Blank-slate teardownBuiltApp failed');
  return {appKey,builtCollections:built.collections,rebuildVersion:rebuildRes.data.appVersion,bundleSchemaVersion:exportRes.data.metadata.schemaVersion,droppedCollections:tdRes.data.droppedCollections};
}
export function assertUnusedCleanProject(resources){
  if(resources.length!==3||resources.some(value=>String(value).trim()!==''))throw Error('Clean project already owns resources; refusing reuse');
}
export function assertEmptyNativeDatabase(value){
  if(String(value).trim()!=='0')throw Error('Clean database is not empty; refusing bootstrap');
}
async function waitHealthy(origin){
  const deadline=Date.now()+180000;
  const probeOrigin=String(origin||'').replace('://localhost:','://127.0.0.1:');
  do{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),3000);
    try{const r=await fetch(probeOrigin+'/api/app:getLang',{redirect:'error',signal:controller.signal});if(r.ok)return;}catch{}
    finally{clearTimeout(timer);}
    await delay(1500);
  }while(Date.now()<deadline);
  throw Error('Clean runtime did not become healthy');
}
function jsonOutput(bytes){return JSON.parse(String(bytes).trim().split('\n').at(-1));}

export async function nativeCleanInstall({run=defaultRun,port=13004,blankSlate=false,keep=false,onProgress=()=>{}}={}){
  const plan=cleanInstallPlan(randomUUID().replaceAll('-','').slice(0,12),port,{blankSlate});
  const report={format:'latticedx.native-clean-install',version:1,project:plan.project,origin:plan.origin,sourceRoot:plan.sourceRoot,
    blankSlate:Boolean(blankSlate),complete:false,phase:'preflight',integrationsVerified:false,fullSystemAcceptance:false};
  const command=async(file,args,{cwd=root,timeout=120000,env=process.env}={})=>{
    try{return await run(file,args,{cwd,timeout,env,shell:false});}
    catch{throw Error('Clean-install command failed; output withheld');}
  };
  const docker=args=>command('docker',[...dockerContextArgs(),...args]);
  const compose=(args,timeout=120000)=>command('docker',[...plan.composeArgs,...args],{cwd:plan.sourceRoot,timeout});
  const sql=statement=>compose(['exec','-T','nocobase-db','psql','-X','-v','ON_ERROR_STOP=1','-U','nocobase','-d','nocobase','-At','-c',statement]);
  const save=async phase=>{report.phase=phase;await writeFile(join(plan.directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});onProgress({phase,project:plan.project,origin:plan.origin});};
  // No default project or existing volume can be selected through this CLI.
  assertUnusedCleanProject(await Promise.all([
    docker(['ps','-a','--filter','label=com.docker.compose.project='+plan.project,'--format','{{.ID}}']),
    docker(['volume','ls','--filter','label=com.docker.compose.project='+plan.project,'--format','{{.Name}}']),
    docker(['network','ls','--filter','label=com.docker.compose.project='+plan.project,'--format','{{.Name}}']),
  ]));
  await mkdir(plan.directory,{recursive:true,mode:0o700});
  const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
  if(normalize(await realpath(plan.directory))!==normalize(plan.directory))throw Error('Linked clean-lab directories are forbidden');
  try{
    report.sourceCommit=String(await command('git',['rev-parse','HEAD'])).trim();
    const archive=join(plan.directory,'source.tar');
    await command('git',['archive','--format=tar','--output='+archive,report.sourceCommit]);
    await mkdir(plan.sourceRoot);
    await command('tar',['-xf',archive,'-C',plan.sourceRoot]);
    if (blankSlate && !existsSync(join(plan.sourceRoot, 'node_modules'))) {
      const pnpmCjs = [
        join(dirname(process.execPath), 'node_modules/pnpm/bin/pnpm.cjs'),
        join(process.env.APPDATA || '', 'npm/node_modules/pnpm/bin/pnpm.cjs'),
        '/usr/lib/node_modules/pnpm/bin/pnpm.cjs',
        '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs',
      ].find((p) => p && existsSync(p));
      if (pnpmCjs) {
        await command(process.execPath, [pnpmCjs, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'], { cwd: plan.sourceRoot, timeout: 120000 });
      } else {
        await command('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], { cwd: plan.sourceRoot, timeout: 120000 });
      }
    }
    await writeFile(plan.overlayPath,plan.overlay,{flag:'wx'});
    await save('exported-committed-source');
    await compose(['config','--quiet']);
    await compose(['up','-d','--wait','nocobase-db']);
    assertEmptyNativeDatabase(await sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'"));
    report.initialPublicTables=0;
    await save('empty-database-confirmed');
    await compose(['up','-d','nocobase']);
    await waitHealthy(plan.origin);
    await save('host-bootstrapped');
    const health=async()=>{try{return(await fetch(plan.origin+'/api/app:getLang',{redirect:'error',signal:AbortSignal.timeout(3000)})).ok;}catch{return false;}};
    const installed=await installWorkspace({run,sourceRoot:plan.sourceRoot,composeArgs:plan.composeArgs,backupDir:join(plan.directory,'backups'),health});
    report.versions=installed.versions;
    report.backupPath=installed.backupPath;
    await compose(['exec','-T','nocobase','yarn','nocobase','upgrade']);
    const expectedVersion=resolveNocoBaseVersion();
    report.runtimeVersion=String(await compose(['exec','-T','nocobase','node','-e',"console.log(require('@nocobase/server/package.json').version)"])).trim();
    if(report.runtimeVersion!==expectedVersion)throw Error('Unexpected native runtime version: '+report.runtimeVersion+' (expected '+expectedVersion+')');
    const migrationPlugins = [
      { directory: 'plugin-lattice-foundation', pkg: '@latticedx/plugin-lattice-foundation' },
      { directory: 'plugin-dxos-para', pkg: '@latticedx/plugin-dxos-para' },
      { directory: 'plugin-dxos-blocks', pkg: '@latticedx/plugin-dxos-blocks' },
      { directory: 'plugin-dxos-studio', pkg: '@latticedx/plugin-dxos-studio' },
      { directory: 'plugin-dxos-ai', pkg: '@latticedx/plugin-dxos-ai' },
    ];
    const expected = [];
    for (const item of migrationPlugins) {
      const migrationsDirectory = join(plan.sourceRoot, 'plugins/nocobase', item.directory, 'src/server/migrations');
      const names = (await readdir(migrationsDirectory)).filter(name => /^\d{14}-[a-z0-9-]+\.js$/.test(name)).map(name => `${name.slice(0, -3)}/${item.pkg}`);
      expected.push(...names);
    }
    const applied = JSON.parse(String(await sql("SELECT coalesce(json_agg(name),'[]'::json) FROM migrations WHERE name LIKE '%/@latticedx/%'")));
    if (!expected.length || expected.some(name => !applied.includes(name))) throw Error('Native source migrations are not all applied');
    report.migrations = expected;
    await save('plugins-and-migrations-installed');
    if (blankSlate) {
      const ordersCnt = String(await sql('SELECT count(*) FROM "latticeOrders"')).trim();
      const incidentsCnt = String(await sql('SELECT count(*) FROM "latticeIncidentCases"')).trim();
      if (ordersCnt !== '0' || incidentsCnt !== '0') throw Error(`Expected 0 demo rows with LATTICE_SKIP_DEMO_SEED=1, got orders=${ordersCnt}, incidents=${incidentsCnt}`);
      const roleCnt = String(await sql("SELECT count(*) FROM roles WHERE name IN ('ldx_admin','ldx_director','ldx_manager','ldx_operator','ldx_warehouse','ldx_dispatcher','ldx_driver','ldx_employee')")).trim();
      if (roleCnt !== '8') throw Error(`Expected 8 ldx_* roles, got ${roleCnt}`);
      const archProf = String(await sql(`SELECT count(*) FROM "latticeAiProfiles" WHERE username='dxos-architect'`)).trim();
      const archEmp = String(await sql(`SELECT count(*) FROM "aiEmployees" WHERE username='dxos-architect'`)).trim();
      if (archProf !== '1' || archEmp !== '1') throw Error(`Expected dxos-architect in profiles(${archProf}) & aiEmployees(${archEmp})`);
      const rlsPair = String(await sql("SELECT relrowsecurity::text || ',' || relforcerowsecurity::text FROM pg_class WHERE relname='latticeBuiltApps'")).trim();
      if (!/^(?:t|true),(?:t|true)$/i.test(rlsPair)) throw Error(`Expected FORCE RLS on latticeBuiltApps, got ${rlsPair}`);
      report.blankSlateDbProof = { ordersCount: 0, incidentsCount: 0, ldxRolesCount: 8, architectBootstrapped: true, builtAppsForceRls: true };
      report.blankSlateLifecycle = await runBlankSlateLifecycleCheck(plan.origin);
      report.packages = [];
      for (const directory of ['action-bridge', 'plugin-lattice-foundation', 'plugin-enterprise-auth', 'plugin-dxos-para', 'plugin-dxos-blocks', 'plugin-dxos-studio', 'plugin-dxos-ai']) {
        const metadata = JSON.parse(await readFile(join(plan.sourceRoot, 'plugins/nocobase', directory, 'package.json'), 'utf8'));
        report.packages.push({ name: metadata.name, version: metadata.version, license: metadata.license });
      }
      report.complete = true;
      await save('blank-slate-app-builder-passed');
      return { ...report, reportPath: join(plan.directory, 'report.json'), composeArgs: plan.composeArgs };
    }
    const dockerCtx = resolveDockerContext();
    const env = { ...process.env, NOCOBASE_URL: plan.origin, NOCOBASE_DB_CONTAINER: plan.project + '-nocobase-db-1' };
    if (dockerCtx) env.DOCKER_CONTEXT = dockerCtx;
    else delete env.DOCKER_CONTEXT;
    report.acceptance = [];
    for (const script of ['acceptance-native-foundation.mjs', 'acceptance-native-documents.mjs']) {
      const result = jsonOutput(await command(process.execPath, ['scripts/' + script], { cwd: plan.sourceRoot, env }));
      if (result.result !== 'PASS') throw Error('Native acceptance did not pass');
      report.acceptance.push({ script, ...result });
    }
    await command(process.execPath, ['scripts/setup-native-ui-lab.mjs'], { cwd: plan.sourceRoot, env });
    const ui = JSON.parse(await readFile(join(plan.sourceRoot, 'output/native-platform/ui-lab.json'), 'utf8'));
    report.pageUrl = plan.origin + ui.path;
    report.fixtureAccounts = ui.accounts.map(({ email, role }) => ({ email, role }));
    report.packages = [];
    for (const directory of ['action-bridge', 'plugin-lattice-foundation', 'plugin-enterprise-auth', 'plugin-dxos-para', 'plugin-dxos-blocks', 'plugin-dxos-studio', 'plugin-dxos-ai']) {
      const metadata = JSON.parse(await readFile(join(plan.sourceRoot, 'plugins/nocobase', directory, 'package.json'), 'utf8'));
      report.packages.push({ name: metadata.name, version: metadata.version, license: metadata.license });
    }
    report.limits=['Native API acceptance and persisted UI fixture, not browser E2E.',
      'Keycloak, model, broker, n8n, shared files and legacy stores not accepted by this run.',
      'Package license inventory covers owned packages only; preserve upstream notices and licenses.',
      'Local fixture credentials; never expose this lab publicly.'];
    report.complete=true;
    await save('native-api-acceptance-passed');
    return {...report,reportPath:join(plan.directory,'report.json'),composeArgs:plan.composeArgs};
  }catch(error){report.error=error.message;await save('failed');throw Object.assign(error,{reportPath:join(plan.directory,'report.json')});}
  finally{
    if(blankSlate&&!keep){
      await compose(['down','-v','--remove-orphans'],120000).catch(()=>{});
    }
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const opts=parseCleanInstallArgs(process.argv.slice(2));
    nativeCleanInstall({port:opts.port,blankSlate:opts.blankSlate,keep:opts.keep,onProgress:value=>console.log(JSON.stringify(value))})
      .then(value=>console.log(JSON.stringify({result:'PASS',project:value.project,sourceCommit:value.sourceCommit,blankSlate:value.blankSlate,blankSlateDbProof:value.blankSlateDbProof,blankSlateLifecycle:value.blankSlateLifecycle,pageUrl:value.pageUrl,reportPath:value.reportPath,fullSystemAcceptance:false})))
      .catch(error=>{console.error(JSON.stringify({result:'FAIL',error:error.message,reportPath:error.reportPath}));process.exitCode=1;});
  }catch(err){console.error(err.message);process.exitCode=1;}
}
