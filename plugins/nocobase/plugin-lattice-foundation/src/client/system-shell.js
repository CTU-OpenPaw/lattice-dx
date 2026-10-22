// SPDX-License-Identifier: Apache-2.0
const { createWorkspaceApi } = require("./workspace-api");
const { createWorkflowCommands } = require("./workflow");
const { studioCommands } = require("./system-model");
const { consoleTransport } = require("./console-model");
function createSystemShell(client, React) {
  const h = React.createElement,
    { useState, useEffect, useMemo } = React;
  const box = {
    border: "1px solid #d9e2ec",
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
    background: "#fff",
  };
  const inputStyle = {
    padding: 8,
    border: "1px solid #bbc6d1",
    borderRadius: 5,
    maxWidth: "100%",
    width: 300,
  };
  const labels = {
    submit: "Gửi duyệt",
    approve: "Phê duyệt và giao việc",
    reject: "Từ chối",
    complete: "Hoàn thành",
  };
  function button(label, fn, disabled = false) {
    return h(
      "button",
      {
        type: "button",
        onClick: fn,
        disabled,
        style: {
          padding: "8px 14px",
          margin: "4px 8px 4px 0",
          cursor: "pointer",
        },
      },
      label,
    );
  }
  function field(label, value, change, type = "text") {
    return h(
      "label",
      {
        style: {
          display: "inline-flex",
          flexDirection: "column",
          gap: 5,
          margin: "6px 16px 10px 0",
        },
      },
      label,
      h("input", {
        style: inputStyle,
        type,
        value,
        onChange: (e) => change(e.target.value),
      }),
    );
  }
  function json(value) {
    return h(
      "pre",
      {
        style: {
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          background: "#f4f6f8",
          padding: 12,
        },
      },
      JSON.stringify(value, null, 2),
    );
  }
  function download(recipe) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(recipe, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = recipe.id + ".recipe.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function useSession() {
    const apiClient = client.useAPIClient(),
      [connection, setConnection] = useState(null),
      [notice, setNotice] = useState(""),
      [busy, setBusy] = useState(false),
      [capabilities, setCapabilities] = useState({});
    const api = useMemo(() => {
      const result = createWorkspaceApi({
        apiClient,
        notify: (n) => setNotice(n.message),
        onExpired: () => {
          setConnection(null);
          setCapabilities({});
        },
      });
      const sendStudio = async (operation, payload = {}) =>
        (
          await result.request({
            url: "dxActions:studio",
            method: "post",
            data: { ...payload, operation },
          })
        ).data;
      result.studio = consoleTransport({
        studio: sendStudio,
        entity: result.entity,
      });
      return result;
    }, [apiClient]);
    const act = async (fn) => {
      setBusy(true);
      setNotice("");
      try {
        return await fn();
      } catch (error) {
        setNotice(error.message);
        return undefined;
      } finally {
        setBusy(false);
      }
    };
    useEffect(() => {
      act(async () => {
        await api.user();
        const linked = await api.connection();
        setConnection(linked);
        if (linked.connected)
          setCapabilities((await api.workflow("capabilities")).capabilities);
      });
    }, [api]);
    useEffect(() => {
      if (!connection?.connected) return;
      const timer = setTimeout(
        () => {
          setConnection(null);
          setCapabilities({});
        },
        Math.max(0, new Date(connection.expiresAt).getTime() - Date.now()),
      );
      return () => clearTimeout(timer);
    }, [connection]);
    const commands = useMemo(
      () => studioCommands(api, connection?.identity?.subject),
      [api, connection?.identity?.subject],
    );
    const workflow = useMemo(
      () =>
        createWorkflowCommands({ api, actorId: connection?.identity?.subject }),
      [api, connection?.identity?.subject],
    );
    return {
      api,
      connection,
      capabilities,
      notice,
      busy,
      act,
      commands,
      workflow,
      report: setNotice,
    };
  }
  function Frame({ session, title, children }) {
    const { api, connection, notice, busy, act, commands, workflow } = session;
    return h(
      "main",
      {
        className: "dx-console",
        style: {
          maxWidth: 1200,
          margin: "24px auto",
          padding: 24,
          fontFamily: "system-ui",
          color: "#172b4d",
          background: "#f5f7fa",
          minHeight: "90vh",
        },
      },
      h(
        "style",
        null,
        `.dx-console button{border:1px solid #cad6e2;background:white;color:#1b365d;border-radius:7px;font-weight:500}.dx-console button:hover:not(:disabled){background:#eaf2ff;border-color:#81a8de}.dx-console button:disabled{opacity:.45;cursor:default}.dx-console input,.dx-console select,.dx-console textarea{font:inherit}.dx-console h1{font-size:28px;letter-spacing:-.7px}.dx-console h2{font-size:19px}.dx-console nav a{display:inline-block;padding:8px 12px;border-radius:6px;text-decoration:none}.dx-console nav a:hover{background:#e8f0ff}.dx-console table{width:100%;border-collapse:collapse}.dx-console th,.dx-console td{padding:10px;text-align:left;border-bottom:1px solid #e3e9ef;vertical-align:top}.dx-console fieldset{min-width:0}`,
      ),
      h(
        "nav",
        null,
        h("a", { href: "/lattice/console" }, "LatticeDX · Điều hành"),
        h("a", { href: "/lattice" }, "Workspace"),
        " · ",
        h("a", { href: "/lattice/studio" }, "Studio"),
        " · ",
        h("a", { href: "/lattice/systems" }, "Hệ thống đã xuất bản"),
      ),
      h("h1", null, title),
      h(
        "section",
        { style: box },
        connection?.connected
          ? h(
              React.Fragment,
              null,
              "Tài khoản: " +
                connection.identity.username +
                " · " +
                connection.identity.organizationId,
              button(
                "Đổi tài khoản nghiệp vụ",
                () =>
                  act(async () => {
                    await api.disconnect();
                    sessionStorage.setItem(
                      "lattice:return-to",
                      location.pathname + location.search,
                    );
                    location.assign(await api.connect());
                  }),
                busy,
              ),
            )
          : button(
              "Kết nối tài khoản nghiệp vụ",
              () =>
                act(async () => {
                  sessionStorage.setItem(
                    "lattice:return-to",
                    location.pathname + location.search,
                  );
                  location.assign(await api.connect());
                }),
              busy,
            ),
      ),
      notice &&
        h(
          "p",
          { role: "alert", style: { background: "#fff1df", padding: 14 } },
          notice,
        ),
      (commands.uncertain || workflow.uncertain) &&
        h(
          "section",
          { style: box },
          "Lệnh trước chưa xác định kết quả. Hãy thử lại cùng lệnh trước khi thao tác tiếp.",
          button(
            "Thử lại lệnh cũ",
            () =>
              act(async () => {
                await (commands.uncertain ? commands : workflow).retry();
                location.reload();
              }),
            busy,
          ),
        ),
      connection?.connected
        ? children
        : h(
            "p",
            null,
            "Đăng nhập NocoBase tại /signin trước, sau đó kết nối tài khoản nghiệp vụ.",
          ),
    );
  }

  return {
    h,
    box,
    inputStyle,
    labels,
    button,
    field,
    json,
    download,
    useSession,
    Frame,
  };
}
module.exports = { createSystemShell };
