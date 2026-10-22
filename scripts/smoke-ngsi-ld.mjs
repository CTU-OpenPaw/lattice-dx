// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createAssetConnector } from "./lib/ngsi-ld-client.mjs";
import { loadBrokerContext } from "./lib/ngsi-ld-subscription.mjs";

const configDir = new URL("../infra/config/ngsi-ld/", import.meta.url);

async function readJson(name) {
  const text = await readFile(new URL(name, configDir), "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function statusOf(asset) {
  return asset.status ??
    asset["https://latticedx.example/ns/status"];
}

try {
  const context = await loadBrokerContext();
  const seed = await readJson("seed.json");
  const template = seed.find((entity) => entity.type === "Asset");

  assert.ok(template, "seed.json must contain an Asset");

  const connector = createAssetConnector({
    baseUrl: process.env.NGSI_LD_URL ?? "http://localhost:1026",
    tenant: "org-a",
    context,
  });

  // Create a separate fixture; leave laptop-001 unchanged.
  const businessId = `connector-${randomUUID()}`;
  const entity = structuredClone(template);

  entity.id = `urn:ngsi-ld:Asset:org-a:${businessId}`;
  entity.businessId.value = businessId;
  entity.status = {
    type: "Property",
    value: "ready",
    observedAt: new Date().toISOString(),
  };

  const created = await connector.createAsset(entity);
  assert.equal(created.status, 201);
  console.log("PASS createAsset: HTTP 201");

  const before = await connector.getAsset(entity.id);
  assert.equal(before.id, entity.id);
  assert.equal(statusOf(before)?.value, "ready");
  console.log("PASS getAsset: status=ready");

  const observedAt = new Date().toISOString();
  const updated = await connector.updateAsset(entity.id, {
    status: {
      type: "Property",
      value: "in_use",
      observedAt,
    },
  });

  assert.equal(updated.status, 204);
  console.log("PASS updateAsset: HTTP 204");

  const after = await connector.getAsset(entity.id);
  assert.equal(statusOf(after)?.value, "in_use");
  assert.equal(
    Date.parse(statusOf(after)?.observedAt),
    Date.parse(observedAt),
  );

  console.log("PASS read-back: status=in_use, observedAt matched");
  console.log(`Demo Asset retained: ${entity.id}`);
} catch (error) {
  console.error(error.message);

  if (error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }

  process.exitCode = 1;
}
