// SPDX-License-Identifier: Apache-2.0
const { createWorkflowCommands } = require("./workflow");
function exampleRecipe() {
  return {
    format: "latticedx.system-recipe",
    formatVersion: 1,
    id: "internal-ops",
    version: "1.0.0",
    title: "Điều phối nội bộ",
    pages: [
      {
        id: "requests",
        title: "Yêu cầu liên phòng ban",
        requesterRole: "employee",
        reviewerRole: "procurement:manager",
        handlerRole: "logistics:warehouse",
        fields: [
          {
            name: "description",
            label: "Nội dung yêu cầu",
            type: "text",
            required: true,
          },
        ],
      },
    ],
  };
}
// Routing is part of the immutable command body so retry cannot target a newly selected module.
function studioCommands(api, actorId) {
  const commands = createWorkflowCommands({
    actorId,
    channel: "studio",
    api: {
      studio: (_operation, { body, key }) =>
        api.studio(body.operation, { ...body.payload, key }),
    },
  });
  return {
    execute: (operation, payload) =>
      commands.execute("send", { operation, payload }),
    retry: commands.retry,
    get uncertain() {
      return commands.uncertain;
    },
  };
}
function fieldValue(type, value) {
  if (
    type === "positiveInteger" &&
    (!/^[1-9][0-9]*$/.test(value) || Number(value) > 1000000)
  )
    throw Error("Giá trị phải là số nguyên dương không quá 1000000.");
  return value;
}
function sameConfiguration(left, right) {
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
module.exports = {
  exampleRecipe,
  studioCommands,
  fieldValue,
  sameConfiguration,
};
