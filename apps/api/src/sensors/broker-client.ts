// SPDX-License-Identifier: Apache-2.0
import {
  SENSOR_NAMESPACE as ns,
  type SensorProjection,
} from './projection.js';

type ReadyProjection = Extract<SensorProjection, { kind: 'ready' }>;
type Entity = Record<string, unknown>;

export class SensorBrokerError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'SensorBrokerError';
  }
}

const object = (value: unknown): value is Entity =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value);

export function createSensorBrokerClient(
  options: {
    baseUrl: string;
    tenant: string;
    timeoutMs?: number;
  },
  fetchImpl: typeof fetch = fetch,
) {
  const base = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 5000;

  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.tenant) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  ) {
    throw new SensorBrokerError('BROKER_CONFIG_INVALID');
  }

  function validateId(id: string) {
    const prefix = `urn:ngsi-ld:Asset:${options.tenant}:`;

    if (
      typeof id !== 'string' ||
      !id.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id.slice(prefix.length))
    ) {
      throw new SensorBrokerError('ASSET_ID_INVALID');
    }
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ) {
    try {
      return await fetchImpl(
        `${base.origin}/ngsi-ld/v1${path}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Accept: 'application/ld+json',
            'NGSILD-Tenant': options.tenant,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      throw new SensorBrokerError('BROKER_TRANSPORT_FAILED');
    }
  }

  return {
    async getAsset(id: string): Promise<Entity> {
      validateId(id);

      const response = await request(
        'GET',
        `/entities/${encodeURIComponent(id)}`,
      );

      if (response.status !== 200) {
        await response.body?.cancel();
        throw new SensorBrokerError(
          'BROKER_READ_FAILED',
          response.status,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new SensorBrokerError('BROKER_RESPONSE_INVALID');
      }

      const chunks: Uint8Array[] = [];
      let size = 0;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          size += value.byteLength;
          if (size > 131072) {
            await reader.cancel();
            throw new SensorBrokerError('BROKER_RESPONSE_TOO_LARGE');
          }

          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof SensorBrokerError) throw error;
        throw new SensorBrokerError('BROKER_READ_FAILED');
      } finally {
        reader.releaseLock();
      }

      let entity: unknown;

      try {
        entity = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new SensorBrokerError('BROKER_RESPONSE_INVALID');
      }

      if (!object(entity) || entity.id !== id) {
        throw new SensorBrokerError('BROKER_RESPONSE_INVALID');
      }

      return entity;
    },

    async appendMeasurement(projection: ReadyProjection): Promise<void> {
      validateId(projection.assetUrn);

      if (
        !['temperature', 'humidity', 'batteryLevel']
          .some(name => projection.attribute === ns + name)
      ) {
        throw new SensorBrokerError('SENSOR_ATTRIBUTE_INVALID');
      }

      const response = await request(
        'POST',
        `/entities/${encodeURIComponent(projection.assetUrn)}/attrs`,
        { [projection.attribute]: projection.property },
      );

      await response.body?.cancel();

      if (response.status !== 204) {
        throw new SensorBrokerError(
          'BROKER_WRITE_FAILED',
          response.status,
        );
      }
    },
  };
}