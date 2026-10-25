// SPDX-License-Identifier: Apache-2.0
function createRuntimeBlocks(React, { h, box, button, json }) {
  return function RuntimeBlocks({
    order,
    children,
    selected,
    history,
    sync,
    inbox,
    setInbox,
    busy,
    loadSync,
  }) {
    const [create, list, detail] = Array.isArray(children)
      ? children
      : children
        ? [children]
        : [];
    const blocks = {
      create,
      list,
      detail,
      inbox: h(
        "section",
        { style: box },
        button(
          inbox
            ? "Xem tất cả hồ sơ được phép đọc"
            : "Chỉ xem việc chờ tôi xử lý",
          () => setInbox(!inbox),
          busy,
        ),
      ),
      history:
        selected &&
        h(
          "section",
          { style: box },
          h("h3", null, "Lịch sử xử lý"),
          history && json(history),
        ),
      sync:
        selected &&
        h(
          "section",
          { style: box },
          button("Xem trạng thái đồng bộ", loadSync, busy),
          sync && json(sync),
        ),
    };
    return h(
      React.Fragment,
      null,
      order.map((id) => h("div", { key: id }, blocks[id])),
    );
  };
}
module.exports = { createRuntimeBlocks };
