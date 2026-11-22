/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDataScreen } = require("../src/client/data-screen");

function relationEditor() {
  let editing = false;
  let stateIndex = 0;
  let schema = {
    id: "items",
    title: "Items",
    fields: { title: { type: "text", required: false } },
    relations: {
      manager: { targetSchemaId: "people" },
      department: { targetSchemaId: "departments" },
    },
  };
  const reports = [];
  const React = {
    useEffect() {},
    useState(initial) {
      const index = stateIndex++;
      return [
        editing ? schema : index === 2 ? schema : initial,
        (next) => {
          if (editing) schema = typeof next === "function" ? next(schema) : next;
        },
      ];
    },
  };
  const h = (type, props, ...children) => ({ type, props, children });
  const Data = createDataScreen(React, {
    h,
    box: {},
    inputStyle: {},
    button: (label, action) => ({ label, action }),
    field: (label, value, change) => ({ label, value, change }),
    json: (value) => value,
  });
  const session = {
    commands: { uncertain: false },
    capabilities: { "entities.design": { available: true } },
    busy: false,
    api: {},
    report: (message) => reports.push(message),
  };
  function nodes(node) {
    if (!node || typeof node !== "object") return [];
    return [node, ...(node.children || []).flat(Infinity).flatMap(nodes)];
  }
  const previousLocation = global.location;
  let tree;
  try {
    global.location = { search: "" };
    tree = Data({ session });
  } finally {
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
  const editor = nodes(tree).find(
    (node) => typeof node.type === "function" && node.type.name === "SchemaEditor",
  );
  editing = true;
  stateIndex = 0;
  const fields = nodes(editor.type(editor.props));
  return {
    rename(name, next) {
      fields.find((node) => node.label === "Tên quan hệ" && node.value === name).change(next);
    },
    get schema() { return schema; },
    reports,
  };
}

test("duplicate relation rename reports an error and preserves both targets", () => {
  const editor = relationEditor();
  const initial = structuredClone(editor.schema);
  editor.rename("department", "manager");
  assert.deepEqual(editor.schema, initial);
  assert.deepEqual(editor.reports, ["Tên quan hệ bị trùng."]);
});

test("valid relation rename preserves the renamed target and the other relation", () => {
  const editor = relationEditor();
  editor.rename("department", "division");
  assert.deepEqual(editor.schema.relations, {
    manager: { targetSchemaId: "people" },
    division: { targetSchemaId: "departments" },
  });
  assert.deepEqual(editor.reports, []);
});
