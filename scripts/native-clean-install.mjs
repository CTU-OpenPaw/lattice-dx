/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {defaultRun,installWorkspace} from './install-workspace.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export function cleanInstallPlan(id,port=13004){
  if(!/^[a-f0-9]{12}$/.test(id)||!Number.isInteger(port)||port<13004||port>13999)throw Error('Use a generated clean-lab ID and port13004–13999');
  const project='lattice-native-clean-'+id,directory=resolve(root,'output/native-clean',id),sourceRoot=join(directory,'source');
  const origin='http://localhost:'+port,overlayPath=join(directory,'overlay.yml');
  const overlay=`# Local disposable native lab; never production credentials.\nservices:\n  nocobase-db:\n    volumes:\n      - clean-db:/var/lib/postgresql/data\n  nocobase:\n    ports: !override\n      - "127.0.0.1:${port}:80"\n    environment:\n      DX_BRIDGE_CALLBACK_URL: ${origin}/api/dxActions:callback\n      DX_NATIVE_AUTH_ORIGIN: ${origin}\n      DX_NATIVE_CONTEXT_AUTO_SYNC: "false"\n    volumes:\n      - clean-storage:/app/nocobase/storage\nvolumes:\n  clean-db:\n  clean-storage:\n`;
  const composeArgs=['--context','desktop-linux','compose','-p',project,'-f','infra/compose/native-rehearsal.yml','-f',overlayPath];
  return {project,directory,sourceRoot,origin,overlayPath,overlay,composeArgs};
}
export function assertUnusedCleanProject(resources){
  if(resources.length!==3||resources.some(value=>String(value).trim()!==''))throw Error('Clean project already owns resources; refusing reuse');
}
export function assertEmptyNativeDatabase(value){
  if(String(value).trim()!=='0')throw Error('Clean database is not empty; refusing bootstrap');
}
async function waitHealthy(origin){
  const deadline=Date.now()+180000;
  do{
    try{const r=await fetch(origin+'/api/app:getLang',{redirect:'error',signal:AbortSignal.timeout(3000)});if(r.ok)return;}catch{}
    await delay(750);
  }while(Date.now()<deadline);
  throw Error('Clean runtime did not become healthy');
}
function jsonOutput(bytes){return JSON.parse(String(bytes).trim().split('\n').at(-1));}

export async function nativeCleanInstall({run=defaultRun,port=13004,onProgress=()=>{}}={}){
  const plan=cleanInstallPlan(randomUUID().replaceAll('-','').slice(0,12),port);
  const report={format:'latticedx.native-clean-install',version:1,project:plan.project,origin:plan.origin,sourceRoot:plan.sourceRoot,
    complete:false,phase:'preflight',integrationsVerified:false,fullSystemAcceptance:false};
  const command=async(file,args,{cwd=root,timeout=120000,env=process.env}={})=>{
    try{return await run(file,args,{cwd,timeout,env,shell:false});}
    catch{throw Error('Clean-install command failed; output withheld');}
  };
  const docker=args=>command('docker',['--context','desktop-linux',...args]);
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
    report.runtimeVersion=String(await compose(['exec','-T','nocobase','node','-e',"console.log(require('@nocobase/server/package.json').version)"])).trim();
    if(report.runtimeVersion!=='2.2.38')throw Error('Unexpected native runtime version');
    const migrationPlugins = [
      { directory: 'plugin-lattice-foundation', pkg: '@latticedx/plugin-lattice-foundation' },
      { directory: 'plugin-dxos-para', pkg: '@latticedx/plugin-dxos-para' },
      { directory: 'plugin-dxos-studio', pkg: '@latticedx/plugin-dxos-studio' },
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
    const env = { ...process.env, DOCKER_CONTEXT: 'desktop-linux', NOCOBASE_URL: plan.origin, NOCOBASE_DB_CONTAINER: plan.project + '-nocobase-db-1' };
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
    for (const directory of ['action-bridge', 'plugin-lattice-foundation', 'plugin-enterprise-auth', 'plugin-dxos-para', 'plugin-dxos-blocks', 'plugin-dxos-studio']) {
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
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const valid=args.length===0||(args.length===1&&/^--port=\d+$/.test(args[0]));
  if(!valid){console.error('Usage: node scripts/native-clean-install.mjs [--port=13004]');process.exitCode=1;}
  else nativeCleanInstall({port:args.length?Number(args[0].slice(7)):13004,onProgress:value=>console.log(JSON.stringify(value))})
    .then(value=>console.log(JSON.stringify({result:'PASS',project:value.project,sourceCommit:value.sourceCommit,pageUrl:value.pageUrl,reportPath:value.reportPath,fullSystemAcceptance:false})))
    .catch(error=>{console.error(JSON.stringify({result:'FAIL',error:error.message,reportPath:error.reportPath}));process.exitCode=1;});
}
