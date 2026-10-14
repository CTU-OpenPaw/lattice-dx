import { it, expect, vi } from "vitest";
import { modulesDatabase, assertModuleStartEligible } from "./database.js";
import { manifestHash } from "./policy.js";
import type { Pool, PoolClient } from "pg";
const actor = {
  subject: "admin",
  organizationId: "org",
  roles: ["workflow:design", "data:design"],
};
const manifest = {
  format: "latticedx.enterprise-module",
  formatVersion: 1,
  id: "sample",
  version: "1.0.0",
  title: "Sample",
  schemas: [{ id: "sample-schema", title: "S", fields: {} }],
  bundle: {
    format: "latticedx.workflow-bundle",
    formatVersion: 1,
    definitions: [
      {
        id: "sample-flow",
        title: "Request",
        startRole: "employee",
        initialState: "draft",
        startFields: { request: "text" },
        readerRoles: ["manager"],
        transitions: [
          {
            id: "submit",
            from: "draft",
            to: "done",
            role: "employee",
            fields: {},
          },
        ],
      },
    ],
  },
  blocks: [],
  dependencies: [],
};
function fixture(failReceipt = false) {
  const sql: string[] = [];
  const query = vi.fn(async (text: string, _values?: unknown[]) => {
    sql.push(text);
    if (
      failReceipt &&
      text.startsWith("INSERT INTO enterprise_module_commands")
    )
      throw Error("receipt failed");
    return {
      rows: text.startsWith("INSERT INTO workflow_definition_drafts")
        ? [{ id: "sample-flow", createdAt: new Date(), updatedAt: new Date() }]
        : [],
      rowCount: 1,
    };
  });
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) };
  return {
    sql,
    pool: pool as unknown as Pool,
    client: client as unknown as PoolClient,
  };
}
it("preview checks resources without mutations or acquiring a pool connection", async () => {
  const f = fixture();
  const repo = await modulesDatabase(f.pool, {} as never);
  f.sql.length = 0;
  const result = await repo.preview(manifest, actor);
  expect(result.resources.schemas).toEqual(["sample-schema"]);
  expect(result.hash).toBe(manifestHash(manifest));
  expect(f.sql.every((s) => s.startsWith("SELECT"))).toBe(true);
  expect(f.pool.connect).not.toHaveBeenCalled();
});
it("inserts schemas and workflows in canonical ID order for concurrent imports", async () => {
  const f = fixture();
  const repo = await modulesDatabase(f.pool, {} as never);
  const reversed = {
    ...manifest,
    schemas: ["schema-b", "schema-a"].map(id => ({id,title:id,fields:{}})),
    bundle: {...manifest.bundle, definitions: ["flow-b", "flow-a"].map(id => ({...manifest.bundle.definitions[0],id}))},
  };
  const result = await repo.install(reversed, actor, "ordered");
  const calls = (f.client.query as ReturnType<typeof vi.fn>).mock.calls;
  const insertedIds = (prefix:string) => calls.filter(([sql]) => sql.startsWith(prefix)).map(([,values]) => values[1]);
  expect(insertedIds("INSERT INTO enterprise_schemas")).toEqual(["schema-a", "schema-b"]);
  expect(insertedIds("INSERT INTO workflow_definition_drafts")).toEqual(["flow-a", "flow-b"]);
  expect(result.workflows.map(w => w.definitionId)).toEqual(["flow-a", "flow-b"]);
});
it("receipt failure rolls back schemas, publication, draft, provenance and ledger on one client", async () => {
  const f = fixture(true);
  const repo = await modulesDatabase(f.pool, {} as never);
  f.sql.length = 0;
  await expect(repo.install(manifest, actor, "key")).rejects.toThrow(
    "receipt failed",
  );
  expect(f.pool.connect).toHaveBeenCalledTimes(1);
  expect(f.sql).toContain("ROLLBACK");
  expect(
    f.sql.some((s) => s.startsWith("INSERT INTO enterprise_schema_versions")),
  ).toBe(true);
  expect(
    f.sql.some((s) => s.startsWith("INSERT INTO workflow_definition_drafts")),
  ).toBe(true);
  expect(f.sql).not.toContain("COMMIT");
});
it("normal new starts lock module ownership and deny disabled or inactive pins", async () => {
  const query = vi.fn(async (_sql: string) => ({
    rows: [{ enabled: false, definitionVersion: 1, isOwner: true }],
    rowCount: 1,
  }));
  await expect(
    assertModuleStartEligible(
      { query } as unknown as PoolClient,
      "org",
      "sample-flow",
      1,
    ),
  ).rejects.toThrow();
  expect(query.mock.calls[0][0]).toContain("FOR SHARE");
});
