/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from "vitest";
import {
  parseManifest,
  manifestHash,
  requireModuleAdmin,
  semver,
} from "./policy.js";
import { workflowDefinitions } from "../../../../solutions/workflows/definitions.js";
const definition = {
  id: "sample-flow",
  title: "Request",
  startRole: "employee",
  initialState: "draft",
  startFields: { request: "text" },
  readerRoles: ["manager"],
  transitions: [
    { id: "submit", from: "draft", to: "done", role: "employee", fields: {} },
  ],
};
const manifest = {
  format: "latticedx.enterprise-module",
  formatVersion: 1,
  id: "sample",
  version: "1.0.0",
  title: "Sample",
  schemas: [],
  bundle: {
    format: "latticedx.workflow-bundle",
    formatVersion: 1,
    definitions: [{ ...definition, id: "sample-flow" }],
  },
  blocks: [],
  dependencies: [],
};
describe("enterprise module policy", () => {
  it("accepts a declarative manifest and hashes canonical content", () => {
    expect(parseManifest(manifest).id).toBe("sample");
    expect(manifestHash(manifest)).toBe(
      manifestHash(Object.fromEntries(Object.entries(manifest).reverse())),
    );
  });
  it.each(["01.0.0", "1.0", "1.0.0-beta", "2147483648.0.0", "^1.0.0"])(
    "rejects nonexact or unbounded version %s",
    (value) => expect(() => semver(value)).toThrow(),
  );
  it("rejects executable extra fields, self dependencies, unknown blocks and duplicate schemas", () => {
    for (const value of [
      { ...manifest, url: "https://example.com" },
      { ...manifest, dependencies: [{ id: "sample", version: "1.0.0" }] },
      { ...manifest, blocks: [{ id: "unknown", version: 1 }] },
      {
        ...manifest,
        schemas: [
          { id: "s", title: "S", fields: {} },
          { id: "s", title: "S", fields: {} },
        ],
      },
    ])
      expect(() => parseManifest(value)).toThrow();
  });
  it("requires both current design roles without granting them", () => {
    expect(() =>
      requireModuleAdmin({
        subject: "a",
        organizationId: "o",
        roles: ["workflow:design"],
      }),
    ).toThrow();
    expect(() =>
      requireModuleAdmin({
        subject: "a",
        organizationId: "o",
        roles: ["workflow:design", "data:design"],
      }),
    ).not.toThrow();
  });
});
