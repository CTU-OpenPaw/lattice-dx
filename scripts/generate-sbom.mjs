#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, '..');

export const BANNED_LICENSE_RE = /\bbsl(?:-1\.1)?\b|business[\s_-]*source[\s_-]*license/i;
export const BANNED_TECH_RE = /\b(thingsboard|emqx)\b/i;

function compareAscii(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

function readJsonSafe(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function encodeNpmPurl(name, version) {
  const safeName = String(name || '').trim();
  const safeVersion = String(version || '').trim();
  const encodedName = safeName.startsWith('@')
    ? `%40${safeName.slice(1)}`
    : safeName;
  return `pkg:npm/${encodedName}@${encodeURIComponent(safeVersion)}`;
}

function parseIntegrityToCycloneDxHash(integrity) {
  const raw = String(integrity || '').trim();
  const match = raw.match(/^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const algMap = {
    sha512: 'SHA-512',
    sha384: 'SHA-384',
    sha256: 'SHA-256',
    sha1: 'SHA-1',
  };
  const alg = algMap[match[1].toLowerCase()];
  const hex = Buffer.from(match[2], 'base64').toString('hex');
  if (!alg || !hex) return null;
  return { alg, content: hex };
}

export function assertAllowedLicense(licenseValue, contextLabel) {
  if (!licenseValue) return;
  const text = typeof licenseValue === 'string' ? licenseValue : JSON.stringify(licenseValue);
  if (BANNED_LICENSE_RE.test(text)) {
    throw new Error(`Banned license detected in ${contextLabel}: "${text}" (BSL-1.1 / Business Source License is prohibited).`);
  }
}

export function assertAllowedComponentName(nameValue, contextLabel) {
  const text = String(nameValue || '').trim();
  if (text && BANNED_TECH_RE.test(text)) {
    throw new Error(`Banned dependency/image detected in ${contextLabel}: "${text}" (ThingsBoard and EMQX are prohibited).`);
  }
}

function buildCycloneDxLicense(licenseStr) {
  if (!licenseStr || typeof licenseStr !== 'string') return undefined;
  const trimmed = licenseStr.trim();
  if (!trimmed) return undefined;
  return [{ license: { id: trimmed } }];
}

function collectPackageManifestDirs(baseDir) {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareAscii)
    .map((name) => join(baseDir, name, 'package.json'))
    .filter((manifestPath) => existsSync(manifestPath));
}

export function collectWorkspaceComponents(rootDir) {
  const rootPkgPath = join(rootDir, 'package.json');
  if (!existsSync(rootPkgPath)) {
    throw new Error(`Root package.json not found at ${rootPkgPath}`);
  }
  const rootPkg = readJsonSafe(rootPkgPath);
  assertAllowedComponentName(rootPkg.name, 'package.json');
  assertAllowedLicense(rootPkg.license, 'package.json');

  const rootComponent = {
    type: 'application',
    'bom-ref': encodeNpmPurl(rootPkg.name, rootPkg.version),
    name: rootPkg.name,
    version: String(rootPkg.version || '1.0.0'),
    purl: encodeNpmPurl(rootPkg.name, rootPkg.version),
    ...(buildCycloneDxLicense(rootPkg.license) ? { licenses: buildCycloneDxLicense(rootPkg.license) } : {}),
  };

  const groups = [
    { dir: join(rootDir, 'apps'), category: 'workspace-app', type: 'application' },
    { dir: join(rootDir, 'packages'), category: 'workspace-package', type: 'library' },
    { dir: join(rootDir, 'plugins', 'nocobase'), category: 'nocobase-plugin', type: 'library' },
  ];

  const workspaceComponents = [];
  for (const group of groups) {
    for (const manifestPath of collectPackageManifestDirs(group.dir)) {
      const pkg = readJsonSafe(manifestPath);
      const relPath = relative(rootDir, manifestPath).replace(/\\/g, '/');
      if (!pkg.name || !pkg.version) continue;
      assertAllowedComponentName(pkg.name, relPath);
      assertAllowedLicense(pkg.license, relPath);
      const purl = encodeNpmPurl(pkg.name, pkg.version);
      workspaceComponents.push({
        type: group.type,
        'bom-ref': purl,
        name: pkg.name,
        version: String(pkg.version),
        purl,
        ...(pkg.description ? { description: String(pkg.description) } : {}),
        ...(buildCycloneDxLicense(pkg.license) ? { licenses: buildCycloneDxLicense(pkg.license) } : {}),
        properties: [
          { name: 'latticedx:category', value: group.category },
          { name: 'latticedx:manifest', value: relPath },
        ],
      });
    }
  }

  return { rootComponent, workspaceComponents };
}

export function parsePnpmLockPackages(lockContent) {
  const lines = normalizeText(lockContent).split('\n');
  const results = [];
  let inPackages = false;
  let current = null;

  const flush = () => {
    if (current) {
      results.push(current);
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inPackages) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
      }
      continue;
    }

    if (/^[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(line)) {
      flush();
      break;
    }

    const pkgMatch = line.match(/^  ([^:\s][^:]*):\s*$/);
    if (pkgMatch) {
      flush();
      let rawKey = pkgMatch[1].trim();
      if ((rawKey.startsWith("'") && rawKey.endsWith("'")) || (rawKey.startsWith('"') && rawKey.endsWith('"'))) {
        rawKey = rawKey.slice(1, -1);
      }
      // Strip optional peer dependency suffix like pkg@1.0.0(peer@2.0.0)
      const parenIdx = rawKey.indexOf('(');
      const cleanKey = parenIdx > 0 ? rawKey.slice(0, parenIdx) : rawKey;
      const atIdx = cleanKey.lastIndexOf('@');
      if (atIdx <= 0) continue;
      const name = cleanKey.slice(0, atIdx).trim();
      const version = cleanKey.slice(atIdx + 1).trim();
      if (!name || !version) continue;
      assertAllowedComponentName(name, `pnpm-lock.yaml:${i + 1}`);
      current = { name, version, hashes: [], license: null, source: 'pnpm-lock.yaml' };
      continue;
    }

    if (!current) continue;
    const resolutionMatch = line.match(/^\s+resolution:\s*\{[^}]*integrity:\s*([^\s,}]+)/);
    if (resolutionMatch) {
      const parsedHash = parseIntegrityToCycloneDxHash(resolutionMatch[1]);
      if (parsedHash) current.hashes.push(parsedHash);
    }
    const licenseMatch = line.match(/^\s+license:\s*['"]?([^'"\r\n]+)['"]?/);
    if (licenseMatch) {
      assertAllowedLicense(licenseMatch[1].trim(), `pnpm-lock.yaml:${i + 1}`);
      current.license = licenseMatch[1].trim();
    }
  }
  flush();
  return results;
}

