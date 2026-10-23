// SPDX-License-Identifier: Apache-2.0
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),esbuild=createRequire(require.resolve('tsx/package.json'))('esbuild');
const bundle=esbuild.buildSync({entryPoints:['scripts/uc1-database-acceptance.ts'],bundle:true,platform:'node',format:'cjs',external:['pg'],write:false,logLevel:'silent'}).outputFiles[0].contents;
try{console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','node'],{input:bundle,encoding:'utf8',timeout:60000,maxBuffer:1024*1024}).trim());}catch{console.error('UC1 SQL acceptance failed; raw output withheld.');process.exitCode=1;}
