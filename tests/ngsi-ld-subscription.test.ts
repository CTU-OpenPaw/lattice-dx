// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from 'vitest';
// Scripts execute directly as ESM; this workspace does not emit declarations for .mjs scripts.
// @ts-expect-error No declaration file for the standalone script.
import { registerSubscription } from '../scripts/lib/ngsi-ld-subscription.mjs';
test('subscription receiverInfo does not duplicate the tenant header automatically forwarded by Orion-LD', async () => {
  const token = 'a'.repeat(64);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await registerSubscription({ token, tenant: 'org-a', id: 'urn:ngsi-ld:Subscription:test', context: {}, baseUrl: 'http://broker.test', receiverUrl: 'http://gateway.test/notify' });
    const request = fetchMock.mock.calls[1][1];
    const definition = JSON.parse(request.body);
    // Outbound operation carries tenant; broker supplies that header to the receiver.
    expect(request.headers['NGSILD-Tenant']).toBe('org-a');
    const extraHeaders = definition.notification.endpoint.receiverInfo;
    expect(extraHeaders).toEqual([{ key: 'X-Lattice-Broker-Token', value: token }]);
    expect(extraHeaders.some((h: { key: string }) => h.key.toLowerCase() === 'ngsild-tenant')).toBe(false);
  } finally { log.mockRestore(); vi.unstubAllGlobals(); }
});
