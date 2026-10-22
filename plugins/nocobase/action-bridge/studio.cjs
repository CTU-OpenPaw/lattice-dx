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
        !["operation", "id", "version", "body", "key", "query"].includes(k),
    )
  )
    bad();
  const operations = {
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
      "draft",
      "module",
      "audit",
      "enable",
      "draftDefinition",
      "publish",
      "app",
    ].includes(operation) ||
    (operation === "save" && id !== undefined);
  if (needsId) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) bad();
    path += "/" + id;
  } else if (id !== undefined) bad();
  if (["module", "audit", "enable", "app"].includes(operation)) {
    if (
      typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    )
      bad();
    path += "/versions/" + version;
  } else if (version !== undefined) bad();
  if (operation === "save" && id !== undefined) method = "PUT";
  if (operation === "audit") path += "/audit";
  if (operation === "enable") path += "/enabled";
  if (operation === "publish") path += "/publish";
  if (
    input.query !== undefined &&
    !["drafts", "apps", "audit"].includes(operation)
  )
    bad();
  const query = validatedQuery(input.query, ["limit", "offset", "q"]);
  if (query) path += "?" + query;
  const write = method !== "GET";
  if (write) {
    if (
      !input.body ||
      typeof input.body !== "object" ||
      Array.isArray(input.body) ||
      typeof input.key !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)
    )
      bad();
    if (Buffer.byteLength(JSON.stringify(input.body)) > 128 * 1024)
      throw new BridgeError(413, "Studio command too large.");
  } else if (input.body !== undefined || input.key !== undefined) bad();
  return {
    method,
    path,
    ...(write ? { body: JSON.stringify(input.body), key: input.key } : {}),
  };
}
module.exports = { studioRequest };
