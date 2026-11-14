/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Real PostgreSQL and signed HTTP; no worker, broker or model calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { generateKeyPair, SignJWT } from "jose";
import { createApi } from "../apps/api/src/app.js";
import { connectRecords } from "../apps/api/src/database.js";
import { verifyGeneralBlocks } from "./general-blocks-acceptance.js";
const control = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
control.on("error", () => {});
const databaseName = "studio_accept_" + randomUUID().replaceAll("-", "");
let database: Awaited<ReturnType<typeof connectRecords>> | undefined,
  pool: Pool | undefined,
  app: ReturnType<typeof createApi> | undefined;
async function main() {
  assert.match(databaseName, /^studio_accept_[a-f0-9]{32}$/);
  await control.query("CREATE DATABASE " + databaseName);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = "/" + databaseName;
  database = await connectRecords(url.href);
  pool = new Pool({ connectionString: url.href });
  pool.on("error", () => {});
  const roles = {
    designer: [
      "workflow:design",
      "data:design",
      "data:read",
      "data:write",
      "data:share",
      "directory:read",
      "directory:manage",
    ],
    employee: ["workflow:start", "employee", "directory:read"],
    manager: ["procurement:manager"],
    handler: ["logistics:warehouse", "data:read"],
    finance: ["finance:manager"],
    wrong: ["logistics:warehouse"],
    irrelevant: ["unrelated"],
  };
  const keys = await generateKeyPair("RS256"),
    tokens: Record<string, string> = {};
  for (const [subject, list] of Object.entries(roles)) {
    await pool.query(
      "INSERT INTO directory_people(subject,organization_id,display_name,roles,enabled) VALUES($1,$2,$1,$3,true)",
      [subject, "fixture", JSON.stringify(list)],
    );
    tokens[subject] = await new SignJWT({
      organization_id: "fixture",
      realm_access: { roles: list },
    })
      .setSubject(subject)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("studio-fixture")
      .setAudience("api")
      .setExpirationTime("1h")
      .sign(keys.privateKey);
  }
  tokens.foreign = await new SignJWT({
    organization_id: "foreign",
    realm_access: { roles: roles.designer },
  })
    .setSubject("designer")
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("studio-fixture")
    .setAudience("api")
    .setExpirationTime("1h")
    .sign(keys.privateKey);
  const identity = {
    issuer: "studio-fixture",
    audience: "api",
    key: async () => keys.publicKey,
  };
  function open() {
    const {
      repository,
      systems,
      modules,
      workflows,
      definitionRegistry,
      foundation,
      directory,
      organization,
      entities,
    } = database!;
    app = createApi({
      workerUrl: "http://unused.invalid",
      identity,
      records: repository,
      systems,
      modules,
      workflows,
      definitionRegistry,
      foundation,
      directory,
      organization,
      entities,
    });
  }
  open();
  async function call(
    path: string,
    method = "GET",
    payload?: unknown,
    who = "designer",
    expected = 200,
    key = randomUUID(),
  ) {
    const response = await app!.inject({
      url: path,
      method: method as any,
      headers: {
        authorization: "Bearer " + tokens[who],
        "idempotency-key": key,
      },
      ...(payload === undefined ? {} : { payload }),
    });
    const body = response.json();
    assert.equal(
      response.statusCode,
      expected,
      `${who} ${method} ${path}: ${JSON.stringify(body)}`,
    );
    return body;
  }
  const recipe = {
    format: "latticedx.system-recipe",
    formatVersion: 1,
    id: "company-ops",
    version: "1.0.0",
    title: "Company operations",
    pages: [
      {
        id: "requests",
        title: "Department requests",
        requesterRole: "employee",
        reviewerRole: "procurement:manager",
        handlerRole: "logistics:warehouse",
        fields: [
          { name: "purpose", label: "Purpose", type: "text", required: true },
          {
            name: "quantity",
            label: "Quantity",
            type: "positiveInteger",
            required: false,
          },
        ],
      },
    ],
  };
  recipe.pages.push({
    ...recipe.pages[0]!,
    id: "facilities",
    title: "Facilities requests",
  });
  const saveKey = randomUUID(),
    saved = await call(
      "/v1/system-drafts",
      "POST",
      { recipe },
      "designer",
      201,
      saveKey,
    );
  assert.deepEqual(
    await call(
      "/v1/system-drafts",
      "POST",
      { recipe },
      "designer",
      201,
      saveKey,
    ),
    saved,
  );
  await call("/v1/system-drafts", "POST", { recipe }, "designer", 409);
  await call("/v1/system-drafts", "POST", { recipe }, "employee", 403);
  await call(
    "/v1/system-drafts/" + recipe.id,
    "GET",
    undefined,
    "foreign",
    404,
  );
  const updated = await call("/v1/system-drafts/" + recipe.id, "PUT", {
    recipe,
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 2);
  await call(
    "/v1/system-drafts/" + recipe.id,
    "PUT",
    { recipe, expectedRevision: 1 },
    "designer",
    409,
  );
  const parallelRecipe = { ...recipe, id: "parallel-ops" },
    parallelKey = randomUUID();
  const snapshots = await Promise.all(
    Array.from({ length: 3 }, () =>
      call(
        "/v1/system-drafts",
        "POST",
        { recipe: parallelRecipe },
        "designer",
        201,
        parallelKey,
      ),
    ),
  );
  assert.ok(snapshots.every((snapshot) => snapshot.revision === 1));
  const competing = await Promise.all(
    [0, 1].map((index) =>
      app!.inject({
        method: "PUT",
        url: "/v1/system-drafts/parallel-ops",
        headers: {
          authorization: "Bearer " + tokens.designer,
          "idempotency-key": randomUUID(),
        },
        payload: {
          recipe: { ...parallelRecipe, title: "Concurrent " + index },
          expectedRevision: 1,
        },
      }),
    ),
  );
  assert.deepEqual(
    competing.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  const draftPage = await call("/v1/system-drafts?limit=1&offset=0");
  assert.equal(draftPage.items.length, 1);
  assert.equal(draftPage.page.hasMore, true);
  const plan = await call("/v1/studio/system-plan", "POST", { recipe });
  assert.deepEqual(plan.preview.conflicts, []);
  const modulePath =
    "/v1/enterprise-modules/" + recipe.id + "/versions/" + recipe.version;
  let module = await call(
    "/v1/enterprise-modules/install",
    "POST",
    { manifest: plan.manifest },
    "designer",
    201,
  );
  await call(
    modulePath + "/enabled",
    "POST",
    { expectedRevision: module.revision, enabled: true },
    "designer",
    409,
  );
  const definitionId = plan.manifest.bundle.definitions[0].id;
  for (const definition of plan.manifest.bundle.definitions)
    await call("/v1/workflow-drafts/" + definition.id + "/publish", "POST", {
      expectedRevision: 1,
    });
  module = await call(modulePath + "/enabled", "POST", {
    expectedRevision: module.revision,
    enabled: true,
  });
  const runtime = await call(
    "/v1/system-apps/" + recipe.id + "/versions/" + recipe.version,
    "GET",
    undefined,
    "employee",
  );
  assert.equal(runtime.definitions.length, 2);
  assert.ok(
    runtime.definitions.every(
      (definition: { canStart: boolean }) => definition.canStart,
    ),
  );
  assert.equal(runtime.presentation.pages[0].fieldLabels.purpose, "Purpose");
  assert.equal(
    (await call("/v1/system-apps", "GET", undefined, "irrelevant")).items
      .length,
    0,
  );
  assert.equal(
    (await call("/v1/system-apps", "GET", undefined, "foreign")).items.length,
    0,
  );
  const creation = {
    definitionId,
    title: "Cross-department request",
    input: {
      purpose: "New office equipment",
      quantity: "2",
      handlerId: "handler",
    },
  };
  let run = await call("/v1/workflows", "POST", creation, "employee", 201);
  const runPath = "/v1/workflows/" + run.id;
  await call(runPath, "GET", undefined, "handler", 404);
  run = await call(
    runPath + "/transitions",
    "POST",
    { action: "submit", expectedVersion: run.version, input: {} },
    "employee",
  );
  assert.equal(
    (
      await call(
        "/v1/workflows?inbox=true&definitionId=" + definitionId,
        "GET",
        undefined,
        "manager",
      )
    ).items.length,
    1,
  );
  await call(
    runPath + "/transitions",
    "POST",
    { action: "approve", expectedVersion: run.version, input: {} },
    "employee",
    403,
  );
  run = await call(
    runPath + "/transitions",
    "POST",
    { action: "approve", expectedVersion: run.version, input: {} },
    "manager",
  );
  const task = (
    await pool.query("SELECT * FROM foundation_tasks WHERE record_id=$1", [
      run.id,
    ])
  ).rows[0];
  assert.equal(task.assignee_id, "handler");
  await call(runPath, "GET", undefined, "wrong", 404);
  assert.equal(
    (
      await call(
        "/v1/workflows?inbox=true&definitionId=" + definitionId,
        "GET",
        undefined,
        "handler",
      )
    ).items.length,
    1,
  );
  module = await call(modulePath + "/enabled", "POST", {
    expectedRevision: module.revision,
    enabled: false,
  });
  await call("/v1/workflows", "POST", creation, "employee", 409);
  assert.equal(
    (await call("/v1/system-apps", "GET", undefined, "employee")).items.length,
    1,
  );
  assert.equal(
    (
      await call(
        "/v1/system-apps/" + recipe.id + "/versions/" + recipe.version,
        "GET",
        undefined,
        "handler",
      )
    ).enabled,
    false,
  );
  run = await call(
    runPath + "/transitions",
    "POST",
    {
      action: "complete",
      expectedVersion: run.version,
      input: { receiptNote: "Equipment delivered" },
    },
    "handler",
  );
  assert.equal(run.state, "completed");
  assert.equal(
    (
      await pool.query("SELECT status FROM foundation_tasks WHERE id=$1", [
        task.id,
      ])
    ).rows[0].status,
    "completed",
  );
  assert.equal(
    (await call(runPath + "/history", "GET", undefined, "employee")).items
      .length,
    4,
  );
  const imported = {
    ...JSON.parse(JSON.stringify(recipe)),
    id: "second-company",
  };
  const second = await call("/v1/studio/system-plan", "POST", {
    recipe: imported,
  });
  assert.notEqual(second.manifest.bundle.definitions[0].id, definitionId);
  await call(
    "/v1/enterprise-modules/install",
    "POST",
    { manifest: second.manifest },
    "designer",
    201,
  );
  const department = await call(
    "/v1/organization/departments",
    "POST",
    { id: "finance", name: "Finance", parentId: null, managerId: "finance" },
    "designer",
    201,
  );
  assert.equal(department.version, 1);
  await call(
    "/v1/organization/departments",
    "POST",
    { id: "blocked", name: "Blocked", parentId: null, managerId: null },
    "employee",
    403,
  );
  const schema = {
    id: "company-assets",
    title: "Assets",
    fields: {
      serial: { type: "text", required: true },
      count: { type: "integer" },
      active: { type: "boolean" },
    },
    relations: {},
  };
  await call("/v1/entity-schemas", "POST", schema, "designer", 201);
  await call("/v1/entity-schemas/company-assets/publish", "POST", {
    expectedRevision: 1,
  });
  let asset = await call(
    "/v1/entities",
    "POST",
    {
      schemaId: schema.id,
      title: "Warehouse scanner",
      attributes: { serial: "ABC", count: 2, active: false },
    },
    "designer",
    201,
  );
  await call("/v1/entity-schemas/company-assets", "PUT", {
    expectedRevision: 1,
    title: schema.title,
    fields: { ...schema.fields, newField: { type: "text", required: true } },
    relations: {},
  });
  await call("/v1/entity-schemas/company-assets/publish", "POST", {
    expectedRevision: 2,
  });
  const pinnedAsset = await call(
    "/v1/entities",
    "POST",
    {
      schemaId: schema.id,
      schemaVersion: 1,
      title: "Version one form",
      attributes: { serial: "PINNED" },
    },
    "designer",
    201,
  );
  assert.equal(pinnedAsset.schemaVersion, 1);
  await call(
    "/v1/entities",
    "POST",
    {
      schemaId: schema.id,
      title: "Latest requires newField",
      attributes: { serial: "LATEST" },
    },
    "designer",
    400,
  );
  await call("/v1/entities/" + asset.id, "GET", undefined, "handler", 404);
  asset = await call("/v1/entities/" + asset.id + "/shares", "POST", {
    expectedVersion: asset.version,
    principal: { kind: "person", id: "handler" },
    permission: "read",
  });
  assert.equal(
    (await call("/v1/entities/" + asset.id, "GET", undefined, "handler"))
      .attributes.active,
    false,
  );
  await call("/v1/entities/" + asset.id, "GET", undefined, "foreign", 404);
  const customRecipe = {
    ...recipe,
    id: "custom-review",
    pages: [
      {
        ...recipe.pages[0],
        blocks: ["list", "create", "detail", "history"],
        workflow: {
          initialState: "draft",
          assignedStates: ["approved", "completed"],
          transitions: [
            {
              id: "submit",
              from: "draft",
              to: "submitted",
              role: "employee",
              ownerOnly: true,
              fields: {},
            },
            {
              id: "review",
              from: "submitted",
              to: "finance-pending",
              role: "procurement:manager",
              fields: {},
            },
            {
              id: "finance-approve",
              from: "finance-pending",
              to: "approved",
              role: "finance:manager",
              fields: { financeNote: "text" },
              task: "assign",
            },
            {
              id: "complete",
              from: "approved",
              to: "completed",
              role: "logistics:warehouse",
              assigneeField: "handlerId",
              fields: { receiptNote: "text" },
              task: "complete",
            },
          ],
        },
      },
    ],
  };
  const customPlan = await call("/v1/studio/system-plan", "POST", {
    recipe: customRecipe,
  });
  const customModule = await call(
      "/v1/enterprise-modules/install",
      "POST",
      { manifest: customPlan.manifest },
      "designer",
      201,
    ),
    customId = customPlan.manifest.bundle.definitions[0].id;
  await call("/v1/workflow-drafts/" + customId + "/publish", "POST", {
    expectedRevision: 1,
  });
  await call(
    "/v1/enterprise-modules/custom-review/versions/1.0.0/enabled",
    "POST",
    { expectedRevision: customModule.revision, enabled: true },
  );
  const financeApp = await call(
    "/v1/system-apps/custom-review/versions/1.0.0",
    "GET",
    undefined,
    "finance",
  );
  assert.deepEqual(financeApp.presentation.pages[0].blocks, [
    "list",
    "create",
    "detail",
    "history",
  ]);
  let customRun = await call(
      "/v1/workflows",
      "POST",
      { ...creation, definitionId: customId },
      "employee",
      201,
    ),
    customPath = "/v1/workflows/" + customRun.id;
  customRun = await call(
    customPath + "/transitions",
    "POST",
    { action: "submit", expectedVersion: customRun.version, input: {} },
    "employee",
  );
  customRun = await call(
    customPath + "/transitions",
    "POST",
    { action: "review", expectedVersion: customRun.version, input: {} },
    "manager",
  );
  await call(
    customPath + "/transitions",
    "POST",
    {
      action: "finance-approve",
      expectedVersion: customRun.version,
      input: { financeNote: "wrong actor" },
    },
    "manager",
    403,
  );
  customRun = await call(
    customPath + "/transitions",
    "POST",
    {
      action: "finance-approve",
      expectedVersion: customRun.version,
      input: { financeNote: "Budget checked" },
    },
    "finance",
  );
  customRun = await call(
    customPath + "/transitions",
    "POST",
    {
      action: "complete",
      expectedVersion: customRun.version,
      input: { receiptNote: "Delivered" },
    },
    "handler",
  );
  assert.equal(customRun.state, "completed");
  const general = await verifyGeneralBlocks(call);
  await app!.close();
  await database.close();
  database = await connectRecords(url.href);
  open();
  assert.equal((await call(general.appPath)).presentation.entityPages.length, 3);
  assert.equal((await call('/v1/entities/'+general.records[0])).attributes.count, 3);
  assert.equal((await call("/v1/system-drafts/" + recipe.id)).revision, 2);
  assert.equal(
    (await call(runPath, "GET", undefined, "handler")).state,
    "completed",
  );
  console.log(
    "System Studio acceptance passed: persistent/revisioned/idempotent drafts, signed HTTP permissions, compile/install/publish/enable, employee → manager → exact assignee, real task completion, cross-tenant isolation, disable/new-start gate, continued old runs, restart persistence and independent recipe import. Disposable database only.",
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close();
    await database?.close();
    await pool?.end();
    await control.query(
      "DROP DATABASE IF EXISTS " + databaseName + " WITH (FORCE)",
    );
    await control.end();
  });
