/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */

export type ClaimedSensorAlert = {
  id: string;
  organizationId: string;
  evaluationId: string;
  attempt: number;
  leaseToken: string;
  sourceSystem: string;
  eventId: string;
  assetEntityId: string;
  assetUrn: string;
  ruleId: string;
  ruleVersion: number;
  observedAt: string;
  evaluatedAt: string;
  sourcePayload: Record<string, unknown>;
  ruleSnapshot: Record<string, unknown>;
  mappingSnapshot: Record<string, unknown>;
  evaluation: Record<string, unknown>;
};

export type AlertDeliveryReceipt = {
  targetRecordId: string;
  receipt: Record<string, unknown>;
};

export class AlertDeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'AlertDeliveryError';
  }
}

export type AlertSettlement =
  | {
      status: 'succeeded';
      targetRecordId: string;
      receipt: Record<string, unknown>;
    }
  | {
      status: 'pending' | 'failed';
      errorCode: string;
      retrySeconds: number;
    };

export interface SensorAlertQueue {
  /**
   * Must claim atomically within the configured tenant.
   * The database implementation owns lease expiry and attempt limits.
   */
  claim(): Promise<ClaimedSensorAlert | null>;

  /**
   * Must compare tenant, alert ID, lease token and unexpired lease.
   * False means this worker no longer owns the delivery.
   */
  settle(
    alert: ClaimedSensorAlert,
    result: AlertSettlement,
  ): Promise<boolean>;
}

export interface SensorAlertTransport {
  /**
   * Repeated delivery must use the same key and immutable business payload.
   * Attempt number and lease token are internal queue metadata.
   *
   * The receiver must deduplicate: local leases alone cannot prevent
   * duplicate remote effects after a timeout or worker crash.
   *
   * Implementations must honor signal and obtain credentials server-side.
   */
  deliver(input: {
    alert: ClaimedSensorAlert;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<AlertDeliveryReceipt>;
}

export type AlertWorkerResult =
  | { outcome: 'idle' }
  | {
      outcome: 'succeeded' | 'retry' | 'failed' | 'lease_lost';
      alertId: string;
      attempt: number;
      errorCode: string | null;
    };

function safeErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : 'ALERT_DELIVERY_FAILED';
}

export function createSensorAlertWorker(options: {
  queue: SensorAlertQueue;
  transport: SensorAlertTransport;
  maxAttempts?: number;
  timeoutMs?: number;
}) {
  const {
    queue,
    transport,
    maxAttempts = 5,
    timeoutMs = 10_000,
  } = options;

  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    throw new Error('Invalid sensor alert worker configuration.');
  }

  return {
    async runOnce(): Promise<AlertWorkerResult> {
      const alert = await queue.claim();

      if (!alert) return { outcome: 'idle' };

      if (
        !Number.isSafeInteger(alert.attempt) ||
        alert.attempt < 1 ||
        alert.attempt > maxAttempts
      ) {
        throw new Error('Queue returned an invalid alert attempt.');
      }

      let settlement: AlertSettlement;
      let outcome: 'succeeded' | 'retry' | 'failed';
      let errorCode: string | null = null;

      try {
        const delivered = await transport.deliver({
          alert,
          idempotencyKey: `uc2-alert:${alert.id}`,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (
          typeof delivered?.targetRecordId !== 'string' ||
          !delivered.targetRecordId.trim() ||
          delivered.targetRecordId.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(delivered.targetRecordId) ||
          !delivered.receipt ||
          typeof delivered.receipt !== 'object' ||
          Array.isArray(delivered.receipt)
        ) {
          throw new AlertDeliveryError(
            'ALERT_INVALID_RECEIPT',
            true,
          );
        }

        settlement = {
          status: 'succeeded',
          targetRecordId: delivered.targetRecordId,
          receipt: delivered.receipt,
        };
        outcome = 'succeeded';
      } catch (error) {
        errorCode = error instanceof AlertDeliveryError
          ? safeErrorCode(error.code)
          : 'ALERT_DELIVERY_FAILED';

        const retryable = !(error instanceof AlertDeliveryError) ||
          error.retryable;

        const retry = retryable && alert.attempt < maxAttempts;

        settlement = {
          status: retry ? 'pending' : 'failed',
          errorCode,
          retrySeconds: retry
            ? Math.min(300, 5 * 2 ** (alert.attempt - 1))
            : 0,
        };
        outcome = retry ? 'retry' : 'failed';
      }

      // Keep database settlement outside the delivery catch.
      // If settlement fails, lease recovery handles the uncertain result.
      const settled = await queue.settle(alert, settlement);

      return {
        outcome: settled ? outcome : 'lease_lost',
        alertId: alert.id,
        attempt: alert.attempt,
        errorCode,
      };
    },
  };
}