/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { enabledSections } = require("./console-model");
function createEnterpriseConsole(client, React) {
  const { useState, useEffect } = React;
  const shell = require("./system-shell").createSystemShell(client, React),
    { h, Frame, useSession, box, button, field, json } = shell;
  const Organization =
    require("./organization-screen").createOrganizationScreen(React, shell);
  const Data = require("./data-screen").createDataScreen(React, shell);
  const names = {
    home: "Tổng quan",
    work: "Việc của tôi",
    systems: "Thiết kế hệ thống",
    data: "Dữ liệu",
    organization: "Phòng ban & nhân sự",
    catalog: "Block & tích hợp",
    operations: "Vận hành",
  };
  function Console() {
    const session = useSession(),
      { api, connection, capabilities, act, busy } = session;
    const section =
        new URLSearchParams(location.search).get("section") || "home",
      sections = enabledSections(capabilities);
    const [result, setResult] = useState(null),
      [offset, setOffset] = useState(0),
      [query, setQuery] = useState(""),
      [selected, setSelected] = useState(null);
    async function load(next = 0) {
      setSelected(null);
      setResult(null);
      if (section === "home")
        setResult(
          await api.studio("apps", {
            query: { limit: "12", offset: String(next), q: query },
          }),
        );
      if (section === "work") {
        await api.workflow("member");
        setResult(
          await api.workflow("inbox", {
            query: { limit: "20", offset: String(next), q: query },
          }),
        );
      }
      if (section === "catalog") setResult(await api.studio("catalog"));
      if (section === "operations")
        setResult({
          diagnostics: await api.studio("diagnostics"),
          queues: await api.studio("queues"),
        });
      setOffset(next);
    }
    useEffect(() => {
      if (
        connection?.connected &&
        Object.keys(capabilities).length &&
        sections.includes(section)
      )
        act(() => load());
    }, [connection?.connected, capabilities, section]);
    function pages() {
      return h(
        "div",
        null,
        button(
          "Trang trước",
          () =>
            act(() =>
              load(Math.max(0, offset - (section === "home" ? 12 : 20))),
            ),
          busy || offset === 0,
        ),
        button(
          "Trang sau",
          () => act(() => load(result.page.nextOffset)),
          busy || !result?.page?.hasMore,
        ),
      );
    }
    return h(
      Frame,
      { session, title: "LatticeDX · Không gian doanh nghiệp" },
      h(
        "nav",
        { style: { ...box, display: "flex", gap: 4, flexWrap: "wrap" } },
        ...sections.map((id) =>
          h(
            "a",
            {
              key: id,
              href:
                id === "systems"
                  ? "/lattice/studio"
                  : "/lattice/console?section=" + id,
              style: {
                background: section === id ? "#e5efff" : "transparent",
                fontWeight: section === id ? 700 : 400,
              },
            },
            names[id],
          ),
        ),
      ),
      !sections.includes(section)
        ? h(
            "p",
            { role: "alert" },
            "Tài khoản không có quyền hoặc dịch vụ này chưa sẵn sàng.",
          )
        : h(
            React.Fragment,
            null,
            section === "organization" && h(Organization, { session }),
            section === "data" && h(Data, { session }),
            section === "home" &&
              h(
                React.Fragment,
                null,
                h(
                  "section",
                  {
                    style: {
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                      gap: 16,
                    },
                  },
                  ...sections
                    .filter((id) => id !== "home")
                    .map((id) =>
                      h(
                        "article",
                        { key: id, style: box },
                        h("h2", null, names[id]),
                        h(
                          "p",
                          null,
                          {
                            work: "Xử lý việc đang chờ bạn, theo đúng vai trò.",
                            systems:
                              "Ghép module, biểu mẫu và quy trình; kiểm tra rồi xuất bản.",
                            data: "Thiết kế cấu trúc, nhập liệu và chia sẻ có kiểm soát.",
                            organization:
                              "Quản trị cơ cấu và tra cứu thành viên.",
                            catalog:
                              "Các năng lực engine, connector và dịch vụ đã đăng ký.",
                            operations:
                              "Kiểm tra dịch vụ và hàng đợi của đơn vị.",
                          }[id],
                        ),
                        h(
                          "a",
                          {
                            href:
                              id === "systems"
                                ? "/lattice/studio"
                                : "/lattice/console?section=" + id,
                          },
                          "Mở →",
                        ),
                      ),
                    ),
                ),
                h(
                  "section",
                  { style: box },
                  h("h2", null, "Hệ thống của doanh nghiệp"),
                  field("Tìm hệ thống", query, setQuery),
                  button("Tìm", () => act(() => load()), busy),
                  ...(result?.items || []).map((system) =>
                    h(
                      "article",
                      { key: system.id + system.version, style: box },
                      h(
                        "a",
                        {
                          href:
                            "/lattice/systems/" +
                            system.id +
                            "/" +
                            system.version,
                        },
                        system.title,
                      ),
                      h(
                        "p",
                        null,
                        "Phiên bản " +
                          system.version +
                          " · " +
                          (system.enabled
                            ? "Đang sử dụng"
                            : "Tạm dừng tạo mới"),
                      ),
                    ),
                  ),
                  result &&
                    !result.items.length &&
                    h(
                      "p",
                      null,
                      "Chưa có hệ thống phù hợp với vai trò. Người thiết kế cần xuất bản hệ thống trước.",
                    ),
                  pages(),
                ),
              ),
            section === "work" &&
              h(
                "section",
                { style: box },
                h("h2", null, "Việc chờ tôi xử lý"),
                field("Tìm công việc", query, setQuery),
                button("Tìm / tải lại", () => act(() => load()), busy),
                ...(result?.items || []).map((run) =>
                  h(
                    "article",
                    { key: run.id, style: box },
                    h("strong", null, run.title),
                    h("p", null, run.definitionId + " · " + run.state),
                    button(
                      "Xem và xử lý",
                      () =>
                        act(async () => {
                          setSelected(
                            await api.workflow("detail", { id: run.id }),
                          );
                        }),
                      busy,
                    ),
                  ),
                ),
                result &&
                  !result.items.length &&
                  h(
                    "p",
                    null,
                    "Hiện không có bước nào đang chờ bạn thực hiện.",
                  ),
                pages(),
                selected &&
                  h(WorkDetail, {
                    key:selected.id+':'+selected.version,
                    session,
                    run: selected,
                    reload: () => load(offset),
                  }),
              ),
            section === "catalog" &&
              result &&
              h(
                "section",
                { style: box },
                h("h2", null, "Năng lực dùng chung của engine"),
                h(
                  "p",
                  null,
                  "Danh sách lấy trực tiếp từ backend theo quyền hiện tại. Connector chỉ là đăng ký tham chiếu; cần worker/tích hợp tương ứng để thực thi.",
                ),
                ...["actions", "blocks"].map((key) =>
                  h(
                    "div",
                    { key },
                    h(
                      "h3",
                      null,
                      key === "actions" ? "Hành động" : "Block dữ liệu",
                    ),
                    ...result[key].map((item) =>
                      h(
                        "p",
                        { key: item.id },
                        h("strong", null, item.title || item.id),
                        " · " +
                          item.id +
                          " · " +
                          (item.availability.available
                            ? "Sẵn sàng"
                            : "Chưa sẵn sàng"),
                      ),
                    ),
                  ),
                ),
                h("h3", null, "Block quy trình"),
                ...result.workflow.blocks.map((item) =>
                  h(
                    "p",
                    { key: item.id },
                    item.title +
                      " · " +
                      item.id +
                      " · " +
                      (item.availability.available
                        ? "Sẵn sàng"
                        : "Chưa sẵn sàng"),
                  ),
                ),
                h("h3", null, "Connector đã đăng ký"),
                result.connectors.length
                  ? json(result.connectors)
                  : h(
                      "p",
                      null,
                      "Không có connector được công bố cho vai trò này.",
                    ),
                h("h3", null, "Dịch vụ chạy nền đã đăng ký"),
                result.services.length
                  ? json(result.services)
                  : h(
                      "p",
                      null,
                      "Không có dịch vụ chạy nền được công bố cho vai trò này.",
                    ),
              ),
            section === "operations" &&
              result &&
              h(
                "section",
                { style: box },
                h("h2", null, "Tình trạng vận hành"),
                button("Tải lại", () => act(() => load()), busy),
                h("h3", null, "Dịch vụ lõi"),
                json(result.diagnostics),
                h("h3", null, "Hàng đợi trong đơn vị"),
                json(result.queues),
              ),
          ),
    );
  }
  function WorkDetail({ session, run, reload }) {
    const { api, workflow, act, busy } = session,
      [values, setValues] = useState({});
    return h(
      "section",
      { style: box },
      h("h2", null, run.title),
      json(run.data),
      ...run.availableTransitions.map((transition) =>
        h(
          "fieldset",
          {
            key: transition.id,
            disabled: busy || workflow.uncertain,
            style: box,
          },
          h("legend", null, transition.id + " → " + transition.to),
          ...Object.entries(transition.fields).map(([name, type]) =>
            h(
              "div",
              { key: name },
              field(
                name,
                values[name] || "",
                (value) => setValues((v) => ({ ...v, [name]: value })),
                type === "positiveInteger" ? "number" : "text",
              ),
            ),
          ),
          button("Thực hiện " + transition.id, () =>
            act(async () => {
              for (const name of Object.keys(transition.fields))
                if (!values[name]) throw Error("Thiếu trường: " + name);
              await workflow.execute(
                "transition",
                {
                  action: transition.id,
                  expectedVersion: run.version,
                  input: Object.fromEntries(
                    Object.keys(transition.fields).map((name) => [
                      name,
                      values[name],
                    ]),
                  ),
                },
                run.id,
              );
              await reload();
            }),
          ),
        ),
      ),
    );
  }
  return Console;
}
module.exports = { createEnterpriseConsole };
