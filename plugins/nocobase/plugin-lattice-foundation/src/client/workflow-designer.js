// SPDX-License-Identifier: Apache-2.0
const { workflowForPage, moveItem } = require("./console-model");
function createWorkflowDesigner(React, { h, box, button, field }) {
  const allBlocks = {
    create: "Biểu mẫu tạo mới",
    list: "Danh sách hồ sơ",
    inbox: "Bộ lọc việc của tôi",
    detail: "Chi tiết và hành động",
    history: "Lịch sử",
    sync: "Trạng thái đồng bộ",
  };
  return function WorkflowDesigner({ page, onChange }) {
    const blocks = page.blocks || Object.keys(allBlocks),
      flow = workflowForPage(page);
    const updateFlow = (change) =>
      onChange({ ...page, workflow: change(flow) });
    const transition = (index, change) =>
      updateFlow((current) => ({
        ...current,
        transitions: current.transitions.map((item, i) =>
          i === index ? change(item) : item,
        ),
      }));
    return h(
      "section",
      { style: box },
      h("h3", null, "Các block trong màn hình module"),
      h(
        "p",
        null,
        "Chọn block cần dùng và sắp thứ tự. Quyền truy cập dữ liệu luôn do engine kiểm tra.",
      ),
      ...Object.entries(allBlocks).map(([id, label]) =>
        h(
          "label",
          {
            key: id,
            style: { display: "inline-block", margin: "4px 14px 4px 0" },
          },
          h("input", {
            type: "checkbox",
            checked: blocks.includes(id),
            disabled: blocks.length === 1 && blocks.includes(id),
            onChange: (event) =>
              onChange({
                ...page,
                blocks: event.target.checked
                  ? [...blocks, id]
                  : blocks.filter((item) => item !== id),
              }),
          }),
          " " + label,
        ),
      ),
      h(
        "ol",
        null,
        ...blocks.map((id, index) =>
          h(
            "li",
            { key: id },
            allBlocks[id],
            button(
              "↑",
              () => onChange({ ...page, blocks: moveItem(blocks, index, -1) }),
              index === 0,
            ),
            button(
              "↓",
              () => onChange({ ...page, blocks: moveItem(blocks, index, 1) }),
              index === blocks.length - 1,
            ),
          ),
        ),
      ),
      h("h3", null, "Thiết kế quy trình"),
      !page.workflow
        ? h(
            React.Fragment,
            null,
            h(
              "p",
              null,
              "Đang dùng mẫu: nháp → gửi duyệt → phê duyệt và giao việc → hoàn thành / từ chối.",
            ),
            button("Tùy chỉnh các bước quy trình", () =>
              onChange({ ...page, workflow: flow }),
            ),
          )
        : h(
            React.Fragment,
            null,
            field("Trạng thái bắt đầu", flow.initialState, (value) =>
              updateFlow((current) => ({ ...current, initialState: value })),
            ),
            field(
              "Trạng thái người nhận được đọc (dấu phẩy)",
              flow.assignedStates.join(","),
              (value) =>
                updateFlow((current) => ({
                  ...current,
                  assignedStates: value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                })),
            ),
            h(
              "p",
              null,
              "Sơ đồ: " +
                flow.transitions
                  .map((item) => item.from + " ─" + item.id + "→ " + item.to)
                  .join("   |   "),
            ),
            ...flow.transitions.map((item, index) =>
              h(
                "section",
                { key: index, style: box },
                h("h4", null, "Bước " + (index + 1) + " · " + item.id),
                field("Mã hành động", item.id, (value) =>
                  transition(index, (current) => ({ ...current, id: value })),
                ),
                field("Từ trạng thái", item.from, (value) =>
                  transition(index, (current) => ({ ...current, from: value })),
                ),
                field("Đến trạng thái", item.to, (value) =>
                  transition(index, (current) => ({ ...current, to: value })),
                ),
                field("Vai trò thực hiện", item.role, (value) =>
                  transition(index, (current) => ({ ...current, role: value })),
                ),
                h(
                  "label",
                  null,
                  h("input", {
                    type: "checkbox",
                    checked: !!item.ownerOnly,
                    onChange: (event) =>
                      transition(index, (current) => ({
                        ...current,
                        ownerOnly: event.target.checked,
                      })),
                  }),
                  " Chỉ người tạo",
                ),
                h(
                  "label",
                  null,
                  h("input", {
                    type: "checkbox",
                    checked: item.assigneeField === "handlerId",
                    onChange: (event) =>
                      transition(index, (current) => {
                        const next = { ...current };
                        if (event.target.checked)
                          next.assigneeField = "handlerId";
                        else delete next.assigneeField;
                        return next;
                      }),
                  }),
                  " Chỉ người được giao",
                ),
                h(
                  "label",
                  null,
                  " Tác động công việc ",
                  h(
                    "select",
                    {
                      value: item.task || "",
                      onChange: (event) =>
                        transition(index, (current) => {
                          const next = { ...current };
                          if (event.target.value)
                            next.task = event.target.value;
                          else delete next.task;
                          return next;
                        }),
                    },
                    h("option", { value: "" }, "Không đổi"),
                    h(
                      "option",
                      { value: "assign" },
                      "Giao việc cho người đã chọn",
                    ),
                    h(
                      "option",
                      { value: "complete" },
                      "Hoàn thành việc liên kết",
                    ),
                  ),
                ),
                h("p", null, "Dữ liệu cần nhập khi thực hiện bước:"),
                ...Object.entries(item.fields).map(([name, type], fieldIndex) =>
                  h(
                    "div",
                    { key: fieldIndex },
                    field("Tên trường của bước", name, (value) =>
                      transition(index, (current) => {
                        const entries = Object.entries(current.fields);
                        entries[fieldIndex] = [value, type];
                        return {
                          ...current,
                          fields: Object.fromEntries(entries),
                        };
                      }),
                    ),
                    h(
                      "select",
                      {
                        value: type,
                        onChange: (event) =>
                          transition(index, (current) => ({
                            ...current,
                            fields: {
                              ...current.fields,
                              [name]: event.target.value,
                            },
                          })),
                      },
                      h("option", { value: "text" }, "Văn bản"),
                      h(
                        "option",
                        { value: "positiveInteger" },
                        "Số nguyên dương",
                      ),
                    ),
                    button("Xóa trường bước", () =>
                      transition(index, (current) => ({
                        ...current,
                        fields: Object.fromEntries(
                          Object.entries(current.fields).filter(
                            ([key]) => key !== name,
                          ),
                        ),
                      })),
                    ),
                  ),
                ),
                button("Thêm trường cho bước", () =>
                  transition(index, (current) => {
                    let number = Object.keys(current.fields).length + 1;
                    while (Object.hasOwn(current.fields, "note" + number))
                      number++;
                    return {
                      ...current,
                      fields: { ...current.fields, ["note" + number]: "text" },
                    };
                  }),
                ),
                h(
                  "details",
                  null,
                  h("summary", null, "Điều kiện hiển thị / thực hiện"),
                  h(
                    "p",
                    null,
                    "Điều kiện kiểm tra dữ liệu đã có trong hồ sơ, không kiểm tra ô nhập của bước chưa chạy.",
                  ),
                  !item.condition
                    ? button("Thêm điều kiện", () =>
                        transition(index, (current) => ({
                          ...current,
                          condition: {
                            field: page.fields[0]?.name || "",
                            operator: "eq",
                            value: "",
                          },
                        })),
                      )
                    : "all" in item.condition || "any" in item.condition
                      ? h(
                          "p",
                          null,
                          "Điều kiện tổng hợp từ gói nhập được giữ nguyên; trình sửa đơn giản hỗ trợ một điều kiện.",
                        )
                      : h(
                          React.Fragment,
                          null,
                          field(
                            "Trường dữ liệu",
                            item.condition.field,
                            (value) =>
                              transition(index, (current) => ({
                                ...current,
                                condition: {
                                  ...current.condition,
                                  field: value,
                                },
                              })),
                          ),
                          h(
                            "select",
                            {
                              value: item.condition.operator,
                              onChange: (event) =>
                                transition(index, (current) => ({
                                  ...current,
                                  condition: {
                                    field: current.condition.field,
                                    operator: event.target.value,
                                    ...(event.target.value === "exists"
                                      ? {}
                                      : {
                                          value: current.condition.value || "",
                                        }),
                                  },
                                })),
                            },
                            h("option", { value: "eq" }, "Bằng"),
                            h("option", { value: "gt" }, "Lớn hơn"),
                            h("option", { value: "exists" }, "Có giá trị"),
                          ),
                          item.condition.operator !== "exists" &&
                            field(
                              "Giá trị so sánh",
                              item.condition.value,
                              (value) =>
                                transition(index, (current) => ({
                                  ...current,
                                  condition: { ...current.condition, value },
                                })),
                            ),
                        ),
                  item.condition &&
                    button("Bỏ điều kiện", () =>
                      transition(index, (current) => {
                        const next = { ...current };
                        delete next.condition;
                        return next;
                      }),
                    ),
                ),
                button(
                  "Đưa bước lên",
                  () =>
                    updateFlow((current) => ({
                      ...current,
                      transitions: moveItem(current.transitions, index, -1),
                    })),
                  index === 0,
                ),
                button(
                  "Đưa bước xuống",
                  () =>
                    updateFlow((current) => ({
                      ...current,
                      transitions: moveItem(current.transitions, index, 1),
                    })),
                  index === flow.transitions.length - 1,
                ),
                button(
                  "Xóa bước",
                  () =>
                    updateFlow((current) => ({
                      ...current,
                      transitions: current.transitions.filter(
                        (_, i) => i !== index,
                      ),
                    })),
                  flow.transitions.length === 1,
                ),
              ),
            ),
            button(
              "Thêm bước",
              () =>
                updateFlow((current) => {
                  let number = current.transitions.length + 1;
                  while (
                    current.transitions.some(
                      (item) => item.id === "step" + number,
                    )
                  )
                    number++;
                  return {
                    ...current,
                    transitions: [
                      ...current.transitions,
                      {
                        id: "step" + number,
                        from: current.initialState,
                        to: "stage" + number,
                        role: page.reviewerRole,
                        fields: {},
                      },
                    ],
                  };
                }),
              flow.transitions.length >= 20,
            ),
            h(
              "p",
              null,
              "Ví dụ thêm duyệt tài chính: thêm bước submitted → finance-reviewed cho vai trò tài chính; đổi bước approve thành finance-reviewed → approved. Vai trò phải được cấp sẵn qua Keycloak.",
            ),
            button("Quay về mẫu mặc định", () => {
              const next = { ...page };
              delete next.workflow;
              onChange(next);
            }),
          ),
      h(
        "p",
        null,
        "Connector/agent: xem danh mục tại trang điều hành. Mỗi tích hợp cần hợp đồng và worker phù hợp; không tự gắn một worker bất kỳ vào quy trình này.",
      ),
    );
  };
}
module.exports = { createWorkflowDesigner };
