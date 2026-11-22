/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowEvent } from '@dx/contracts';

type EntityType = 'Asset' | 'Department' | 'Location';

export type EntityMapping = {
  organizationId: string;
  sourceSystem: string;
  sourceEntityType: EntityType;
  sourceId: string;
  brokerUrn: string;
  name?: string;
};

export type MappingOptions = {
  organizationId: string;
  sourceSystem: string;
  mappings: readonly EntityMapping[];
};

export class AssetMappingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssetMappingError';
  }
}

function fail(code: string, message: string): never {
  throw new AssetMappingError(code, message);
}

function requiredText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('INVALID_FIELD', `${field}: nonblank text without surrounding whitespace required`);
  }
  return value;
}

function validateTime(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    fail('INVALID_TIME', 'occurredAt: UTC ISO 8601 timestamp required');
  }

  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    fail('INVALID_TIME', 'occurredAt: invalid calendar date');
  }

  // Preserve the source timestamp, including its fractional precision.
  return value;
}

function resolve(
  options: MappingOptions,
  type: EntityType,
  sourceId: string,
) {
  const matches = options.mappings.filter(
    (mapping) =>
      mapping.organizationId === options.organizationId &&
      mapping.sourceSystem === options.sourceSystem &&
      mapping.sourceEntityType === type &&
      mapping.sourceId === sourceId,
  );

  if (matches.length === 0) {
    fail('MAPPING_NOT_FOUND', `Missing ${type} mapping`);
  }
  if (matches.length !== 1) {
    fail('AMBIGUOUS_MAPPING', `Multiple ${type} mappings`);
  }

  const mapping = matches[0]!;
  const prefix = `urn:ngsi-ld:${type}:${options.organizationId}:`;

  if (
    typeof mapping.brokerUrn !== 'string' ||
    !mapping.brokerUrn.startsWith(prefix)
  ) {
    fail('INVALID_URN', `${type} URN must match entity type and organization`);
  }

  const businessId = mapping.brokerUrn.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(businessId)) {
    fail('INVALID_URN', `${type} URN has an invalid integration ID`);
  }

  return { mapping, businessId };
}

/**
 * Pure projection only: performs no database or broker writes.
 * The caller must authenticate the event source and supply trusted options.
 */
export function mapHandoverToAsset(
  event: WorkflowEvent,
  options: MappingOptions,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.organizationId)) {
    fail('INVALID_TENANT', 'Invalid configured organization');
  }
  requiredText(options.sourceSystem, 'sourceSystem');

  if (event.organizationId !== options.organizationId) {
    fail('TENANT_MISMATCH', 'Event organization differs from configured organization');
  }
  if (
    event.eventType !== 'asset.handed_over' ||
    event.definitionId !== 'procurement'
  ) {
    fail('UNSUPPORTED_EVENT', 'Expected a procurement handover event');
  }

  const eventId = requiredText(event.eventId, 'eventId');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) {
    fail('INVALID_EVENT_ID', 'Invalid event ID');
  }

  requiredText(event.runId, 'runId');
  requiredText(event.recordId, 'recordId');

  if (!Number.isSafeInteger(event.version) || event.version < 1) {
    fail('INVALID_VERSION', 'Positive safe integer version required');
  }

  const observedAt = validateTime(event.occurredAt);

  if (
    !event.data ||
    typeof event.data !== 'object' ||
    Array.isArray(event.data) ||
    Object.values(event.data).some((value) => typeof value !== 'string')
  ) {
    fail('INVALID_DATA', 'Event data must contain string values');
  }

  const assetId = requiredText(event.data.assetId, 'data.assetId');
  const departmentId = requiredText(event.data.departmentId, 'data.departmentId');
  const locationId = requiredText(event.data.locationId, 'data.locationId');

  requiredText(event.data.recipientId, 'data.recipientId');
  requiredText(event.data.attachmentId, 'data.attachmentId');

  const asset = resolve(options, 'Asset', assetId);
  const department = resolve(options, 'Department', departmentId);
  const location = resolve(options, 'Location', locationId);

  const name = requiredText(asset.mapping.name, 'Asset mapping name');

  const attributes = {
    // Local integration policy: completed handover means assigned for use.
    status: {
      type: 'Property' as const,
      value: 'in_use',
      observedAt,
    },
    belongsToDepartment: {
      type: 'Relationship' as const,
      object: department.mapping.brokerUrn,
      observedAt,
    },
    locatedAt: {
      type: 'Relationship' as const,
      object: location.mapping.brokerUrn,
      observedAt,
    },
    sourceEventId: {
      type: 'Property' as const,
      value: eventId,
    },
  };

  return {
    entity: {
      id: asset.mapping.brokerUrn,
      type: 'Asset' as const,
      businessId: {
        type: 'Property' as const,
        value: asset.businessId,
      },
      organizationId: {
        type: 'Property' as const,
        value: options.organizationId,
      },
      name: { type: 'Property' as const, value: name },
      ...attributes,
    },
    // Updating a handover does not rename an existing Asset.
    attributes,
  };
}