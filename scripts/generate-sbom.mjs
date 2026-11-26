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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, '..');

export const BANNED_LICENSE_RE = /\bbsl(?:-1\.1)?\b|business[\s_-]*source[\s_-]*license/i;
export const BANNED_TECH_RE = /\b(thingsboard|emqx)\b/i;

export const OCI_IMAGE_LICENSES = Object.freeze({
  'apache/apisix': () => ({ kind: 'id', value: 'Apache-2.0' }),
  caddy: () => ({ kind: 'id', value: 'Apache-2.0' }),
  'clamav/clamav': () => ({ kind: 'id', value: 'GPL-2.0-only' }),
  'eclipse-mosquitto': () => ({ kind: 'expression', value: 'EPL-2.0 OR BSD-3-Clause' }),
  'gotenberg/gotenberg': () => ({ kind: 'id', value: 'MIT' }),
  'grafana/grafana-oss': () => ({ kind: 'id', value: 'AGPL-3.0-only' }),
  'adorsys/keycloak-config-cli': () => ({ kind: 'id', value: 'Apache-2.0' }),
  'quay.io/keycloak/keycloak': () => ({ kind: 'id', value: 'Apache-2.0' }),
  mongo: () => ({ kind: 'id', value: 'SSPL-1.0' }),
  'n8nio/n8n': () => ({ kind: 'name', value: 'Sustainable Use License' }),
  'nocobase/nocobase': () => ({
    kind: 'name',
    value: 'NocoBase License Agreement (2026-02-24; Apache-2.0 + Clauses 4.2, 5.1-5.4)',
  }),
  'nodered/node-red': () => ({ kind: 'id', value: 'Apache-2.0' }),
  'otel/opentelemetry-collector-contrib': () => ({ kind: 'id', value: 'Apache-2.0' }),
  'fiware/orion-ld': () => ({ kind: 'id', value: 'AGPL-3.0-only' }),
  'pgvector/pgvector': () => ({ kind: 'id', value: 'PostgreSQL' }),
  postgres: () => ({ kind: 'id', value: 'PostgreSQL' }),
  'prom/prometheus': () => ({ kind: 'id', value: 'Apache-2.0' }),
  redis: (tag) => {
    if (/^7\.[0-2](?:$|-)/.test(tag || '')) return { kind: 'id', value: 'BSD-3-Clause' };
    if (/^[89]\./.test(tag || '')) return { kind: 'expression', value: 'LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only' };
    return { kind: 'expression', value: 'LicenseRef-RSALv2 OR SSPL-1.0' };
  },
  'rustfs/rustfs': () => ({ kind: 'id', value: 'Apache-2.0' }),
  'timescale/timescaledb': (tag) => (
    /(?:^|-)oss(?:$|-)/i.test(tag || '')
      ? { kind: 'id', value: 'Apache-2.0' }
      : { kind: 'name', value: 'Timescale License (TSL)' }
  ),
  'valkey/valkey': () => ({ kind: 'id', value: 'BSD-3-Clause' }),
});

const PLATFORM_BINARY_FAMILIES = [
  { re: /^@esbuild\/[a-z0-9-]+$/i, parent: 'esbuild', siblingRe: /^@esbuild\/[a-z0-9-]+$/i },
  { re: /^@rolldown\/binding-[a-z0-9-]+$/i, parent: 'rolldown', siblingRe: /^@rolldown\/binding-[a-z0-9-]+$/i },
  { re: /^@typescript\/typescript-[a-z0-9-]+$/i, parent: 'typescript', siblingRe: /^@typescript\/typescript-[a-z0-9-]+$/i },
  { re: /^lightningcss-[a-z0-9-]+$/i, parent: 'lightningcss', siblingRe: /^lightningcss-[a-z0-9-]+$/i },
  { re: /^@img\/sharp-(?:libvips-)?[a-z0-9-]+$/i, parent: 'sharp', siblingRe: /^@img\/sharp-(?:libvips-)?[a-z0-9-]+$/i },
  { re: /^@next\/swc-[a-z0-9-]+$/i, parent: 'next', siblingRe: /^@next\/swc-[a-z0-9-]+$/i },
];

