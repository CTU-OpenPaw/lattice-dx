/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */

export type SensorAssetIdentity =
  | {
      kind: 'legacy';
      organizationId: string;
      businessId: string;
      urn: string;
    }
  | {
      kind: 'native';
      organizationId: string;
      recordId: string;
      urn: string;
    };

/**
 * Checks identity structure and tenant consistency only.
 * Does not prove that the Asset exists or that the caller may access it.
 * Keep native record IDs as strings to avoid numeric precision loss.
 */
export function parseSensorAssetUrn(
  value: unknown,
  organizationId: string,
): SensorAssetIdentity {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) {
    throw new Error('Invalid configured Asset organization.');
  }

  const prefix = `urn:ngsi-ld:Asset:${organizationId}:`;

  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new Error('Asset URN must belong to the configured tenant.');
  }

  const suffix = value.slice(prefix.length);

  if (suffix.startsWith('native:')) {
    const recordId = suffix.slice('native:'.length);

    if (
      organizationId.length > 80 ||
      !/^[1-9][0-9]{0,18}$/.test(recordId) ||
      BigInt(recordId) > 9_223_372_036_854_775_807n
    ) {
      throw new Error('Invalid native Asset identity.');
    }

    return {
      kind: 'native',
      organizationId,
      recordId,
      urn: value,
    };
  }

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffix)) {
    throw new Error('Invalid legacy Asset identity.');
  }

  return {
    kind: 'legacy',
    organizationId,
    businessId: suffix,
    urn: value,
  };
}