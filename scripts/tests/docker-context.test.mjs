/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerArgs, dockerContextArgs, resolveDockerContext } from '../lib/docker-context.mjs';

test('resolveDockerContext defaults to desktop-linux only on win32 when DOCKER_CONTEXT is unset', () => {
  assert.equal(resolveDockerContext({ platform: 'win32', env: {} }), 'desktop-linux');
  assert.equal(resolveDockerContext({ platform: 'linux', env: {} }), null);
  assert.equal(resolveDockerContext({ platform: 'darwin', env: {} }), null);
});

test('resolveDockerContext honors explicit DOCKER_CONTEXT and disabling values', () => {
  assert.equal(resolveDockerContext({ platform: 'linux', env: { DOCKER_CONTEXT: 'custom-ctx' } }), 'custom-ctx');
  assert.equal(resolveDockerContext({ platform: 'win32', env: { DOCKER_CONTEXT: '' } }), null);
  assert.equal(resolveDockerContext({ platform: 'win32', env: { DOCKER_CONTEXT: 'none' } }), null);
  assert.equal(resolveDockerContext({ platform: 'win32', env: { DOCKER_CONTEXT: 'NONE' } }), null);
});

test('resolveDockerContext rejects flag injection or unsafe context names', () => {
  for (const bad of ['--bad', '-c', 'a;rm -rf /', 'ctx/slash', 'ctx space', 'x'.repeat(65)]) {
    assert.throws(() => resolveDockerContext({ platform: 'linux', env: { DOCKER_CONTEXT: bad } }), /Invalid DOCKER_CONTEXT/);
  }
});

test('dockerContextArgs and dockerArgs build safe cross-platform argument arrays', () => {
  assert.deepEqual(dockerContextArgs({ platform: 'win32', env: {} }), ['--context', 'desktop-linux']);
  assert.deepEqual(dockerContextArgs({ platform: 'linux', env: {} }), []);
  assert.deepEqual(dockerArgs(['compose', 'ps'], { platform: 'linux', env: {} }), ['compose', 'ps']);
  assert.deepEqual(
    dockerArgs(['compose', 'ps'], { platform: 'linux', env: { DOCKER_CONTEXT: 'remote-prod' } }),
    ['--context', 'remote-prod', 'compose', 'ps'],
  );
});
