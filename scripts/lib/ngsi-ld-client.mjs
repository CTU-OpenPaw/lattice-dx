// SPDX-License-Identifier: Apache-2.0

export class BrokerError extends Error {
  constructor(status, details) {
    super(`NGSI-LD request failed: HTTP ${status}`);
    this.name = "BrokerError";
    this.status = status;
    this.details = details;
  }
}

export function createAssetConnector({
  baseUrl = "http://localhost:1026",
  tenant = "org-a",
  context,
  timeoutMs = 10000,
} = {}) {
  if (!context) throw new Error("JSON-LD context is required");

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenant)) {
    throw new Error("Invalid tenant");
  }

  const base = baseUrl.replace(/\/+$/, "");
  const prefix = `urn:ngsi-ld:Asset:${tenant}:`;

  function validateId(id) {
    if (typeof id !== "string" || !id.startsWith(prefix)) {
      throw new Error(`Asset ID must start with ${prefix}`);
    }

    const businessId = id.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(businessId)) {
      throw new Error("Invalid Asset business ID");
    }
  }

  async function request(method, path, body, expectedStatus) {
    const response = await fetch(`${base}/ngsi-ld/v1${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/ld+json",
        "NGSILD-Tenant": tenant,
        ...(body ? { "Content-Type": "application/ld+json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    // A partial update (HTTP 207) must not count as full success.
    if (response.status !== expectedStatus) {
      throw new BrokerError(response.status, data);
    }

    return { status: response.status, data };
  }

  return {
    async createAsset(entity) {
      validateId(entity.id);

      if (entity.type !== "Asset") {
        throw new Error("Entity type must be Asset");
      }
      if (entity.organizationId?.value !== tenant) {
        throw new Error("organizationId must match tenant");
      }
      if (entity.id !== `${prefix}${entity.businessId?.value}`) {
        throw new Error("Asset ID must match businessId");
      }

      return request(
        "POST",
        "/entities",
        { ...entity, "@context": context },
        201,
      );
    },

    async getAsset(id) {
      validateId(id);

      const result = await request(
        "GET",
        `/entities/${encodeURIComponent(id)}`,
        undefined,
        200,
      );

      return result.data;
    },

    async updateAsset(id, attributes) {
      validateId(id);

      const allowed = new Set([
        "name",
        "status",
        "belongsToDepartment",
        "locatedAt",
        "sourceEventId",
      ]);

      const keys = Object.keys(attributes);
      if (!keys.length || keys.some((key) => !allowed.has(key))) {
        throw new Error("Empty update or unsupported attribute");
      }

      return request(
        "PATCH",
        `/entities/${encodeURIComponent(id)}/attrs`,
        { ...attributes, "@context": context },
        204,
      );
    },
  };
}