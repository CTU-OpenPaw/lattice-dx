/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultRun} from './install-workspace.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function startLocal({integration=false,hasIntegrationEnv=existsSync(resolve(root,'.env.integration')),platform=process.platform,run=defaultRun}={}){
 if(integration&&!hasIntegrationEnv)throw Error('Create ignored .env.integration before starting integration services; no services changed.');
 const context=platform==='win32'?['--context','desktop-linux']:[];
 const compose=[...context,'compose',...(hasIntegrationEnv?['--env-file',resolve(root,'.env.integration')]:[])];
 const files=['core','nocobase',...(integration?['integration']:[])];
 async function command(file,args,stage,timeout=60000){
  try{return await run(file,args,{timeout});}catch{throw Error(stage+'; raw command output withheld.');}
 }
 // Validate every selected stack before starting Docker or changing containers.
 for(const name of files)await command('docker',[...compose,'-f',resolve(root,'infra/compose',name+'.yml'),'config','--quiet'],'Compose validation failed: '+name);
 if(platform==='win32')await command('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve(root,'scripts/docker-desktop.ps1'),'-Mode','Start'],'Docker Desktop startup failed',240000);
 else await command('docker',['info','--format','{{.ServerVersion}}'],'Docker engine is unavailable');
 for(const name of files)await command('docker',[...compose,'-f',resolve(root,'infra/compose',name+'.yml'),'up','-d',...(name==='core'?['--build']:[])],'Stack startup failed: '+name,600000);
 return {result:'started',envFile:hasIntegrationEnv?'.env.integration':null,stacks:files,businessFlowsVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2).filter(a=>a!=='--');
 if(args.some(a=>a!=='--integration')){console.error('Usage: pnpm local:up [--integration]');process.exitCode=1;}
 else startLocal({integration:args.includes('--integration')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
