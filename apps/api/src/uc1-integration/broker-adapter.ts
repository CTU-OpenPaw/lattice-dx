// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import type { BrokerPort } from './broker-sync.js';

type ConnectorOptions = {
  baseUrl: string;
  tenant: string;
  context: Record<string, unknown>;
  timeoutMs: number;
};

type ConnectorModule = {
  createAssetConnector(options: ConnectorOptions): BrokerPort;
};

export async function createBrokerPort(options: {
  baseUrl: string;
  tenant: string;
}): Promise<BrokerPort> {
  const brokerUrl = new URL(options.baseUrl);

  if (
    !['http:', 'https:'].includes(brokerUrl.protocol) ||
    brokerUrl.username ||
    brokerUrl.password ||
    brokerUrl.search ||
    brokerUrl.hash
  ) {
    throw new Error('Broker URL must be a trusted HTTP(S) base URL');
  }

  const contextFile = new URL(
    '../../../../infra/config/ngsi-ld/context.jsonld',
    import.meta.url,
  );

  const configured = JSON.parse(
    (await readFile(contextFile, 'utf8')).replace(/^\uFEFF/, ''),
  )['@context'];

  if (
    !Array.isArray(configured) ||
    configured.length !== 2 ||
    configured[0] !==
      'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld' ||
    !configured[1] ||
    typeof configured[1] !== 'object' ||
    Array.isArray(configured[1])
  ) {
    throw new Error('Expected the core context and one local mapping object');
  }

  const moduleUrl = new URL(
    '../../../../scripts/lib/ngsi-ld-client.mjs',
    import.meta.url,
  );

  const connectorModule = await import(moduleUrl.href) as ConnectorModule;

  if (typeof connectorModule.createAssetConnector !== 'function') {
    throw new Error('Asset connector is unavailable');
  }

  const connector = connectorModule.createAssetConnector({
    baseUrl: options.baseUrl,
    tenant: options.tenant,
    context: configured[1],
    timeoutMs: 5000,
  });

  for (const name of ['getEntity', 'createAsset', 'updateAsset'] as const) {
    if (typeof connector[name] !== 'function') {
      throw new Error(`Asset connector is missing ${name}`);
    }
  }

  return connector;
}