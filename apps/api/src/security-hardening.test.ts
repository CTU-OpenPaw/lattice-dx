/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createApi, createRateLimiter } from './app.js';
import { EntityError, parseSchema } from './entities/policy.js';
import { createFilesystemStore } from './files/filesystem-store.js';
import { validateSteps } from './workflows/block-policy.js';
import { WorkflowError } from './workflows/policy.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  delete process.env.API_RATE_LIMIT_MAX;
});

describe('prototype pollution / remote property injection guards', () => {
  test('parseSchema blocks __proto__, constructor, and prototype without polluting Object.prototype', () => {
    for (const badKey of ['__proto__', 'constructor', 'prototype']) {
      const payload = JSON.parse(
        `{"id":"safe-schema","title":"Safe","fields":{"${badKey}":{"type":"text"}}}`,
      );
      expect(() => parseSchema(payload)).toThrow(EntityError);

      const relPayload = JSON.parse(
        `{"id":"safe-schema","title":"Safe","fields":{"ok":{"type":"text"}},"relations":{"${badKey}":{"targetSchemaId":"safe-schema"}}}`,
      );
      expect(() => parseSchema(relPayload)).toThrow(EntityError);
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test('validateSteps blocks __proto__, constructor, and prototype across step ids, projections, and evaluations', () => {
    const empty = new Set<string>();
    for (const badKey of ['__proto__', 'constructor', 'prototype']) {
      const projectStep = JSON.parse(
        `[{"id":"${badKey}","action":"entities.project","input":{"id":{"source":"literal","value":"1"},"fields":["title"]}}]`,
      );
      expect(() => validateSteps(projectStep, empty, empty)).toThrow(WorkflowError);

      const evalStep = JSON.parse(
        `[{"id":"${badKey}","action":"data.evaluate","input":{"values":{"ok":{"op":"literal","value":{"type":"integer","value":1}}}}}]`,
      );
      expect(() => validateSteps(evalStep, empty, empty)).toThrow(WorkflowError);

      const evalFieldStep = JSON.parse(
        `[{"id":"eval1","action":"data.evaluate","input":{"values":{"${badKey}":{"op":"literal","value":{"type":"integer","value":1}}}}}]`,
      );
      expect(() => validateSteps(evalFieldStep, empty, empty)).toThrow(WorkflowError);
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('filesystem-store open-first race hardening', () => {
  test('readVerified opens before stat/realpath and rejects directories and symlinks cleanly', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dx-fs-hardening-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const openRoot = process.platform === 'win32'
      ? async (r: string) => ({
          stat: async () => (await import('node:fs/promises')).lstat(r),
          sync: async () => {},
          close: async () => {},
        })
      : undefined;

    const store = await createFilesystemStore(root, openRoot ? { openRoot } : undefined);
    const written = await store.writeVerified(Buffer.from('hardened-content'));
    expect((await store.readVerified({ provider: 'filesystem', ...written })).toString('utf8')).toBe('hardened-content');

    // Replace stored object with a symlink to another file and verify open-first readVerified rejects
    const targetFile = join(root, 'outside-target');
    await writeFile(targetFile, 'hardened-content');
    const objPath = join(root, written.objectKey);
    await rm(objPath);
    let linked = false;
    try {
      await symlink(targetFile, objPath, 'file');
      linked = true;
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException)?.code === 'EPERM') {
        // Windows unprivileged environments may disallow file symlinks
      } else {
        throw err;
      }
    }
    if (linked) {
      await expect(store.readVerified({ provider: 'filesystem', ...written })).rejects.toThrow();
    }
  });
});

describe('API sliding-window per-IP rate limiter', () => {
  test('enforces API_RATE_LIMIT_MAX with X-RateLimit-* headers and returns 429 on excess', async () => {
    process.env.API_RATE_LIMIT_MAX = '3';
    const app = createApi({ workerUrl: 'http://127.0.0.1:1' });
    cleanups.push(() => app.close());

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.10' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      expect(res.headers['x-ratelimit-remaining']).toBe(String(2 - i));
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    }

    const blocked = await app.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.10' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // Separate IP remains unaffected
    const otherIp = await app.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.11' });
    expect(otherIp.statusCode).toBe(200);
    expect(otherIp.headers['x-ratelimit-remaining']).toBe('2');
  });

  test('sliding window decays previous window weight and caps tracked IPs at 10,000', () => {
    const limiter = createRateLimiter(4, 60_000);
    const t0 = 60_000 * 100; // aligned window start

    for (let i = 0; i < 4; i++) {
      expect(limiter.check('198.51.100.1', t0 + 1000).allowed).toBe(true);
    }
    expect(limiter.check('198.51.100.1', t0 + 2000).allowed).toBe(false);

    // Halfway through the next window (weight 0.5 * 4 = 2), 2 more requests are allowed
    const halfwayNext = t0 + 60_000 + 30_000;
    expect(limiter.check('198.51.100.1', halfwayNext).allowed).toBe(true);
    expect(limiter.check('198.51.100.1', halfwayNext).allowed).toBe(true);
    expect(limiter.check('198.51.100.1', halfwayNext).allowed).toBe(false);

    // Cap at 10,000 keys under high-cardinality IP flood
    for (let i = 0; i < 10_200; i++) {
      limiter.check(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, halfwayNext);
    }
    expect(limiter.size).toBeLessThanOrEqual(10_000);
  });
});
