// SPDX-License-Identifier: Apache-2.0
import {describe,it,expect,vi} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cleanInstallPlan,assertUnusedCleanProject,assertEmptyNativeDatabase,nativeCleanInstall} from '../scripts/native-clean-install.mjs';

async function orchestratorFixture(count='0'){
  const calls:{file:string,args:string[],options:any}[]=[];
  const directories=['action-bridge','plugin-lattice-foundation','plugin-enterprise-auth','plugin-dxos-para','plugin-dxos-blocks','plugin-dxos-studio'];
  const names=['@latticedx/plugin-action-bridge','@latticedx/plugin-lattice-foundation','@latticedx/plugin-enterprise-auth','@latticedx/plugin-dxos-para','@latticedx/plugin-dxos-blocks','@latticedx/plugin-dxos-studio'];
  const migrations=[
    { pkg:'@latticedx/plugin-lattice-foundation', dir:'plugin-lattice-foundation', name:'20261107000100-shared-upload-receipts/@latticedx/plugin-lattice-foundation' },
    { pkg:'@latticedx/plugin-dxos-para', dir:'plugin-dxos-para', name:'20261120000100-dxos-para-init/@latticedx/plugin-dxos-para' },
    { pkg:'@latticedx/plugin-dxos-studio', dir:'plugin-dxos-studio', name:'20261120000200-dxos-service-tickets/@latticedx/plugin-dxos-studio' },
  ];
  const run=async(file:string,args:string[],options:any)=>{
    calls.push({file,args,options});
    if(file==='git'&&args[0]==='rev-parse')return 'a'.repeat(40);
    if(file==='tar'){
      const target=args.at(-1)!;
      for(let i=0;i<names.length;i++){
        const directory=join(target,'plugins/nocobase',directories[i]);
        await mkdir(directory,{recursive:true});await writeFile(join(directory,'package.json'),JSON.stringify({name:names[i],version:'1.2.3',license:'Apache-2.0'}));
      }
      for(const m of migrations){
        const directory=join(target,'plugins/nocobase',m.dir,'src/server/migrations');
        await mkdir(directory,{recursive:true});await writeFile(join(directory,m.name.split('/')[0]+'.js'),'');
      }
    }
    if(args.includes('psql'))return args.at(-1)?.includes('pg_tables')?count:JSON.stringify(migrations.map(m=>m.name));
    if(args.includes('pg_dump'))return Buffer.from('PGDMP-test-fixture');
    if(args.at(-1)==='list')return '--- BEGIN_PLUGIN_LIST_JSON ---\n'+JSON.stringify(names.map(packageName=>({packageName,enabled:true})))+'\n--- END_PLUGIN_LIST_JSON ---';
    if(args.some(arg=>arg.includes('WORKSPACE_PACKAGE_METADATA')))return JSON.stringify(names.map(name=>({name,version:'1.2.3'})));
    if(args.some(arg=>arg.includes("require('@nocobase/server/package.json')")))return '2.2.38';
    if(file===process.execPath&&args[0]?.includes('acceptance-native-'))return JSON.stringify({result:'PASS',checks:['test-fixture']});
    if(file===process.execPath&&args[0]==='scripts/setup-native-ui-lab.mjs'){
      const directory=join(options.cwd,'output/native-platform');await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'ui-lab.json'),JSON.stringify({path:'/admin/fixture',accounts:[{email:'fixture@example.invalid',role:'ldx_employee'}]}));
    }
    return '';
  };
  return {calls,run};
}

describe('clean native installation boundaries',()=>{
  it('targets a unique loopback-only project and isolated exported source',()=>{
    const plan=cleanInstallPlan('a'.repeat(12),13004);
    expect(plan.project).toBe('lattice-native-clean-'+ 'a'.repeat(12));
    expect(plan.origin).toBe('http://localhost:13004');
    expect(plan.sourceRoot).toContain('output');
    expect(plan.sourceRoot).not.toBe(process.cwd());
    expect(plan.overlay).toContain('127.0.0.1:13004:80');
    expect(plan.overlay).not.toContain('external: true');
    expect(plan.composeArgs).toContain(plan.project);
  });
  it('refuses reserved ports and malformed project IDs before Docker operations',()=>{
    for(const port of [13000,13001,13003,8080,NaN,13004.5,14000])expect(()=>cleanInstallPlan('a'.repeat(12),port)).toThrow();
    for(const id of ['../main','', 'lattice-dx','a'.repeat(13)])expect(()=>cleanInstallPlan(id,13004)).toThrow();
  });
  it('never reuses a project with existing containers, volumes or networks',()=>{
    expect(()=>assertUnusedCleanProject(['','',''])).not.toThrow();
    for(const resources of [['container','',''],['','volume',''],['','','network']])expect(()=>assertUnusedCleanProject(resources)).toThrow();
  });
  it('requires explicit proof of an empty public schema before app bootstrap',()=>{
    expect(()=>assertEmptyNativeDatabase('0\n')).not.toThrow();
    for(const count of ['1','116','','invalid','0\n1'])expect(()=>assertEmptyNativeDatabase(count)).toThrow();
  });
  it('does not boot the app or install plugins when the new schema is nonempty',async()=>{
    const f=await orchestratorFixture('5');
    await expect(nativeCleanInstall({run:f.run})).rejects.toThrow('not empty');
    expect(f.calls.some(call=>call.args.includes('up')&&call.args.at(-1)==='nocobase')).toBe(false);
    expect(f.calls.some(call=>call.args.includes('pg_dump'))).toBe(false);
  });
  it('keeps preflight, install and child fixtures on desktop-linux despite another inherited context',async()=>{
    const f=await orchestratorFixture();
    vi.stubEnv('DOCKER_CONTEXT','different-daemon');
    vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true} as Response);
    try{
      const result=await nativeCleanInstall({run:f.run});
      expect(result.complete).toBe(true);expect(result.fullSystemAcceptance).toBe(false);
      expect(result.packages).toHaveLength(6);
      for(const call of f.calls.filter(call=>call.file==='docker'))expect(call.args.slice(0,2)).toEqual(['--context','desktop-linux']);
      const setup=f.calls.find(call=>call.args[0]==='scripts/setup-native-ui-lab.mjs')!;
      expect(setup.options.env.DOCKER_CONTEXT).toBe('desktop-linux');
      expect(setup.options.cwd).toBe(result.sourceRoot);
      const proof=f.calls.findIndex(call=>call.args.includes('psql')&&call.args.at(-1)?.includes('pg_tables'));
      const boot=f.calls.findIndex(call=>call.args.includes('up')&&call.args.at(-1)==='nocobase');
      expect(proof).toBeGreaterThan(-1);expect(boot).toBeGreaterThan(proof);
    }finally{vi.restoreAllMocks();vi.unstubAllEnvs();}
  });
});