export const PLATFORM_OPTIONAL_PACKAGE_LICENSES = Object.freeze({
  'fsevents@2.3.3': ['MIT'],
});

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

function classifyLicenseValue(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (/\s+(?:AND|OR|WITH)\s+|[()]/i.test(trimmed)) {
    return { kind: 'expression', value: trimmed };
  }
  if (/\s/.test(trimmed)) {
    return { kind: 'name', value: trimmed };
  }
  return { kind: 'id', value: trimmed };
}

function formatCycloneDxLicenseItem(item) {
  if (!item) return null;
  if (item.kind === 'expression') return { expression: item.value };
  if (item.kind === 'name') return { license: { name: item.value } };
  return { license: { id: item.value } };
}

function buildCycloneDxLicenses(licenseValues) {
  const rawList = Array.isArray(licenseValues) ? licenseValues : [licenseValues];
  const classified = rawList
    .map((entry) => (typeof entry === 'object' && entry && entry.kind ? entry : classifyLicenseValue(entry)))
    .filter(Boolean);
  if (classified.length === 0) return undefined;
  if (classified.length === 1) {
    return [formatCycloneDxLicenseItem(classified[0])];
  }
  if (classified.some((item) => item.kind === 'expression')) {
    return [{ expression: classified.map((item) => `(${item.value})`).join(' AND ') }];
  }
  return classified.map(formatCycloneDxLicenseItem);
}

function buildCycloneDxLicense(licenseStr) {
  if (!licenseStr || typeof licenseStr !== 'string') return undefined;
  return buildCycloneDxLicenses([licenseStr]);
}

export function resolveOciImageLicense(repo, tag = '') {
  const normalizedRepo = String(repo || '')
    .trim()
    .replace(/^docker\.io\/(?:library\/)?/i, '')
    .replace(/^library\//i, '');
  const resolver = OCI_IMAGE_LICENSES[normalizedRepo];
  if (typeof resolver !== 'function') return null;
  return resolver(String(tag || '').trim());
}

function extractPackageLicense(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  if (typeof pkg.license === 'string' && pkg.license.trim()) {
    return pkg.license.trim();
  }
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string' && pkg.license.type.trim()) {
    return pkg.license.type.trim();
  }
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const parts = pkg.licenses
      .map((item) => (typeof item === 'string' ? item.trim() : String(item?.type || '').trim()))
      .filter(Boolean);
    if (parts.length === 1) return parts[0];
    if (parts.length > 1) return parts.join(' OR ');
  }
  return null;
}

function collectInstalledNpmLicenses(rootDir) {
  const exactMap = new Map();
  const visitedDirs = new Set();

  const recordManifest = (pkgJsonPath) => {
    if (!existsSync(pkgJsonPath)) return;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      return;
    }
    const name = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
    const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
    const lic = extractPackageLicense(pkg);
    if (!name || !version || !lic) return;
    const key = `${name}@${version}`;
    if (!exactMap.has(key)) exactMap.set(key, new Set());
    exactMap.get(key).add(lic);
  };

  const scanNodeModulesDir = (nmDir) => {
    if (!existsSync(nmDir)) return;
    let real;
    try {
      real = realpathSync(nmDir);
    } catch {
      return;
    }
    if (visitedDirs.has(real)) return;
    visitedDirs.add(real);

    let entries;
    try {
      entries = readdirSync(nmDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const full = join(nmDir, entry.name);
      if (entry.name === '.pnpm' && entry.isDirectory()) {
        let storeEntries;
        try {
          storeEntries = readdirSync(full, { withFileTypes: true });
        } catch {
          storeEntries = [];
        }
        for (const storeEntry of storeEntries) {
          if (!storeEntry.isDirectory()) continue;
          scanNodeModulesDir(join(full, storeEntry.name, 'node_modules'));
        }
        continue;
      }

      if (entry.name.startsWith('@')) {
        let scopeEntries;
        try {
          scopeEntries = readdirSync(full, { withFileTypes: true });
        } catch {
          scopeEntries = [];
        }
        for (const scoped of scopeEntries) {
          if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
          const pkgDir = join(full, scoped.name);
          recordManifest(join(pkgDir, 'package.json'));
          const nestedNm = join(pkgDir, 'node_modules');
          if (existsSync(nestedNm)) scanNodeModulesDir(nestedNm);
        }
        continue;
      }

      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      recordManifest(join(full, 'package.json'));
      const nestedNm = join(full, 'node_modules');
      if (existsSync(nestedNm)) scanNodeModulesDir(nestedNm);
    }
  };

  scanNodeModulesDir(join(rootDir, 'node_modules'));
  for (const base of [join(rootDir, 'apps'), join(rootDir, 'packages'), join(rootDir, 'plugins', 'nocobase')]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      scanNodeModulesDir(join(base, entry.name, 'node_modules'));
    }
  }

  return exactMap;
}

