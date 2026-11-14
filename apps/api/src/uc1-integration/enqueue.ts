/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import type { WorkflowEvent } from '@dx/contracts';
import {
  mapHandoverToAsset,
  type MappingOptions,
} from './asset-mapping.js';

export type BrokerMappingConfig = MappingOptions & {
  mappingVersion: string;
};

export function loadBrokerMapping(path: string): BrokerMappingConfig {
  const config = JSON.parse(
    readFileSync(path, 'utf8').replace(/^\uFEFF/, ''),
  ) as BrokerMappingConfig;

  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.organizationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.organizationId) ||
    typeof config.sourceSystem !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(config.sourceSystem) ||
    typeof config.mappingVersion !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(config.mappingVersion) ||
    !Array.isArray(config.mappings) ||
    config.mappings.some(
      (entry) => !entry || typeof entry !== 'object' || Array.isArray(entry),
    )
  ) {
    throw new Error('Invalid broker mapping configuration');
  }

  return config;
}

/**
 * Must run inside the transaction that accepts the handover.
 * Lock ordering: handover first, then its broker job.
 */
export async function enqueueAssetJob(
  client: PoolClient,
  event: WorkflowEvent,
  config: BrokerMappingConfig,
): Promise<void> {
  const source = await client.query<{ same: boolean }>(
    `SELECT payload = $3::jsonb AS same
     FROM uc1_sample.handovers
     WHERE organization_id = $1 AND event_id = $2
     FOR UPDATE`,
    [event.organizationId, event.eventId, JSON.stringify(event)],
  );

  if (source.rows[0]?.same !== true) {
    throw new Error('Broker job requires the matching accepted handover');
  }

  const existing = await client.query(
    `SELECT event_id
     FROM uc1_integration.asset_jobs
     WHERE organization_id = $1 AND event_id = $2`,
    [event.organizationId, event.eventId],
  );

  // Replay retains the original projection, mapping version and job status.
  // It does not re-enqueue completed jobs or apply changed configuration.
  if (existing.rowCount) return;

  const projection = mapHandoverToAsset(event, config);

  await client.query(
    `INSERT INTO uc1_integration.asset_jobs (
       organization_id, event_id, source_system, mapping_version,
       asset_urn, source_observed_at, projection
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      event.organizationId,
      event.eventId,
      config.sourceSystem,
      config.mappingVersion,
      projection.entity.id,
      event.occurredAt,
      JSON.stringify(projection),
    ],
  );
}