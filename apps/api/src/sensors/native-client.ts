// SPDX-License-Identifier: Apache-2.0
import {
  buildNativeSensorEnvelope,
  type NativeObservationTrace,
} from './native-envelope.js';

export class NativeSensorDeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly httpStatus: number | null = null,
  ) {
    super(code);
    this.name = 'NativeSensorDeliveryError';
  }
}

export type NativeSensorDeliveryResult =
  | {
      status: 'accepted';
      inboxId: string;
      eventId: string;
      duplicate: boolean;
      trace: NativeObservationTrace;
    }
  | {
      status: 'skipped';
      reason: 'VALUE_MISSING' | 'VALUE_INVALID';
      trace: NativeObservationTrace;
    };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function receiptId(value: unknown): string | null {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    return null;
  }

  if (
    typeof value === 'number' &&
    !Number.isSafeInteger(value)
  ) {
    return null;
  }

  const id = String(value);

  if (
    !/^[1-9][0-9]{0,18}$/.test(id) ||
    BigInt(id) > 9_223_372_036_854_775_807n
  ) {
    return null;
  }

  return id;
}

async function readReceipt(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new NativeSensorDeliveryError(
      'NATIVE_INVALID_RECEIPT',
      true,
    );
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;

      size += part.value.byteLength;

      if (size > 16_384) {
        await reader.cancel();
        throw new NativeSensorDeliveryError(
          'NATIVE_RECEIPT_TOO_LARGE',
          true,
        );
      }

      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new NativeSensorDeliveryError(
      'NATIVE_INVALID_RECEIPT',
      true,
    );
  }
}

/**
 * Construct on the server using a trusted native origin and a dedicated
 * connector user's credential. Never accept these options from sensor data.
 *
 * This client performs one delivery attempt. A durable caller owns retry.
 * The credential's actual native authority is verified by the receiver.
 */
export function createNativeSensorClient(options: {
  baseUrl: string;
  token: string;
  organizationId: string;
  sourceSystem: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const {
    baseUrl,
    token,
    organizationId,
    sourceSystem,
    timeoutMs = 10_000,
    fetchImpl = fetch,
  } = options;

  const base = new URL(baseUrl);

  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  ) {
    throw new Error('Native base URL must be a trusted HTTP(S) origin.');
  }

  if (
    typeof token !== 'string' ||
    !token ||
    token.length > 8192 ||
    /[\s\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new Error('Invalid native connector credential.');
  }

  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(organizationId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceSystem) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    throw new Error('Invalid native sensor client configuration.');
  }

  const endpoint = new URL(
    '/api/latticeIntegrations:receive',
    base,
  ).toString();

  return {
    async deliver(input: unknown): Promise<NativeSensorDeliveryResult> {
      const built = buildNativeSensorEnvelope(input, {
        organizationId,
        sourceSystem,
      });

      if (built.status === 'skipped') {
        return built;
      }

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(built.envelope),
        });

        if (response.status !== 200 && response.status !== 201) {
          await response.body?.cancel();

          throw new NativeSensorDeliveryError(
            `NATIVE_HTTP_${response.status}`,
            response.status === 408 ||
              response.status === 429 ||
              response.status >= 500,
            response.status,
          );
        }

        const body = await readReceipt(response);
        const data = object(body) ? body.data : undefined;

        if (!object(data)) {
          throw new NativeSensorDeliveryError(
            'NATIVE_INVALID_RECEIPT',
            true,
          );
        }

        const inboxId = receiptId(data.id);

        if (
          inboxId === null ||
          data.accepted !== true ||
          typeof data.duplicate !== 'boolean'
        ) {
          throw new NativeSensorDeliveryError(
            'NATIVE_INVALID_RECEIPT',
            true,
          );
        }

        return {
          status: 'accepted',
          inboxId,
          eventId: built.envelope.eventId,
          duplicate: data.duplicate,
          trace: built.trace,
        };
      } catch (error) {
        if (error instanceof NativeSensorDeliveryError) {
          throw error;
        }

        // Do not expose credentials, payloads or upstream error messages.
        throw new NativeSensorDeliveryError(
          'NATIVE_TRANSPORT_FAILED',
          true,
        );
      }
    },
  };
}