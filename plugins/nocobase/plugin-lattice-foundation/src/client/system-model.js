/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { createWorkflowCommands } = require("./workflow");

function blankRecipe() {
  return {
    format: "latticedx.system-recipe",
    formatVersion: 1,
    id: "system-" + Math.floor(1000 + Math.random() * 9000),
    version: "1.0.0",
    title: "Hệ thống mới",
    pages: [
      {
        id: "module-1",
        title: "Module chính",
        requesterRole: "employee",
        reviewerRole: "manager",
        handlerRole: "operator",
        blocks: ["create", "list", "inbox", "detail", "history"],
        fields: [
          {
            name: "title",
            label: "Tiêu đề",
            type: "text",
            required: true,
          },
        ],
      },
    ],
    schemas: [],
    entityPages: [],
  };
}

function companyOperationsRecipe() {
  return {
    format: "latticedx.system-recipe",
    formatVersion: 1,
    id: "company-ops",
    version: "1.0.0",
    title: "Điều hành công ty",
    pages: [
      {
        id: "cross-requests",
        title: "Yêu cầu liên phòng ban",
        requesterRole: "employee",
        reviewerRole: "manager",
        handlerRole: "operator",
        blocks: ["create", "list", "inbox", "detail", "history"],
        fields: [
          {
            name: "title",
            label: "Tiêu đề công việc",
            type: "text",
            required: true,
          },
          {
            name: "department",
            label: "Phòng ban phụ trách",
            type: "text",
            required: true,
          },
          {
            name: "priority",
            label: "Mức độ ưu tiên",
            type: "text",
            required: true,
          },
          {
            name: "content",
            label: "Nội dung chi tiết",
            type: "text",
            required: false,
          },
        ],
      },
    ],
    schemas: [
      {
        id: "company-ops-1-0-0-departments",
        title: "Danh mục phòng ban",
        fields: {
          code: { type: "text", required: true },
          name: { type: "text", required: true },
          manager: { type: "text", required: false },
        },
        relations: {},
      },
      {
        id: "company-ops-1-0-0-assets",
        title: "Danh mục tài sản",
        fields: {
          code: { type: "text", required: true },
          name: { type: "text", required: true },
          category: { type: "text", required: false },
        },
        relations: {
          department: {
            targetSchemaId: "company-ops-1-0-0-departments",
          },
        },
      },
    ],
    entityPages: [
      {
        id: "departments",
        title: "Danh mục phòng ban",
        schemaId: "company-ops-1-0-0-departments",
        schemaVersion: 1,
        fields: ["code", "name", "manager"],
        blocks: ["create", "list", "detail", "history"],
        actions: ["create", "update", "archive"],
      },
      {
        id: "assets",
        title: "Danh mục tài sản",
        schemaId: "company-ops-1-0-0-assets",
        schemaVersion: 1,
        fields: ["code", "name", "category"],
        blocks: ["create", "list", "detail", "relations", "history"],
        actions: ["create", "update", "archive", "link", "unlink"],
      },
    ],
  };
}

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

