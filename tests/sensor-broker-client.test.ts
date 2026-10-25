// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from 'vitest';
import { createSensorBrokerClient } from '../apps/api/src/sensors/broker-client';
import { buildSensorProjection } from '../apps/api/src/sensors/projection';
import { generateSensorFixtures } from '../scripts/lib/sensor-simulator.mjs';

const assetUrn = 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001';

const options = {
  baseUrl: 'http://broker:1026',
  tenant: 'org-a',
};

function projection() {
  const reading = generateSensorFixtures({
    assetUrn,
    referenceTime: '2026-10-24T08:00:00.000Z',
  })[0];

  const result = buildSensorProjection(reading, 'org-a');
  if (result.kind !== 'ready') throw new Error('Expected ready projection');
  return result;
}

test('reads the exact Asset with tenant header and bounded request', async () => {
  const entity = { id: assetUrn, type: 'Asset' };
  const fetchImpl = vi.fn(async () => Response.json(entity));
  const client = createSensorBrokerClient(
    options,
    fetchImpl as typeof fetch,
  );

  expect(await client.getAsset(assetUrn)).toEqual(entity);
  expect(fetchImpl).toHaveBeenCalledTimes(1);

  const [url, init] = fetchImpl.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];

  expect(url).toBe(
    `http://broker:1026/ngsi-ld/v1/entities/${encodeURIComponent(assetUrn)}`,
  );
  expect(init.method).toBe('GET');
  expect(init.redirect).toBe('error');
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.headers).toMatchObject({ 'NGSILD-Tenant': 'org-a' });
});

test('appends only the projected sensor attribute to the existing Asset', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  const client = createSensorBrokerClient(
    options,
    fetchImpl as typeof fetch,
  );

  const input = projection();
  await client.appendMeasurement(input);

  expect(fetchImpl).toHaveBeenCalledTimes(1);

  const [url, init] = fetchImpl.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];

  expect(url).toBe(
    `http://broker:1026/ngsi-ld/v1/entities/${encodeURIComponent(assetUrn)}/attrs`,
  );
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({
    'NGSILD-Tenant': 'org-a',
    'Content-Type': 'application/json',
  });

  expect(JSON.parse(init.body as string)).toEqual({
    [input.attribute]: input.property,
  });
});

test.each([207, 400, 404, 409, 500])(
  'HTTP %i is not a successful complete write and is not retried',
  async status => {
    const fetchImpl = vi.fn(async () => new Response(null, { status }));
    const client = createSensorBrokerClient(
      options,
      fetchImpl as typeof fetch,
    );

    await expect(client.appendMeasurement(projection()))
      .rejects.toMatchObject({
        code: 'BROKER_WRITE_FAILED',
        status,
      });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  },
);

test('rejects cross-tenant reads and writes before network access', async () => {
  const fetchImpl = vi.fn();
  const client = createSensorBrokerClient(options, fetchImpl);
  const foreignUrn = 'urn:ngsi-ld:Asset:org-b:foreign-asset';

  await expect(client.getAsset(foreignUrn))
    .rejects.toMatchObject({ code: 'ASSET_ID_INVALID' });

  await expect(client.appendMeasurement({
    ...projection(),
    assetUrn: foreignUrn,
  })).rejects.toMatchObject({ code: 'ASSET_ID_INVALID' });

  expect(fetchImpl).not.toHaveBeenCalled();
});

test('rejects a non-sensor write before network access', async () => {
  const fetchImpl = vi.fn();
  const client = createSensorBrokerClient(options, fetchImpl);

  await expect(client.appendMeasurement({
    ...projection(),
    attribute: 'https://latticedx.example/ns/status',
  })).rejects.toMatchObject({ code: 'SENSOR_ATTRIBUTE_INVALID' });

  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([
  { id: 'urn:ngsi-ld:Asset:org-a:wrong-asset' },
  null,
  [],
])('rejects an invalid or mismatched entity response: %j', async body => {
  const client = createSensorBrokerClient(
    options,
    vi.fn(async () => Response.json(body)) as typeof fetch,
  );

  await expect(client.getAsset(assetUrn))
    .rejects.toMatchObject({ code: 'BROKER_RESPONSE_INVALID' });
});

test('rejects non-JSON and oversized read responses', async () => {
  for (const [body, code] of [
    ['<html>private upstream details</html>', 'BROKER_RESPONSE_INVALID'],
    ['x'.repeat(131073), 'BROKER_RESPONSE_TOO_LARGE'],
  ]) {
    const client = createSensorBrokerClient(
      options,
      vi.fn(async () => new Response(body)) as typeof fetch,
    );

    await expect(client.getAsset(assetUrn))
      .rejects.toMatchObject({ code });
  }
});

test('a missing Asset fails instead of creating one', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
  const client = createSensorBrokerClient(
    options,
    fetchImpl as typeof fetch,
  );

  await expect(client.getAsset(assetUrn)).rejects.toMatchObject({
    code: 'BROKER_READ_FAILED',
    status: 404,
  });

  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('transport failures expose a safe code without automatic retry', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('private connection details');
  });

  const client = createSensorBrokerClient(
    options,
    fetchImpl as typeof fetch,
  );

  await expect(client.appendMeasurement(projection()))
    .rejects.toMatchObject({
      code: 'BROKER_TRANSPORT_FAILED',
      message: 'BROKER_TRANSPORT_FAILED',
    });

  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('request deadline aborts a stalled transport', async () => {
  const fetchImpl = vi.fn(
    async (_url: unknown, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(signal.reason),
          { once: true },
        );
      }),
  );

  const client = createSensorBrokerClient(
    { ...options, timeoutMs: 20 },
    fetchImpl as typeof fetch,
  );

  await expect(client.getAsset(assetUrn))
    .rejects.toMatchObject({ code: 'BROKER_TRANSPORT_FAILED' });

  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each([
  { baseUrl: 'http://user:password@broker:1026' },
  { baseUrl: 'http://broker:1026/private' },
  { baseUrl: 'http://broker:1026/?token=secret' },
  { baseUrl: 'ftp://broker' },
  { tenant: 'bad tenant' },
  { timeoutMs: 0 },
  { timeoutMs: 30001 },
])('rejects unsafe configuration before network access: %j', change => {
  const fetchImpl = vi.fn();

  expect(() => createSensorBrokerClient(
    { ...options, ...change },
    fetchImpl,
  )).toThrow();

  expect(fetchImpl).not.toHaveBeenCalled();
});