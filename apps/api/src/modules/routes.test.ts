import { it, expect, vi } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createApi } from "../app.js";
import type { ModuleRepository } from "./types.js";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const key = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "modules", alg: "RS256" }],
});
async function auth(roles = ["workflow:design", "data:design"], org = "org-a") {
  return {
    authorization:
      "Bearer " +
      (await new SignJWT({ organization_id: org, realm_access: { roles } })
        .setProtectedHeader({ alg: "RS256", kid: "modules" })
        .setSubject("alice")
        .setIssuer("https://identity.test")
        .setAudience("dx-api")
        .setExpirationTime("5m")
        .sign(privateKey)),
  };
}
it("module routes enforce current roles, strict envelopes, required keys and JWT tenant", async () => {
  const preview = vi.fn(async () => ({ hash: "h" })),
    install = vi.fn(async () => ({ id: "sample" })),
    start = vi.fn(async () => ({ id: "run" }));
  const app = createApi({
    workerUrl: "http://localhost:1",
    identity: { issuer: "https://identity.test", audience: "dx-api", key },
    modules: { preview, install, start } as unknown as ModuleRepository,
  });
  try {
    const request = {
      method: "POST" as const,
      url: "/v1/enterprise-modules/preview",
      payload: { manifest: {} },
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          ...request,
          headers: await auth(["workflow:design"]),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ ...request, headers: await auth() })).statusCode,
    ).toBe(200);
    expect(preview.mock.calls[0]).toEqual([
      {},
      {
        subject: "alice",
        organizationId: "org-a",
        roles: ["workflow:design", "data:design"],
      },
    ]);
    expect(install).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          ...request,
          headers: await auth(),
          payload: { manifest: {}, actor: "installer" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          ...request,
          url: "/v1/enterprise-modules/install",
          headers: await auth(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          ...request,
          url: "/v1/enterprise-modules/install",
          headers: { ...(await auth()), "idempotency-key": "install" },
        })
      ).statusCode,
    ).toBe(201);
    for (const input of [null, [], { x: 3 }])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/enterprise-modules/sample/versions/1.0.0/start",
            headers: {
              ...(await auth(["workflow:start"])),
              "idempotency-key": "start",
            },
            payload: { definitionId: "flow", title: "T", input },
          })
        ).statusCode,
      ).toBe(400);
    expect(start).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
