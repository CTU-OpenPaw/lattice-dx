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
const require=createRequire(import.meta.url);
const esbuild=createRequire(require.resolve('tsx/package.json'))('esbuild');
const directory=mkdtempSync(join(tmpdir(),'agent-acceptance-'));
try{
 const bundle=join(directory,'fixture.cjs');
 esbuild.buildSync({entryPoints:['scripts/agent-jobs-acceptance.ts'],bundle:true,platform:'node',format:'cjs',external:['pg'],outfile:bundle,logLevel:'silent'});
 const result=execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','node'],{input:readFileSync(bundle),encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024});
 console.log(result.trim());
}finally{const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('agent-acceptance-'))throw new Error('Unsafe temporary bundle directory');rmSync(target,{recursive:true,force:true});}
