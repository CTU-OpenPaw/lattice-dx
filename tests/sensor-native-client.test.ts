/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeSensorClient,
} from '../apps/api/src/sensors/native-client.js';

function fixture() {
  return {
    schemaVersion: 1,
    eventId: 'sim:native-client-fixture',
    assetUrn: 'urn:ngsi-ld:Asset:org-a:native:12',
    attribute: 'temperature',
    unit: 'celsius',
    value: 85,
    observedAt: '2026-11-14T05:00:00.000Z',
    source: {
      system: 'latticedx-simulator',
      deviceId: 'simulated-temperature-001',
    },
    simulated: true,
  };
}

function setup() {
  const fetchImpl = vi.fn<typeof fetch>();

  const client = createNativeSensorClient({
    baseUrl: 'http://localhost:13000',
    token: 'fixture-native-token',
    organizationId: 'org-a',
    sourceSystem: 'latticedx-simulator',
    fetchImpl,
  });

  return { client, fetchImpl };
}

function accepted(duplicate = false) {
  return Response.json({
    data: { id: '42', accepted: true, duplicate },
  });
}

describe('native sensor HTTP client', () => {
  it('posts the envelope to the fixed authenticated endpoint', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(accepted());

    const result = await client.deliver(fixture());

    expect(result).toMatchObject({
      status: 'accepted',
      inboxId: '42',
      duplicate: false,
      trace: { simulated: true, sourceSystem: 'latticedx-simulator' },
    });

    const [url, options] = fetchImpl.mock.calls[0];

    expect(url).toBe(
      'http://localhost:13000/api/latticeIntegrations:receive',
    );
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        Authorization: 'Bearer fixture-native-token',
        'Content-Type': 'application/json',
      },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(options?.body as string);
    expect(body.observedAt).toBe(fixture().observedAt);
    expect(body.data.assetId).toBe('12');
    expect(Object.keys(body).sort()).toEqual([
      'data', 'eventId', 'kind', 'observedAt',
    ]);
  });

  it('replays exactly the same body and accepts a duplicate receipt', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(accepted(true));

    const first = await client.deliver(fixture());
    const second = await client.deliver(fixture());

    expect(second).toMatchObject({
      status: 'accepted',
      inboxId: '42',
      duplicate: true,
    });
    expect(first.status).toBe('accepted');
    expect(fetchImpl.mock.calls[1][1]?.body)
      .toBe(fetchImpl.mock.calls[0][1]?.body);
  });

  it('does not send missing measurements', async () => {
    const { client, fetchImpl } = setup();
    const { value: _value, ...input } = fixture();

    expect(await client.deliver(input)).toMatchObject({
      status: 'skipped',
      reason: 'VALUE_MISSING',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [409, false],
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ])('classifies HTTP %s without automatic retry', async (status, retryable) => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(
      new Response('private upstream details', { status }),
    );

    await expect(client.deliver(fixture())).rejects.toMatchObject({
      code: `NATIVE_HTTP_${status}`,
      retryable,
      httpStatus: status,
      message: `NATIVE_HTTP_${status}`,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { data: { id: '42', accepted: false, duplicate: false } },
    { data: { id: '42', accepted: true } },
    { data: { id: 0, accepted: true, duplicate: false } },
    { data: { id: '01', accepted: true, duplicate: false } },
    {
      data: {
        id: 9_007_199_254_740_992,
        accepted: true,
        duplicate: false,
      },
    },
  ])('rejects an invalid receipt: %j', async body => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json(body));

    await expect(client.deliver(fixture())).rejects.toMatchObject({
      code: 'NATIVE_INVALID_RECEIPT',
      retryable: true,
    });
  });

  it('rejects invalid JSON on a successful response', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response('<html>login</html>'));

    await expect(client.deliver(fixture())).rejects.toMatchObject({
      code: 'NATIVE_INVALID_RECEIPT',
      retryable: true,
    });
  });

  it('bounds the response body size', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response('x'.repeat(16_385)));

    await expect(client.deliver(fixture())).rejects.toMatchObject({
      code: 'NATIVE_RECEIPT_TOO_LARGE',
      retryable: true,
    });
  });

  it('returns a safe error for uncertain network failures', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockRejectedValueOnce(
      new Error('private network details and credential'),
    );

    await expect(client.deliver(fixture())).rejects.toMatchObject({
      code: 'NATIVE_TRANSPORT_FAILED',
      message: 'NATIVE_TRANSPORT_FAILED',
      retryable: true,
    });
  });

  it('rejects a foreign tenant before calling HTTP', async () => {
    const { client, fetchImpl } = setup();

    await expect(client.deliver({
      ...fixture(),
      assetUrn: 'urn:ngsi-ld:Asset:org-b:native:12',
    })).rejects.toThrow();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});