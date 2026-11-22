/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
export const CONTEXT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function resolveDockerContext({ platform = process.platform, env = process.env } = {}) {
  if (env && Object.hasOwn(env, 'DOCKER_CONTEXT')) {
    const raw = typeof env.DOCKER_CONTEXT === 'string' ? env.DOCKER_CONTEXT.trim() : '';
    if (!raw || raw.toLowerCase() === 'none') {
      return null;
    }
    if (!CONTEXT_NAME_RE.test(raw)) {
      throw new Error('Invalid DOCKER_CONTEXT name');
    }
    return raw;
  }
  return platform === 'win32' ? 'desktop-linux' : null;
}

export function dockerContextArgs(options = {}) {
  const ctx = resolveDockerContext(options);
  return ctx ? ['--context', ctx] : [];
}

export function dockerArgs(args = [], options = {}) {
  return [...dockerContextArgs(options), ...args];
}