export function parseNpmPackageLock(lockJson, sourceLabel = 'plugins/nocobase/plugin-enterprise-auth/package-lock.json') {
  const packagesObj = lockJson && typeof lockJson.packages === 'object' ? lockJson.packages : {};
  const entries = [];
  for (const key of Object.keys(packagesObj).sort(compareAscii)) {
    if (!key) continue;
    const pkg = packagesObj[key];
    if (!pkg || typeof pkg !== 'object' || !pkg.version) continue;
    const nmMarker = 'node_modules/';
    const nmIdx = key.lastIndexOf(nmMarker);
    const name = nmIdx >= 0 ? key.slice(nmIdx + nmMarker.length) : key;
    if (!name) continue;
    assertAllowedComponentName(name, `${sourceLabel} (${key})`);
    if (pkg.license) {
      assertAllowedLicense(pkg.license, `${sourceLabel} (${name}@${pkg.version})`);
    }
    const hashes = [];
    const parsedHash = parseIntegrityToCycloneDxHash(pkg.integrity);
    if (parsedHash) hashes.push(parsedHash);
    entries.push({
      name,
      version: String(pkg.version),
      hashes,
      license: typeof pkg.license === 'string' ? pkg.license.trim() : null,
      source: sourceLabel,
    });
  }
  return entries;
}

function splitImageReference(pinnedRef) {
  const atDigestIdx = pinnedRef.indexOf('@sha256:');
  const nameAndTag = pinnedRef.slice(0, atDigestIdx);
  const digest = pinnedRef.slice(atDigestIdx + '@sha256:'.length).toLowerCase();
  const lastSlash = nameAndTag.lastIndexOf('/');
  const lastColon = nameAndTag.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const repo = hasTag ? nameAndTag.slice(0, lastColon) : nameAndTag;
  const tag = hasTag ? nameAndTag.slice(lastColon + 1) : '';
  const shortName = repo.includes('/') ? repo.slice(repo.lastIndexOf('/') + 1) : repo;
  return { repo, tag, digest, shortName };
}

