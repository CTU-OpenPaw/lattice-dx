/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  buildNativeSensorEnvelope,
} from '../apps/api/src/sensors/native-envelope.js';

const scope = {
  organizationId: 'org-a',
  sourceSystem: 'latticedx-simulator',
};

function fixture() {
  return {
    schemaVersion: 1,
    eventId: 'sim:native-envelope-fixture',
    assetUrn: 'urn:ngsi-ld:Asset:org-a:native:12',
    attribute: 'temperature',
    unit: 'celsius',
    value: 85,
    observedAt: '2026-11-07T08:00:00.000Z',
    source: {
      system: 'latticedx-simulator',
      deviceId: 'simulated-temperature-001',
    },
    simulated: true,
  };
}

describe('native sensor envelope', () => {
  it('builds the exact native ingress fields', () => {
    const result = buildNativeSensorEnvelope(fixture(), scope);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected ready');

    expect(result.envelope).toEqual({
      eventId: expect.stringMatching(/^sensor-[a-f0-9]{64}$/),
      kind: 'observation',
      observedAt: '2026-11-07T08:00:00.000Z',
      data: {
        assetId: '12',
        attribute: 'temperature',
        value: 85,
        unit: 'celsius',
      },
    });

    expect(result.trace).toEqual({
      organizationId: 'org-a',
      sourceSystem: 'latticedx-simulator',
      sourceEventId: 'sim:native-envelope-fixture',
      sourceDeviceId: 'simulated-temperature-001',
      assetUrn: fixture().assetUrn,
      simulated: true,
      quality: 'good',
    });
  });

  it('replays deterministically without modifying the input', () => {
    const input = fixture();
    const before = structuredClone(input);

    expect(buildNativeSensorEnvelope(input, scope))
      .toEqual(buildNativeSensorEnvelope(input, scope));
    expect(input).toEqual(before);
  });

  it('keeps the same ID when payload changes under the same event', () => {
    const original = buildNativeSensorEnvelope(fixture(), scope);
    const changed = buildNativeSensorEnvelope({
      ...fixture(),
      value: 95,
    }, scope);

    if (original.status !== 'ready' || changed.status !== 'ready') {
      throw new Error('Expected ready envelopes');
    }

    expect(changed.envelope.eventId).toBe(original.envelope.eventId);
    expect(changed.envelope.data.value).toBe(95);
    expect(changed.envelope).not.toEqual(original.envelope);
  });

  it('uses a different ID for another source event', () => {
    const first = buildNativeSensorEnvelope(fixture(), scope);
    const second = buildNativeSensorEnvelope({
      ...fixture(),
      eventId: 'sim:another-event',
    }, scope);

    if (first.status !== 'ready' || second.status !== 'ready') {
      throw new Error('Expected ready envelopes');
    }

    expect(second.envelope.eventId).not.toBe(first.envelope.eventId);
  });

  it('separates source systems in the event namespace', () => {
    const first = buildNativeSensorEnvelope(fixture(), scope);
    const input = fixture();
    input.source.system = 'another-simulator';

    const second = buildNativeSensorEnvelope(input, {
      ...scope,
      sourceSystem: 'another-simulator',
    });

    if (first.status !== 'ready' || second.status !== 'ready') {
      throw new Error('Expected ready envelopes');
    }

    expect(second.envelope.eventId).not.toBe(first.envelope.eventId);
  });

  it('skips missing values while retaining simulation trace', () => {
    const { value: _value, ...input } = fixture();
    const result = buildNativeSensorEnvelope(input, scope);

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'VALUE_MISSING',
      trace: { simulated: true, quality: 'missing' },
    });
    expect(result).not.toHaveProperty('envelope');
  });

  it.each(['not-a-number', null, NaN, Infinity])(
    'skips an invalid measurement: %j',
    value => {
      const result = buildNativeSensorEnvelope({
        ...fixture(),
        value,
      }, scope);

      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'VALUE_INVALID',
        trace: { quality: 'invalid' },
      });
      expect(result).not.toHaveProperty('envelope');
    },
  );

  it('requires an explicit mapping for a legacy Asset', () => {
    expect(() => buildNativeSensorEnvelope({
      ...fixture(),
      assetUrn: 'urn:ngsi-ld:Asset:org-a:legacy-asset',
    }, scope)).toThrow('NATIVE_ASSET_MAPPING_REQUIRED');
  });

  it('rejects another tenant', () => {
    expect(() => buildNativeSensorEnvelope({
      ...fixture(),
      assetUrn: 'urn:ngsi-ld:Asset:org-b:native:12',
    }, scope)).toThrow();
  });

  it('rejects a source outside the configured scope', () => {
    const input = fixture();
    input.source.system = 'untrusted-source';

    expect(() => buildNativeSensorEnvelope(input, scope))
      .toThrow('SOURCE_SCOPE_MISMATCH');
  });

  it('keeps record IDs as strings without precision loss', () => {
    const result = buildNativeSensorEnvelope({
      ...fixture(),
      assetUrn: 'urn:ngsi-ld:Asset:org-a:native:9223372036854775807',
    }, scope);

    if (result.status !== 'ready') throw new Error('Expected ready');

    expect(result.envelope.data.assetId).toBe('9223372036854775807');
  });

  it.each(['humidity', 'batteryLevel'])(
    'preserves percent units for %s',
    attribute => {
      const result = buildNativeSensorEnvelope({
        ...fixture(),
        attribute,
        unit: 'percent',
        value: 50,
      }, scope);

      if (result.status !== 'ready') throw new Error('Expected ready');

      expect(result.envelope.data).toMatchObject({
        attribute,
        unit: 'percent',
        value: 50,
      });
    },
  );

  it('does not forward caller-supplied authority fields', () => {
    const result = buildNativeSensorEnvelope({
      ...fixture(),
      organizationId: 'org-b',
      role: 'root',
      actor: 'admin',
      action: 'approve',
    }, scope);

    if (result.status !== 'ready') throw new Error('Expected ready');

    expect(Object.keys(result.envelope).sort()).toEqual([
      'data', 'eventId', 'kind', 'observedAt',
    ]);
    expect(Object.keys(result.envelope.data).sort()).toEqual([
      'assetId', 'attribute', 'unit', 'value',
    ]);
    expect(result.trace.organizationId).toBe('org-a');
  });
});