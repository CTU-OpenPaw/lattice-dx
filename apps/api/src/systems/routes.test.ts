/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test, vi } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createApi } from "../app.js";
import { parseRecipe } from "./policy.js";
import { pageResult } from "../pagination.js";
const recipe = parseRecipe({
  format: "latticedx.system-recipe",
  formatVersion: 1,
  id: "company-demo",
  version: "1.0.0",
  title: "Demo",
  pages: [
    {
      id: "requests",
      title: "Requests",
      requesterRole: "employee",
      reviewerRole: "procurement:manager",
      handlerRole: "logistics:warehouse",
      fields: [
        { name: "purpose", label: "Purpose", type: "text", required: true },
      ],
    },
  ],
});
const { privateKey, publicKey } = await generateKeyPair("RS256");
const identity = {
  issuer: "http://fixture",
  audience: "dx-api",
  key: createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: "sys", alg: "RS256" }],
  }),
};
const auth = async (roles: string[], org = "org-a") => ({
  authorization:
    "Bearer " +
    (await new SignJWT({ organization_id: org, realm_access: { roles } })
      .setSubject("designer")
      .setProtectedHeader({ alg: "RS256", kid: "sys" })
      .setIssuer(identity.issuer)
      .setAudience(identity.audience)
      .setExpirationTime("5m")
      .sign(privateKey)),
  "idempotency-key": "test-key",
});
test("Studio draft/compile writes require both designer roles and reject scope injection", async () => {
  const save = vi.fn(async () => ({ id: "company-demo", revision: 1, recipe })),
    systems = {
      save,
      list: vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: "" })),
      get: vi.fn(),
      runtime: vi.fn(async () =>
        pageResult([], { limit: 20, offset: 0, q: "" }),
      ),
      adminList: vi.fn(async () =>
        pageResult([], { limit: 20, offset: 0, q: "" }),
      ),
      adminGet: vi.fn(),
    };
  const app = createApi({ workerUrl: "http://worker", identity, systems });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/system-drafts",
          payload: { recipe },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/system-drafts",
          headers: await auth(["workflow:design"]),
          payload: { recipe },
        })
      ).statusCode,
    ).toBe(403);
    const headers = await auth(["workflow:design", "data:design"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/system-drafts",
          headers,
          payload: { recipe, organizationId: "org-b" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/system-drafts",
          headers,
          payload: { recipe },
        })
      ).statusCode,
    ).toBe(201);
    expect(save).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          url: "/v1/system-apps",
          headers: await auth(["employee"]),
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