function validateRecipe(recipe) {
  const issues = [];
  const warnings = [];
  if (!recipe || typeof recipe !== "object") {
    return { valid: false, issues: ["Cấu hình hệ thống không hợp lệ."], warnings };
  }
  // 1. Mã hệ thống (ID)
  if (!recipe.id || !recipe.id.trim()) {
    issues.push("Mã hệ thống không được để trống.");
  } else if (!/^[a-z][a-z0-9_-]{0,23}$/.test(recipe.id)) {
    issues.push(`Mã hệ thống "${recipe.id}" không hợp lệ. Phải bắt đầu bằng chữ thường, chỉ chứa chữ thường, số, gạch nối/dưới và tối đa 24 ký tự.`);
  }
  // 2. Tên hệ thống (Title)
  if (!recipe.title || !recipe.title.trim()) {
    issues.push("Tên hệ thống không được để trống.");
  }
  // 3. Phiên bản hệ thống (Version)
  if (!recipe.version || !/^\d+\.\d+\.\d+$/.test(recipe.version)) {
    issues.push(`Phiên bản "${recipe.version || ''}" không đúng chuẩn semver (ví dụ: 1.0.0).`);
  }
  // 4. Số lượng module và trang dữ liệu
  const pages = recipe.pages || [];
  const entityPages = recipe.entityPages || [];
  const schemas = recipe.schemas || [];
  if (pages.length === 0 && entityPages.length === 0) {
    issues.push("Hệ thống phải có ít nhất một module quy trình hoặc một trang dữ liệu.");
  }
  if (pages.length > 5) {
    issues.push("Hệ thống chỉ được chứa tối đa 5 module quy trình.");
  }
  if (entityPages.length > 10) {
    issues.push("Hệ thống chỉ được chứa tối đa 10 trang dữ liệu.");
  }

  // 5. Kiểm tra từng module quy trình
  const pageIds = new Set();
  pages.forEach((page, index) => {
    const num = index + 1;
    if (!page.id || !page.id.trim()) {
      issues.push(`Module ${num}: Mã module không được để trống.`);
    } else if (!/^[a-z][a-z0-9_-]{0,15}$/.test(page.id)) {
      issues.push(`Module ${num}: Mã module "${page.id}" không hợp lệ (tối đa 16 ký tự, chỉ gồm chữ thường, số, gạch nối).`);
    } else if (pageIds.has(page.id)) {
      issues.push(`Module ${num}: Trùng mã module "${page.id}".`);
    } else {
      pageIds.add(page.id);
    }
    if (!page.title || !page.title.trim()) {
      issues.push(`Module ${num}: Tên module không được để trống.`);
    }
    if (!page.requesterRole) {
      issues.push(`Module ${num}: Chưa cấu hình vai trò người tạo.`);
    }
    if (!page.reviewerRole) {
      issues.push(`Module ${num}: Chưa cấu hình vai trò người duyệt.`);
    }
    if (!page.handlerRole) {
      issues.push(`Module ${num}: Chưa cấu hình vai trò người thực hiện.`);
    }
    if (!page.fields || page.fields.length === 0) {
      issues.push(`Module ${num}: Cần ít nhất một trường dữ liệu.`);
    } else {
      const fieldNames = new Set();
      page.fields.forEach((f, fIdx) => {
        if (!f.name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.name)) {
          issues.push(`Module ${num}, Trường ${fIdx + 1}: Tên trường "${f.name || ''}" không hợp lệ.`);
        } else if (["handlerId", "reason", "receiptNote"].includes(f.name)) {
          issues.push(`Module ${num}: Tên trường "${f.name}" trùng với trường dành riêng của hệ thống.`);
        } else if (fieldNames.has(f.name)) {
          issues.push(`Module ${num}: Trùng tên trường "${f.name}".`);
        } else {
          fieldNames.add(f.name);
        }
        if (!f.label || !f.label.trim()) {
          issues.push(`Module ${num}, Trường ${fIdx + 1}: Nhãn hiển thị không được để trống.`);
        }
      });
    }
    if (page.blocks && page.blocks.length === 0) {
      issues.push(`Module ${num}: Phải chọn ít nhất một block hiển thị.`);
    }
    if (page.workflow) {
      if (!page.workflow.initialState) {
        issues.push(`Module ${num}: Thiếu trạng thái bắt đầu của quy trình.`);
      }
      if (!page.workflow.transitions || page.workflow.transitions.length === 0) {
        issues.push(`Module ${num}: Quy trình phải có ít nhất một bước chuyển.`);
      } else {
        const transIds = new Set();
        page.workflow.transitions.forEach((t, tIdx) => {
          if (!t.id) issues.push(`Module ${num}, Bước ${tIdx + 1}: Thiếu mã hành động.`);
          else if (transIds.has(t.id)) issues.push(`Module ${num}: Trùng mã hành động bước "${t.id}".`);
          else transIds.add(t.id);
          if (!t.from) issues.push(`Module ${num}, Bước "${t.id || tIdx + 1}": Thiếu trạng thái nguồn.`);
          if (!t.to) issues.push(`Module ${num}, Bước "${t.id || tIdx + 1}": Thiếu trạng thái đích.`);
          if (!t.role) issues.push(`Module ${num}, Bước "${t.id || tIdx + 1}": Thiếu vai trò thực hiện.`);
        });
      }
    }
  });

  // 6. Kiểm tra các lược đồ dữ liệu & quan hệ
  const schemaIds = new Set(schemas.map((s) => s.id));
  schemas.forEach((s, sIdx) => {
    const num = sIdx + 1;
    if (!s.id) issues.push(`Lược đồ ${num}: Thiếu mã lược đồ.`);
    if (!s.title) issues.push(`Lược đồ ${num}: Thiếu tên lược đồ.`);
    if (s.relations) {
      Object.entries(s.relations).forEach(([relName, rel]) => {
        if (!rel.targetSchemaId || !schemaIds.has(rel.targetSchemaId)) {
          issues.push(`Lược đồ "${s.title || s.id}": Quan hệ "${relName}" trỏ tới lược đồ đích không tồn tại ("${rel.targetSchemaId}").`);
        }
      });
    }
  });

  // 7. Kiểm tra các trang dữ liệu
  entityPages.forEach((ep, epIdx) => {
    const num = epIdx + 1;
    if (!ep.id) issues.push(`Trang dữ liệu ${num}: Thiếu mã trang dữ liệu.`);
    if (!schemaIds.has(ep.schemaId)) issues.push(`Trang dữ liệu "${ep.title || ep.id}": Lược đồ liên kết không tồn tại.`);
    if (!ep.blocks || ep.blocks.length === 0) issues.push(`Trang dữ liệu "${ep.title || ep.id}": Phải chọn ít nhất một block.`);
  });

  // 8. Trùng lặp ID giữa Module và Trang dữ liệu
  const allPageIds = [...pages.map((p) => p.id), ...entityPages.map((ep) => ep.id)];
  if (new Set(allPageIds).size !== allPageIds.length) {
    issues.push("Trùng lặp mã giữa các module quy trình và trang dữ liệu.");
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
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
  blankRecipe,
  companyOperationsRecipe,
  exampleRecipe,
  validateRecipe,
  studioCommands,
  fieldValue,
  sameConfiguration,
};