function resolveInstalledLicenseForPackage(name, version, installedMap) {
  const exactKey = `${name}@${version}`;
  const staticFallback = PLATFORM_OPTIONAL_PACKAGE_LICENSES[exactKey] || [];
  if (!installedMap || installedMap.size === 0) return staticFallback;
  if (installedMap.has(exactKey)) {
    return Array.from(installedMap.get(exactKey)).sort(compareAscii);
  }

  const family = PLATFORM_BINARY_FAMILIES.find((item) => item.re.test(name));
  if (!family) return staticFallback;

  const siblingLicenses = new Set();
  const suffix = `@${version}`;
  for (const [key, licSet] of installedMap.entries()) {
    if (!key.endsWith(suffix)) continue;
    const candidateName = key.slice(0, key.length - suffix.length);
    if (candidateName === family.parent || family.siblingRe.test(candidateName)) {
      for (const lic of licSet) siblingLicenses.add(lic);
    }
  }
  return siblingLicenses.size === 1 ? Array.from(siblingLicenses) : staticFallback;
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
    version: String(rootPkg.version || '0.4.2'),
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
      const ociLicense = resolveOciImageLicense(repo, tag);
      if (ociLicense) {
        assertAllowedLicense(ociLicense.value, `OCI image ${tag ? `${repo}:${tag}` : repo}`);
      }
      return {
        type: 'container',
        'bom-ref': purl,
        name: tag ? `${repo}:${tag}` : repo,
        version: `sha256:${digest}`,
        purl,
        hashes: [{ alg: 'SHA-256', content: digest }],
        ...(ociLicense ? { licenses: buildCycloneDxLicenses([ociLicense]) } : {}),
        properties: [
          { name: 'latticedx:category', value: 'oci-image' },
          { name: 'latticedx:imageRef', value: ref },
          { name: 'latticedx:composeFiles', value: Array.from(composeFiles).sort(compareAscii).join(',') },
        ],
      };
    });
}

function mergeThirdPartyEntries(entries, installedLicenseMap = new Map()) {
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
      if (item.licenses.size === 0) {
        for (const diskLic of resolveInstalledLicenseForPackage(item.name, item.version, installedLicenseMap)) {
          item.licenses.add(diskLic);
        }
      }
      const licensesList = Array.from(item.licenses).sort(compareAscii);
      for (const lic of licensesList) {
        assertAllowedLicense(lic, `${item.name}@${item.version}`);
      }
      const hashesList = Array.from(item.hashes.entries())
        .sort(([ka], [kb]) => compareAscii(ka, kb))
        .map(([, val]) => val);
      const sourcesList = Array.from(item.sources).sort(compareAscii);
      const licenses = buildCycloneDxLicenses(licensesList);

      return {
        type: 'library',
        'bom-ref': item.purl,
        name: item.name,
        version: item.version,
        purl: item.purl,
        ...(hashesList.length > 0 ? { hashes: hashesList } : {}),
        ...(licenses ? { licenses } : {}),
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

  const installedLicenseMap = collectInstalledNpmLicenses(rootDir);
  const thirdPartyComponents = mergeThirdPartyEntries([...pnpmEntries, ...authEntries], installedLicenseMap);
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
            version: String(rootComponent.version || '0.4.2'),
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
