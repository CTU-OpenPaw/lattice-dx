/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AlertDeliveryError,
  createSensorAlertWorker,
  type ClaimedSensorAlert,
} from '../apps/api/src/sensor-rules/alert-worker.js';

function fixture(): ClaimedSensorAlert {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org-a',
    evaluationId: '22222222-2222-4222-8222-222222222222',
    attempt: 1,
    leaseToken: '33333333-3333-4333-8333-333333333333',
    sourceSystem: 'latticedx-simulator',
    eventId: 'sim:worker-fixture',
    assetEntityId: '44444444-4444-4444-8444-444444444444',
    assetUrn: 'urn:ngsi-ld:Asset:org-a:fixture',
    ruleId: '55555555-5555-4555-8555-555555555555',
    ruleVersion: 1,
    observedAt: '2026-11-07T08:00:00.000Z',
    evaluatedAt: '2026-11-07T08:00:01.000Z',
    sourcePayload: { value: 85 },
    ruleSnapshot: { threshold: 80 },
    mappingSnapshot: {},
    evaluation: { matched: true },
  };
}

function setup(alert: ClaimedSensorAlert | null = fixture()) {
  const queue = {
    claim: vi.fn(async () => alert),
    settle: vi.fn(async (
      _alert: ClaimedSensorAlert,
      _result: unknown,
    ) => true),
  };

  const transport = {
    deliver: vi.fn(async (_input: unknown) => ({
      targetRecordId: 'case-fixture-001',
      receipt: { accepted: true },
    })),
  };

  return {
    queue,
    transport,
    worker: createSensorAlertWorker({ queue, transport }),
  };
}

describe('sensor alert worker', () => {
  it('does nothing when the queue is empty', async () => {
    const { worker, queue, transport } = setup(null);

    expect(await worker.runOnce()).toEqual({ outcome: 'idle' });
    expect(transport.deliver).not.toHaveBeenCalled();
    expect(queue.settle).not.toHaveBeenCalled();
  });

  it('uses a stable key and persists the successful receipt', async () => {
    const alert = fixture();
    const { worker, queue, transport } = setup(alert);

    expect(await worker.runOnce()).toMatchObject({
      outcome: 'succeeded',
      alertId: alert.id,
      attempt: 1,
      errorCode: null,
    });

    expect(transport.deliver).toHaveBeenCalledWith({
      alert,
      idempotencyKey: `uc2-alert:${alert.id}`,
      signal: expect.any(AbortSignal),
    });

    expect(queue.settle).toHaveBeenCalledWith(alert, {
      status: 'succeeded',
      targetRecordId: 'case-fixture-001',
      receipt: { accepted: true },
    });
  });

  it('keeps the delivery key when attempt and lease change', async () => {
    const first = setup();
    const secondAlert = {
      ...fixture(),
      attempt: 2,
      leaseToken: '66666666-6666-4666-8666-666666666666',
    };
    const second = setup(secondAlert);

    await first.worker.runOnce();
    await second.worker.runOnce();

    const firstInput = first.transport.deliver.mock.calls[0][0] as {
      idempotencyKey: string;
    };
    const secondInput = second.transport.deliver.mock.calls[0][0] as {
      idempotencyKey: string;
    };

    expect(secondInput.idempotencyKey).toBe(firstInput.idempotencyKey);
  });

  it.each([
    [1, 5],
    [2, 10],
    [4, 40],
  ])('backs off retryable failure on attempt %s', async (attempt, delay) => {
    const alert = { ...fixture(), attempt };
    const { worker, queue, transport } = setup(alert);

    transport.deliver.mockRejectedValueOnce(
      new AlertDeliveryError('NATIVE_UNAVAILABLE', true),
    );

    expect(await worker.runOnce()).toMatchObject({
      outcome: 'retry',
      errorCode: 'NATIVE_UNAVAILABLE',
    });

    expect(queue.settle).toHaveBeenCalledWith(alert, {
      status: 'pending',
      errorCode: 'NATIVE_UNAVAILABLE',
      retrySeconds: delay,
    });
  });

  it('stops retrying at the attempt limit', async () => {
    const alert = { ...fixture(), attempt: 5 };
    const { worker, queue, transport } = setup(alert);

    transport.deliver.mockRejectedValueOnce(new Error('connection lost'));

    expect(await worker.runOnce()).toMatchObject({
      outcome: 'failed',
      errorCode: 'ALERT_DELIVERY_FAILED',
    });
    expect(queue.settle).toHaveBeenCalledWith(alert, {
      status: 'failed',
      errorCode: 'ALERT_DELIVERY_FAILED',
      retrySeconds: 0,
    });
  });

  it('does not retry a permanent transport error', async () => {
    const { worker, transport } = setup();
    transport.deliver.mockRejectedValueOnce(
      new AlertDeliveryError('NATIVE_FORBIDDEN', false),
    );

    expect(await worker.runOnce()).toMatchObject({
      outcome: 'failed',
      errorCode: 'NATIVE_FORBIDDEN',
    });
  });

  it('does not expose arbitrary upstream error messages', async () => {
    const { worker, transport } = setup();
    transport.deliver.mockRejectedValueOnce(
      new Error('sensitive upstream response'),
    );

    const result = await worker.runOnce();

    expect(result).toMatchObject({
      outcome: 'retry',
      errorCode: 'ALERT_DELIVERY_FAILED',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('rejects an invalid receipt as an uncertain delivery', async () => {
    const { worker, transport } = setup();
    transport.deliver.mockResolvedValueOnce({
      targetRecordId: '',
      receipt: {},
    });

    expect(await worker.runOnce()).toMatchObject({
      outcome: 'retry',
      errorCode: 'ALERT_INVALID_RECEIPT',
    });
  });

  it('reports lease loss instead of claiming successful settlement', async () => {
    const { worker, queue } = setup();
    queue.settle.mockResolvedValueOnce(false);

    expect(await worker.runOnce()).toMatchObject({
      outcome: 'lease_lost',
    });
  });

  it('propagates database settlement failure without settling again', async () => {
    const { worker, queue, transport } = setup();
    queue.settle.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(worker.runOnce()).rejects.toThrow('database unavailable');
    expect(transport.deliver).toHaveBeenCalledTimes(1);
    expect(queue.settle).toHaveBeenCalledTimes(1);
  });
});