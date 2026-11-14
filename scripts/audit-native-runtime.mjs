/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {mkdir, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const base = new URL(process.env.NOCOBASE_URL ?? 'http://localhost:13000');
const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const runtimeContainer=args.container??'lattice-dx-nocobase-1';
const reportPath=args.report??'output/native-platform/runtime-audit.json';
if(!/^lattice[-a-z0-9]*nocobase-1$/.test(runtimeContainer))throw Error('Unexpected audit container');
if(!/^output\/native-platform\/[-a-z0-9]+\.json$/.test(reportPath))throw Error('Audit report must be under output/native-platform');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Audit is restricted to the local runtime');
async function request(path, options = {}) {
  const response = await fetch(new URL('/api/' + path, base), {...options, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Native audit HTTP ${response.status} at ${path.split('?')[0]}`);
  return response.json();
}
const login = await request('auth:signIn', {method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({email: process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com', password: process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123'})});
const token = login.data?.token;
if (typeof token !== 'string') throw new Error('Native login did not return a token');
const headers = {authorization: `Bearer ${token}`};
const plugins = [];
const seen = new Set();
let pluginListRepeated = false;
for (let page = 1; page <= 20; page++) {
  const list = await request(`pm:list?page=${page}&pageSize=100`, {headers});
  const rows = Array.isArray(list.data) ? list.data : list.data?.items;
  if (!Array.isArray(rows)) throw new Error('Unexpected plugin list envelope');
  if (rows.length && rows.every(row => seen.has(row.name))) { pluginListRepeated = true; break; }
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    const info = await request(`pm:get?filterByTk=${encodeURIComponent(row.name)}`, {headers});
    const data = info.data;
    const checks = data?.packageJson?.peerDependencies ?? {};
    plugins.push({name: row.name, version: row.version, enabled: !!row.enabled,
      compatible: data?.isCompatible ?? null,
      dependencyEvidence: data?.depsCompatible ?? data?.failedDependencies ?? data?.dependencies ?? data?.checkDependencies ?? null,
      declaredPeerDependencies: checks});
  }
  if (rows.length < 100) break;
  if (page === 20) throw new Error('Plugin inventory exceeded audit limit');
}
const packagesScript = `const names=['server','plugin-data-source-main','plugin-users','plugin-acl','plugin-workflow','plugin-workflow-manual','plugin-ai'];console.log(JSON.stringify({server:require('@nocobase/server/package.json').version,axios:require('axios/package.json').version,packages:names.map(n=>{const p=require('@nocobase/'+n+'/package.json');return {name:p.name,version:p.version,license:p.license??null,axiosRange:p.peerDependencies?.axios??p.devDependencies?.axios??null}})}))`;
const runtime = spawnSync('docker', ['exec', runtimeContainer, 'node', '-e', packagesScript], {encoding: 'utf8', windowsHide: true, timeout: 20000});
if (runtime.status !== 0) throw new Error('Could not inspect local runtime package metadata');
const collections = await request('collections:list?pageSize=200', {headers});
const rows = Array.isArray(collections.data) ? collections.data : collections.data?.items;
if (!Array.isArray(rows)) throw new Error('Unexpected collection list envelope');
const report = {capturedAt: new Date().toISOString(), base: base.origin, ...JSON.parse(runtime.stdout),
  pluginCount: plugins.length, plugins, foundationCollections: rows.filter(r => /^lattice/.test(r.name)).map(r => ({name:r.name,title:r.title})),
  pluginListRepeated,
  limits: ['Read-only inventory after local authentication; no plugin installation, enabling or dependency changes.', 'Collection inventory is limited to the first 200 collections.', ...(pluginListRepeated ? ['pm:list repeats the same plugin page: registry inventory is not exhaustive; no completeness claim.'] : [])]};
await mkdir('output/native-platform', {recursive: true});
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({server: report.server, axios: report.axios, pluginCount: report.pluginCount, incompatible:plugins.filter(p=>p.compatible===false).map(p=>p.name),nativeCollections: report.foundationCollections.length, report:reportPath}));
