/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
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
      if (!connection?.connected || !connection?.expiresAt) return;
      const expiry = new Date(connection.expiresAt).getTime();
      if (Number.isNaN(expiry)) return;
      const timer = setTimeout(
        () => {
          setConnection(null);
          setCapabilities({});
        },
        Math.max(0, expiry - Date.now()),
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
    const currentPath =
      typeof location !== "undefined"
        ? location.pathname + location.search
        : "";
    const signinHref = "/signin?redirect=" + encodeURIComponent(currentPath);

    const navBar = h(
      "nav",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 0 18px 0",
          borderBottom: "1px solid #e2e8f0",
          marginBottom: 24,
          fontSize: 14,
        },
      },
      h(
        "a",
        {
          href: "/lattice/console",
          style: { color: "#1e293b", fontWeight: 700, textDecoration: "none" },
        },
        "LatticeDX · Điều hành",
      ),
      h("span", { style: { color: "#cbd5e1" } }, "/"),
      h(
        "a",
        {
          href: "/lattice",
          style: { color: "#64748b", textDecoration: "none" },
        },
        "Workspace",
      ),
      h("span", { style: { color: "#cbd5e1" } }, "·"),
      h(
        "a",
        {
          href: "/lattice/studio",
          style: { color: "#2563eb", fontWeight: 600, textDecoration: "none" },
        },
        "Studio",
      ),
      h("span", { style: { color: "#cbd5e1" } }, "·"),
      h(
        "a",
        {
          href: "/lattice/systems",
          style: { color: "#64748b", textDecoration: "none" },
        },
        "Hệ thống đã xuất bản",
      ),
    );

    if (!connection?.connected) {
      return h(
        "main",
        {
          className: "dx-console",
          style: {
            maxWidth: 1200,
            margin: "0 auto",
            padding: "16px 24px",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            color: "#0f172a",
            minHeight: "90vh",
          },
        },
        h(
          "style",
          null,
          `.dx-console button{font-family:inherit;cursor:pointer}.dx-console button:disabled{opacity:.5;cursor:not-allowed}`,
        ),
        navBar,
        notice &&
          h(
            "p",
            {
              role: "alert",
              style: {
                background: "#fff1df",
                border: "1px solid #fed7aa",
                padding: 12,
                borderRadius: 8,
                margin: "0 auto 20px auto",
                maxWidth: 520,
              },
            },
            notice,
          ),
        h(
          "div",
          {
            style: {
              maxWidth: 520,
              margin: "32px auto",
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              padding: "32px 32px 28px 32px",
              boxShadow:
                "0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)",
            },
          },
          h(
            "div",
            {
              style: {
                display: "inline-block",
                background: "#eff6ff",
                border: "1px solid #dbeafe",
                color: "#1d4ed8",
                padding: "3px 10px",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.5px",
                textTransform: "uppercase",
                marginBottom: 12,
              },
            },
            "LatticeDX Studio · Xác thực",
          ),
          h(
            "h1",
            {
              style: {
                fontSize: 22,
                fontWeight: 700,
                margin: "0 0 8px 0",
                color: "#0f172a",
                letterSpacing: "-0.5px",
              },
            },
            title,
          ),
          h(
            "p",
            {
              style: {
                fontSize: 13,
                color: "#64748b",
                margin: "0 0 24px 0",
                lineHeight: 1.5,
              },
            },
            "Khu vực thiết kế hệ thống và cấu hình lược đồ doanh nghiệp. Vui lòng hoàn tất 2 bước xác thực bên dưới để mở khóa bảng điều khiển.",
          ),
          // Step 1
          h(
            "div",
            {
              style: {
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: "16px",
                marginBottom: 12,
              },
            },
            h(
              "div",
              {
                style: {
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#1e293b",
                  marginBottom: 4,
                },
              },
              "1. Nền tảng NocoBase",
            ),
            h(
              "div",
              { style: { fontSize: 12, color: "#64748b", marginBottom: 10 } },
              "Đăng nhập tài khoản quản trị để tải khung giao diện plugin",
            ),
            h(
              "a",
              {
                href: signinHref,
                style: {
                  display: "inline-block",
                  padding: "7px 16px",
                  background: "#ffffff",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  color: "#1e293b",
                  textDecoration: "none",
                  fontWeight: 600,
                  fontSize: 13,
                },
              },
              "Đăng nhập NocoBase →",
            ),
          ),
          // Step 2
          h(
            "div",
            {
              style: {
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: "16px",
                marginBottom: 20,
              },
            },
            h(
              "div",
              {
                style: {
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#1e293b",
                  marginBottom: 4,
                },
              },
              "2. Tài khoản nghiệp vụ doanh nghiệp",
            ),
            h(
              "div",
              { style: { fontSize: 12, color: "#64748b", marginBottom: 10 } },
              "Xác thực danh tính quản trị qua cổng Keycloak SSO để cấp quyền thiết kế",
            ),
            h(
              "button",
              {
                onClick: () =>
                  act(async () => {
                    sessionStorage.setItem("lattice:return-to", currentPath);
                    location.assign(await api.connect());
                  }),
                disabled: busy,
                style: {
                  padding: "9px 20px",
                  background: "#1b365d",
                  border: "none",
                  borderRadius: 6,
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: 13,
                },
              },
              busy ? "Đang kết nối…" : "Kết nối tài khoản nghiệp vụ (SSO)",
            ),
          ),
          // Fixture credentials helper
          h(
            "div",
            {
              style: {
                background: "#f1f5f9",
                borderRadius: 8,
                padding: "12px 14px",
                fontSize: 12,
                color: "#475569",
                lineHeight: 1.6,
              },
            },
            h(
              "div",
              { style: { fontWeight: 600, color: "#334155", marginBottom: 2 } },
              "Tài khoản kiểm thử nhanh (Fixture):",
            ),
            h(
              "div",
              null,
              "• NocoBase: ",
              h(
                "code",
                {
                  style: {
                    background: "#e2e8f0",
                    padding: "1px 4px",
                    borderRadius: 4,
                  },
                },
                "admin@nocobase.com",
              ),
              " / ",
              h(
                "code",
                {
                  style: {
                    background: "#e2e8f0",
                    padding: "1px 4px",
                    borderRadius: 4,
                  },
                },
                "admin123",
              ),
            ),
            h(
              "div",
              null,
              "• Keycloak Admin: ",
              h(
                "code",
                {
                  style: {
                    background: "#e2e8f0",
                    padding: "1px 4px",
                    borderRadius: 4,
                  },
                },
                "alice",
              ),
              " / ",
              h(
                "code",
                {
                  style: {
                    background: "#e2e8f0",
                    padding: "1px 4px",
                    borderRadius: 4,
                  },
                },
                "local-alice-password",
              ),
            ),
          ),
          h(
            "p",
            {
              style: {
                fontSize: 11,
                color: "#94a3b8",
                textAlign: "center",
                margin: "20px 0 0 0",
              },
            },
            "Được bảo vệ bởi kiến trúc phân quyền bảo mật LatticeDX Zero Trust",
          ),
        ),
      );
    }

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
      navBar,
      h("h1", null, title),
      h(
        "section",
        { style: box },
        h(
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
                sessionStorage.setItem("lattice:return-to", currentPath);
                location.assign(await api.connect());
              }),
            busy,
          ),
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
      children,
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
