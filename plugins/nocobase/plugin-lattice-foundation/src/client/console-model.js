// SPDX-License-Identifier: Apache-2.0
function attributesFromForm(fields, values) {
  const attributes = {};
  for (const [name, field] of Object.entries(fields)) {
    const value = values[name];
    if (value === undefined || value === "") {
      if (field.required) throw Error("Thiếu trường bắt buộc: " + name);
      continue;
    }
    if (field.type === "integer") {
      if (
        !/^-?\d+$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value))
      )
        throw Error("Số nguyên không hợp lệ: " + name);
      attributes[name] = Number(value);
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean")
        throw Error("Giá trị đúng/sai không hợp lệ: " + name);
      attributes[name] = value;
    } else {
      if (field.type === "enum" && !field.choices.includes(value))
        throw Error("Lựa chọn không hợp lệ: " + name);
      attributes[name] = value;
    }
  }
  return attributes;
}
function workflowForPage(page) {
  return structuredClone(
    page.workflow || {
      initialState: "draft",
      assignedStates: ["approved", "completed"],
      transitions: [
        {
          id: "submit",
          from: "draft",
          to: "submitted",
          role: page.requesterRole,
          ownerOnly: true,
          fields: {},
        },
        {
          id: "approve",
          from: "submitted",
          to: "approved",
          role: page.reviewerRole,
          fields: {},
          task: "assign",
        },
        {
          id: "reject",
          from: "submitted",
          to: "rejected",
          role: page.reviewerRole,
          fields: { reason: "text" },
        },
        {
          id: "complete",
          from: "approved",
          to: "completed",
          role: page.handlerRole,
          assigneeField: "handlerId",
          fields: { receiptNote: "text" },
          task: "complete",
        },
      ],
    },
  );
}
function moveItem(items, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
function enabledSections(capabilities) {
  const result = ["home", "work"];
  const has = (key) => capabilities[key]?.available;
  if (has("modules.preflight")) result.push("systems");
  if (has("entities.design") || has("entities.read")) result.push("data");
  if (has("organization.read")) result.push("organization");
  if (has("workflow.design") || has("entities.design")) result.push("catalog");
  if (has("operations.read")) result.push("operations");
  return result;
}
function consoleTransport(api) {
  const uncertainSchemas = new Set();
  return async (operation, payload = {}) => {
    const entityOperations = { entityCreate: "create", entityUpdate: "update", entityArchive: "archive", entityLink: "link", entityUnlink: "unlink" };
    if (Object.hasOwn(entityOperations, operation))
      return api.entity(entityOperations[operation], payload);
    if (operation === "createSchema" && uncertainSchemas.has(payload.key)) {
      let existing;
      try {
        existing = await api.studio("schema", { id: payload.body.id });
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (existing) {
        const { sameConfiguration } = require("./system-model");
        const definition = {
          id: existing.id,
          title: existing.title,
          fields: existing.fields,
          relations: existing.relations,
        };
        if (!sameConfiguration(definition, payload.body)) {
          const error = Error(
            "Cấu trúc cùng mã đã tồn tại với nội dung khác. Tải lại để kiểm tra.",
          );
          error.status = 409;
          throw error;
        }
        uncertainSchemas.delete(payload.key);
        return existing;
      }
    }
    try {
      const result = await api.studio(operation, payload);
      uncertainSchemas.delete(payload.key);
      return result;
    } catch (error) {
      if (
        operation === "createSchema" &&
        (!error.status || error.status >= 500 || error.status === 429)
      )
        uncertainSchemas.add(payload.key);
      throw error;
    }
  };
}
function safeReturnTo(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/lattice") ||
    value.length > 512
  )
    return null;
  let url;
  try {
    url = new URL(value, "http://localhost:13000");
  } catch {
    return null;
  }
  if (url.origin !== "http://localhost:13000" || url.hash) return null;
  if (url.pathname === "/lattice/console") {
    if (
      [...url.searchParams.keys()].some(
        (key) =>
          !["section", "schema", "version"].includes(key) ||
          url.searchParams.getAll(key).length !== 1,
      )
    )
      return null;
    const section = url.searchParams.get("section"),
      schema = url.searchParams.get("schema"),
      version = url.searchParams.get("version");
    if (
      (section &&
        ![
          "home",
          "work",
          "data",
          "organization",
          "catalog",
          "operations",
        ].includes(section)) ||
      (schema && !/^[a-z][a-z0-9-]{0,63}$/.test(schema)) ||
      (version && !/^[1-9]\d{0,9}$/.test(version))
    )
      return null;
    return url.pathname + url.search;
  }
  if (url.search) return null;
  if (
    url.pathname === "/lattice" ||
    url.pathname === "/lattice/studio" ||
    url.pathname === "/lattice/systems" ||
    /^\/lattice\/apps\/[a-z][a-z0-9-]{0,63}$/.test(url.pathname) ||
    /^\/lattice\/systems\/[a-z][a-z0-9-]{0,63}\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
      url.pathname,
    )
  )
    return url.pathname;
  return null;
}
module.exports = {
  attributesFromForm,
  workflowForPage,
  moveItem,
  enabledSections,
  consoleTransport,
  safeReturnTo,
};
