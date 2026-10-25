// SPDX-License-Identifier: Apache-2.0
"use strict";
function studioRequest(input, BridgeError, validatedQuery) {
  const bad = () => {
    throw new BridgeError(400, "Invalid Studio operation or payload.");
  };
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "operation",
          "id",
          "version",
          "principalType",
          "principalId",
          "body",
          "key",
          "query",
        ].includes(k),
    )
  )
    bad();
  const operations = {
    catalog: ["GET", "studio/catalog"],
    schemas: ["GET", "entity-schemas"],
    schema: ["GET", "entity-schemas"],
    createSchema: ["POST", "entity-schemas"],
    saveSchema: ["PUT", "entity-schemas"],
    publishSchema: ["POST", "entity-schemas"],
    publishedSchema: ["GET", "entity-schemas"],
    departments: ["GET", "organization/departments"],
    createDepartment: ["POST", "organization/departments"],
    updateDepartment: ["PATCH", "organization/departments"],
    departmentHistory: ["GET", "organization/departments"],
    diagnostics: ["GET", "operations/diagnostics"],
    queues: ["GET", "operations/queues"],
    entityHistory: ["GET", "entities"],
    queryEntities: ["POST", "entities/query"],
    shares: ["GET", "entities"],
    share: ["POST", "entities"],
    drafts: ["GET", "system-drafts"],
    draft: ["GET", "system-drafts"],
    save: ["POST", "system-drafts"],
    plan: ["POST", "studio/system-plan"],
    install: ["POST", "enterprise-modules/install"],
    module: ["GET", "enterprise-modules"],
    audit: ["GET", "enterprise-modules"],
    enable: ["POST", "enterprise-modules"],
    draftDefinition: ["GET", "workflow-drafts"],
    publish: ["POST", "workflow-drafts"],
    apps: ["GET", "system-apps"],
    app: ["GET", "system-apps"],
    adminSystems: ["GET", "systems"],
    adminSystem: ["GET", "systems"],
    policy: ["GET", "systems"],
    activatePolicy: ["POST", "systems"],
    members: ["GET", "systems"],
    grantMember: ["POST", "systems"],
    updateMember: ["PUT", "systems"],
    revokeMember: ["DELETE", "systems"],
    memberHistory: ["GET", "systems"],
    myAccess: ["GET", "system-apps"],
  };
  if (
    typeof input.operation !== "string" ||
    !Object.hasOwn(operations, input.operation)
  )
    bad();
  let [method, path] = operations[input.operation];
  const { operation, id, version } = input;
  const needsId =
    [
      "schema",
      "saveSchema",
      "publishSchema",
      "publishedSchema",
      "updateDepartment",
      "departmentHistory",
      "entityHistory",
      "shares",
      "share",
      "draft",
      "module",
      "audit",
      "enable",
      "draftDefinition",
      "publish",
      "app",
      "adminSystem",
      "policy",
      "activatePolicy",
      "members",
      "grantMember",
      "updateMember",
      "revokeMember",
      "memberHistory",
      "myAccess",
    ].includes(operation) ||
    (operation === "save" && id !== undefined);
  if (needsId) {
    const idPattern = ["entityHistory", "shares", "share"].includes(operation)
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      : /^[a-z][a-z0-9-]{0,63}$/;
    if (typeof id !== "string" || !idPattern.test(id)) bad();
    path += "/" + id;
  } else if (id !== undefined) bad();
  const systemVersionOps = [
    "module",
    "audit",
    "enable",
    "app",
    "adminSystem",
    "policy",
    "activatePolicy",
    "members",
    "grantMember",
    "updateMember",
    "revokeMember",
    "memberHistory",
    "myAccess",
  ];
  if (systemVersionOps.includes(operation)) {
    if (
      typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    )
      bad();
    path += "/versions/" + version;
  } else if (operation === "publishedSchema") {
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 2147483647
    )
      bad();
    path += "/versions/" + version;
  } else if (version !== undefined) bad();
  if (operation === "save" && id !== undefined) method = "PUT";
  if (operation === "audit") path += "/audit";
  if (operation === "enable") path += "/enabled";
  if (["publish", "publishSchema"].includes(operation)) path += "/publish";
  if (["departmentHistory", "entityHistory"].includes(operation))
    path += "/history";
  if (["shares", "share"].includes(operation)) path += "/shares";
  if (operation === "policy") path += "/policy";
  if (operation === "activatePolicy") path += "/policy/activate";
  if (operation === "members" || operation === "grantMember") path += "/members";
  if (operation === "memberHistory") path += "/members/history";
  if (operation === "myAccess") path += "/access/me";
  if (["updateMember", "revokeMember"].includes(operation)) {
    const { principalType, principalId } = input;
    if (
      typeof principalType !== "string" ||
      !["person", "department"].includes(principalType) ||
      typeof principalId !== "string" ||
      (principalType === "department" && !/^[a-z][a-z0-9-]{0,63}$/.test(principalId)) ||
      (principalType === "person" && !/^[a-z0-9._:-]{1,128}$/i.test(principalId))
    )
      bad();
    path += "/members/" + principalType + "/" + encodeURIComponent(principalId);
  } else if (input.principalType !== undefined || input.principalId !== undefined) {
    bad();
  }
  if (
    input.query !== undefined &&
    ![
      "drafts",
      "apps",
      "adminSystems",
      "audit",
      "schemas",
      "departments",
      "departmentHistory",
      "entityHistory",
      "shares",
      "members",
      "memberHistory",
    ].includes(operation)
  )
    bad();
  const query = validatedQuery(
    input.query,
    operation === "memberHistory" ? ["limit", "offset"] : ["limit", "offset", "q"],
  );
  if (query) path += "?" + query;
  const write = method !== "GET";
  if (write) {
    if (
      typeof input.key !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)
    )
      bad();
    if (["activatePolicy", "revokeMember"].includes(operation)) {
      if (
        input.body !== undefined &&
        (typeof input.body !== "object" || Array.isArray(input.body))
      )
        bad();
    } else {
      if (
        !input.body ||
        typeof input.body !== "object" ||
        Array.isArray(input.body)
      )
        bad();
      if (Buffer.byteLength(JSON.stringify(input.body)) > 128 * 1024)
        throw new BridgeError(413, "Studio command too large.");
      if (operation === "queryEntities") {
        const body = input.body;
        if (
          Object.keys(body).some(
            (k) =>
              ![
                "schemaId",
                "schemaVersion",
                "filters",
                "sort",
                "limit",
                "offset",
              ].includes(k),
          ) ||
          typeof body.schemaId !== "string" ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(body.schemaId) ||
          !Number.isInteger(body.schemaVersion) ||
          body.schemaVersion < 1 ||
          body.schemaVersion > 2147483647 ||
          (body.limit !== undefined &&
            (!Number.isInteger(body.limit) ||
              body.limit < 1 ||
              body.limit > 100)) ||
          (body.offset !== undefined &&
            (!Number.isSafeInteger(body.offset) ||
              body.offset < 0 ||
              body.offset > Number.MAX_SAFE_INTEGER - 101)) ||
          Buffer.byteLength(JSON.stringify(body)) > 16384
        )
          bad();
      }
    }
  } else if (input.body !== undefined || input.key !== undefined) bad();
  return {
    method,
    path,
    ...(write
      ? {
          ...(input.body ? { body: JSON.stringify(input.body) } : {}),
          key: input.key,
        }
      : {}),
  };
}
module.exports = { studioRequest };