export function parseComposeImages(rootDir) {
  const composeDir = join(rootDir, 'infra', 'compose');
  if (!existsSync(composeDir)) return [];
  const files = readdirSync(composeDir)
    .filter((file) => /\.(yml|yaml)$/i.test(file))
    .sort(compareAscii);

  const imageMap = new Map();

  for (const file of files) {
    const relPath = `infra/compose/${file}`;
    const lines = normalizeText(readFileSync(join(composeDir, file), 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue;
      const match = line.match(/^\s*(?:-\s*)?image\s*:\s*(.+?)\s*$/);
      if (!match) continue;

      let rawVal = match[1];
      // Strip unquoted trailing YAML comment
      if (!rawVal.startsWith('"') && !rawVal.startsWith("'")) {
        const hashComment = rawVal.search(/\s+#/);
        if (hashComment >= 0) rawVal = rawVal.slice(0, hashComment).trim();
      } else if (
        (rawVal.startsWith('"') && rawVal.includes('"', 1))
        || (rawVal.startsWith("'") && rawVal.includes("'", 1))
      ) {
        const quote = rawVal[0];
        const endQuote = rawVal.indexOf(quote, 1);
        rawVal = rawVal.slice(1, endQuote).trim();
      }

      assertAllowedComponentName(rawVal, `${relPath}:${i + 1}`);
      const pinMatch = rawVal.match(/^([^\s"'#]+@sha256:[a-f0-9]{64})$/i);
      if (!pinMatch) {
        throw new Error(
          `Unpinned OCI image in ${relPath}:${i + 1}: "${rawVal}" must carry an immutable @sha256:<64-hex> digest.`,
        );
      }

      const canonicalRef = pinMatch[1];
      if (!imageMap.has(canonicalRef)) {
        imageMap.set(canonicalRef, { ref: canonicalRef, composeFiles: new Set() });
      }
      imageMap.get(canonicalRef).composeFiles.add(file);
    }
  }

  return Array.from(imageMap.values())
    .sort((a, b) => compareAscii(a.ref, b.ref))
    .map(({ ref, composeFiles }) => {
      const { repo, tag, digest, shortName } = splitImageReference(ref);
      const tagQuery = tag ? `&tag=${encodeURIComponent(tag)}` : '';
      const purl = `pkg:oci/${encodeURIComponent(shortName)}@sha256%3A${digest}?repository_url=${encodeURIComponent(repo)}${tagQuery}`;
      return {
        type: 'container',
        'bom-ref': purl,
        name: tag ? `${repo}:${tag}` : repo,
        version: `sha256:${digest}`,
        purl,
        hashes: [{ alg: 'SHA-256', content: digest }],
        properties: [
          { name: 'latticedx:category', value: 'oci-image' },
          { name: 'latticedx:imageRef', value: ref },
          { name: 'latticedx:composeFiles', value: Array.from(composeFiles).sort(compareAscii).join(',') },
        ],
      };
    });
}

function mergeThirdPartyEntries(entries) {
  const merged = new Map();
  for (const entry of entries) {
    const purl = encodeNpmPurl(entry.name, entry.version);
    if (!merged.has(purl)) {
      merged.set(purl, {
        name: entry.name,
        version: entry.version,
        purl,
        hashes: new Map(),
        licenses: new Set(),
        sources: new Set(),
      });
    }
    const target = merged.get(purl);
    for (const h of entry.hashes || []) {
      target.hashes.set(`${h.alg}:${h.content}`, h);
    }
    if (entry.license) target.licenses.add(entry.license);
    if (entry.source) target.sources.add(entry.source);
  }

  return Array.from(merged.values())
    .sort((a, b) => compareAscii(a.purl, b.purl))
    .map((item) => {
      const licensesList = Array.from(item.licenses).sort(compareAscii);
      for (const lic of licensesList) {
        assertAllowedLicense(lic, `${item.name}@${item.version}`);
      }
      const hashesList = Array.from(item.hashes.entries())
        .sort(([ka], [kb]) => compareAscii(ka, kb))
        .map(([, val]) => val);
      const sourcesList = Array.from(item.sources).sort(compareAscii);

      return {
        type: 'library',
        'bom-ref': item.purl,
        name: item.name,
        version: item.version,
        purl: item.purl,
        ...(hashesList.length > 0 ? { hashes: hashesList } : {}),
        ...(licensesList.length > 0 ? { licenses: licensesList.map((id) => ({ license: { id } })) } : {}),
        properties: [
          { name: 'latticedx:category', value: 'npm-dependency' },
          { name: 'latticedx:lockSources', value: sourcesList.join(',') },
        ],
      };
    });
}

function buildDeterministicSerialNumber(rootComponent, components) {
  const hash = createHash('sha256');
  hash.update(`CycloneDX/1.5\n${rootComponent['bom-ref']}\n`);
  for (const comp of components) {
    const firstHash = comp.hashes?.[0]?.content || '';
    hash.update(`${comp['bom-ref']}|${comp.version}|${firstHash}\n`);
  }
  const hex = hash.digest('hex');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function generateSbom({ rootDir = REPO_ROOT } = {}) {
  const { rootComponent, workspaceComponents } = collectWorkspaceComponents(rootDir);

  const pnpmLockPath = join(rootDir, 'pnpm-lock.yaml');
  const pnpmEntries = existsSync(pnpmLockPath)
    ? parsePnpmLockPackages(readFileSync(pnpmLockPath, 'utf8'))
    : [];

  const authLockRel = 'plugins/nocobase/plugin-enterprise-auth/package-lock.json';
  const authLockPath = join(rootDir, authLockRel);
  const authEntries = existsSync(authLockPath)
    ? parseNpmPackageLock(readJsonSafe(authLockPath), authLockRel)
    : [];

  const thirdPartyComponents = mergeThirdPartyEntries([...pnpmEntries, ...authEntries]);
  const containerComponents = parseComposeImages(rootDir);

  const components = [
    ...workspaceComponents,
    ...thirdPartyComponents,
    ...containerComponents,
  ].sort((a, b) => compareAscii(a['bom-ref'], b['bom-ref']));

  const serialNumber = buildDeterministicSerialNumber(rootComponent, components);

  const dependencies = [
    {
      ref: rootComponent['bom-ref'],
      dependsOn: components.map((c) => c['bom-ref']),
    },
    ...components.map((c) => ({ ref: c['bom-ref'], dependsOn: [] })),
  ];

  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber,
    version: 1,
    metadata: {
      tools: {
        components: [
          {
            type: 'application',
            name: 'lattice-dx-sbom-generator',
            version: String(rootComponent.version || '1.0.0'),
          },
        ],
      },
      component: rootComponent,
    },
    components,
    dependencies,
  };

  return {
    bom,
    counts: {
      workspace: workspaceComponents.length,
      thirdPartyNpm: thirdPartyComponents.length,
      containers: containerComponents.length,
      total: components.length,
    },
  };
}

export function formatSbomJson(bom) {
  return `${JSON.stringify(bom, null, 2)}\n`;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    out: 'docs/sbom-cyclonedx.json',
    outExplicit: false,
    check: false,
    json: false,
    rootDir: REPO_ROOT,
  };
  for (const arg of argv) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--out=')) {
      opts.out = arg.slice('--out='.length).trim() || opts.out;
      opts.outExplicit = true;
    } else if (arg.startsWith('--root=')) {
      opts.rootDir = resolve(arg.slice('--root='.length).trim());
    }
  }
  return opts;
}

export function runSbomCli(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  const { bom, counts } = generateSbom({ rootDir: opts.rootDir });
  const serialized = formatSbomJson(bom);
  const outPath = isAbsolute(opts.out) ? opts.out : resolve(opts.rootDir, opts.out);
  const outRel = relative(opts.rootDir, outPath).replace(/\\/g, '/');

  if (opts.check) {
    if (!existsSync(outPath)) {
      throw new Error(`SBOM file missing at ${outRel}. Run: node scripts/generate-sbom.mjs --out=${outRel}`);
    }
    const existing = normalizeText(readFileSync(outPath, 'utf8'));
    if (existing !== serialized) {
      throw new Error(`SBOM drift detected at ${outRel}. Re-run: node scripts/generate-sbom.mjs --out=${outRel}`);
    }
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'ok',
        mode: 'check',
        outPath: outRel,
        specVersion: bom.specVersion,
        serialNumber: bom.serialNumber,
        counts,
      }, null, 2));
    } else {
      console.log(`SBOM check passed (${outRel}): ${counts.total} components (workspace=${counts.workspace}, npm=${counts.thirdPartyNpm}, oci=${counts.containers}).`);
    }
    return { mode: 'check', outPath, bom, counts };
  }

  if (opts.json && !opts.outExplicit) {
    console.log(serialized.trimEnd());
    return { mode: 'stdout-json', outPath, bom, counts };
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized, 'utf8');

  if (opts.json) {
    console.log(JSON.stringify({
      status: 'ok',
      mode: 'write',
      outPath: outRel,
      specVersion: bom.specVersion,
      serialNumber: bom.serialNumber,
      counts,
    }, null, 2));
  } else {
    console.log(`Generated CycloneDX ${bom.specVersion} SBOM at ${outRel}: ${counts.total} components (workspace=${counts.workspace}, npm=${counts.thirdPartyNpm}, oci=${counts.containers}).`);
  }
  return { mode: 'write', outPath, bom, counts };
}

const isDirectEntry = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(__filename);
if (isDirectEntry) {
  try {
    runSbomCli();
  } catch (err) {
    console.error(`[generate-sbom] ERROR: ${err?.message || String(err)}`);
    process.exit(1);
  }
}
