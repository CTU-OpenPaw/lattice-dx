/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),esbuild=createRequire(require.resolve('tsx/package.json'))('esbuild');
const directory=mkdtempSync(join(tmpdir(),'incident-acceptance-'));
try{
 const live=process.argv.includes('--live-worker');
 if(live&&(!process.env.AGENT_API_KEY||process.env.AGENT_MODEL!=='combo'||process.env.AGENT_BASE_URL!=='http://localhost:20128/v1'))throw Error('Live fixture requires the confirmed local 9router endpoint and combo model');
 const bundle=join(directory,'fixture.cjs');
 esbuild.buildSync({entryPoints:['scripts/incident-agent-acceptance.ts'],bundle:true,platform:'node',format:'cjs',external:['pg','fastify','jose'],outfile:bundle,logLevel:'silent'});
 // Credentials travel over stdin only, never CLI arguments, logs, or container files.
 const prefix=live?`process.env.LIVE_AGENT_CONFIG=${JSON.stringify(JSON.stringify({baseUrl:process.env.AGENT_BASE_URL,apiKey:process.env.AGENT_API_KEY,model:'combo'}))};\n`:'';
 try{
  const result=execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','node'],{input:Buffer.concat([Buffer.from(prefix),readFileSync(bundle)]),encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,stdio:['pipe','pipe','pipe']});
  console.log(result.trim());
 }catch(error){if(live)throw Error('Live worker acceptance failed; credentials and raw subprocess output suppressed');throw error;}
}finally{
 const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('incident-acceptance-'))throw Error('Unsafe temporary bundle directory');
 rmSync(target,{recursive:true,force:true});
}
