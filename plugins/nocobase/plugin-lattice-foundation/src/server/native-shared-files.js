/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHmac, randomUUID } = require('node:crypto');

function createNativeSharedFiles({ url, secret, instance }) {
  if (!url && !secret && !instance) return undefined;
  if (!url || !/^[a-f0-9]{64}$/i.test(secret ?? '') || !/^[a-zA-Z0-9_-]{1,80}$/.test(instance ?? '')) {
    throw Error('Invalid shared native file service configuration');
  }
  const endpoint = new URL('/internal/native-request-files', url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw Error('Invalid shared native file service URL');
  }
  const key = Buffer.from(secret, 'hex');

  return async function sharedFiles(ctx, operation, { id, actor }, values) {
    const body = JSON.stringify({
      ...values, instance, at: Date.now(), nonce: randomUUID(), operation, organizationId: actor.organizationId, requestId: id, userId: actor.userId,
    });
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-DX-Native-Signature': createHmac('sha256', key).update(body).digest('hex') },
        body, redirect: 'error', signal: AbortSignal.timeout(20000),
      });
    } catch {
      ctx.throw(503, 'Dịch vụ tệp chưa sẵn sàng.');
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      if ([400, 404, 409, 413].includes(response.status)) ctx.throw(response.status, detail.error ?? 'Không xử lý được tệp.');
      ctx.throw(503, 'Dịch vụ tệp chưa sẵn sàng.');
    }
    if (operation === 'download') {
      return { disposition: response.headers.get('content-disposition'), content: Buffer.from(await response.arrayBuffer()) };
    }
    return { status: response.status, data: await response.json() };
  };
}

module.exports = { createNativeSharedFiles };
