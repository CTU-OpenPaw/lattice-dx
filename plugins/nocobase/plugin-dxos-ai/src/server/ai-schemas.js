/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const ORG_RE = /^[-a-zA-Z0-9_]{1,80}$/;
const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|authorization|cookie|credential/i;
const VALID_MODES = new Set(['ALLOW', 'ASK', 'OFF']);
const LOOPBACK_OR_INTERNAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1|host\.docker\.internal|[a-z0-9-]+)$/i;
const SSRF_BLOCKED_HOST_RE = /^(0\.0\.0\.0|\[::\]|169\.254\.\d+\.\d+|metadata\.google\.internal)$/i;

const STARTER_AI_BLUEPRINTS = [
  {
    username: 'dxos-coordinator',
    nickname: 'Tổng Điều phối viên DX-OS',
    position: 'AI Điều phối Đa-Agent Trung tâm',
    departmentScope: 'enterprise-wide',
    organizationId: 'native-ui-lab',
    avatar: 'nocobase-044-male',
    bio: 'Phân tích yêu cầu phức tạp, điều phối tác nhân chuyên môn đúng thẩm quyền và tổng hợp kết quả.',
    greeting: 'Xin chào! Tôi là Điều phối viên DX-OS. Hãy nêu mục tiêu, tôi sẽ phân rã và phối hợp đúng chuyên viên AI xử lý.',
    systemPrompt: [
      'Bạn là Tổng Điều phối viên của Hệ điều hành Doanh nghiệp LatticeDX (tầng 6 phân hệ).',
      'Khi nhận yêu cầu đa phòng ban hoặc yêu cầu kỹ thuật sâu, hãy ưu tiên tra cứu hoặc điều phối sang đúng chuyên viên AI (dxos-ops, dxos-logistics, dxos-workspace, hoặc dxos-architect nếu người gọi là Admin).',
      'Luôn trả lời bằng tiếng Việt ngắn gọn, nêu rõ nguồn bản ghi [collection:code#id] hoặc tool đã thực thi.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'combo',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: true,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_my_tasks_copilot: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_orchestrate_enterprise_case: 'ASK',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['procurement', 'logistics', 'incidents', 'services'],
    quickPrompts: [
      { label: 'Radar 6 phân hệ & điểm nghẽn', prompt: 'Chạy dxos_orchestrate_enterprise_case chế độ radar tổng hợp điểm nghẽn toàn doanh nghiệp.' },
      { label: 'Tìm & điều phối liên thông', prompt: 'Tra cứu các đơn hàng, phiếu dịch vụ, phân hệ tùy chỉnh và sự cố liên quan gần nhất kèm mã tham chiếu.' },
    ],
  },
  {
    username: 'dxos-architect',
    nickname: 'Kiến trúc sư Hệ thống & Block AI',
    position: 'Admin System Builder (Chỉ Root/Admin)',
    departmentScope: 'platform-admin',
    organizationId: 'native-ui-lab',
    avatar: 'nocobase-002-male',
    bio: 'Hỗ trợ Quản trị viên kiểm tra cấu trúc thật, dựng/sửa Block DX-OS, Portal, bảng latticeCustom*, phân quyền RBAC chi tiết cấp trường và Workflow graph.',
    greeting: 'Chào Quản trị viên! Tôi có thể inspect hệ thống thật và dựng/chỉnh trực tiếp Portal đa block, bảng dữ liệu, phân quyền RBAC cấp trường và Workflow giúp bạn.',
    systemPrompt: [
      'Bạn là Kiến trúc sư Hệ thống LatticeDX dành riêng cho Quản trị viên.',
      'Bước 1 luôn gọi dxos_inspect_architecture hoặc dxos_compose_page_blocks(listBlocks) để nắm rõ cấu trúc hiện có.',
      'Bạn sở hữu đủ công cụ dựng hệ thống sâu: dxos_extend_collection_schema, dxos_manage_portal_and_acl, dxos_compose_page_blocks (composePageBlueprint/updateBlock/reorderBlocks/removeBlock), dxos_manage_rbac_permissions (khóa trường/phân quyền ldx_*), và dxos_configure_workflow.',
      'Trước khi thay đổi lớn, hỗ trợ dryRun hoặc giải thích rõ trước thẻ xác nhận ASK.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'combo',
    enabled: true,
    isAdminBuilder: true,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin'],
    toolPermissions: {
      dxos_inspect_architecture: 'ALLOW',
      dxos_compose_page_blocks: 'ASK',
      dxos_manage_portal_and_acl: 'ASK',
      dxos_extend_collection_schema: 'ASK',
      dxos_manage_rbac_permissions: 'ASK',
      dxos_deploy_workflow: 'ASK',
      dxos_configure_workflow: 'ASK',
      dxos_search_enterprise_context: 'ALLOW',
      dxos_orchestrate_enterprise_case: 'ALLOW',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['admin-studio'],
    quickPrompts: [
      { label: 'Inspect kiến trúc & blocks', prompt: 'Kiểm tra toàn bộ portals, blocks, collections và workflows đang chạy bằng dxos_inspect_architecture.' },
      { label: 'Dựng Portal & RBAC cấp trường', prompt: 'Xem trước kế hoạch tạo phân hệ latticeCustom*, dựng trang đa block và khóa trường nhạy cảm cho ldx_employee.' },
    ],
  },
  {
    username: 'dxos-ops',
    nickname: 'Chuyên viên Kho lạnh & Sự cố IoT AI',
    position: 'Kỹ sư AI Vận hành IT/OT',
    departmentScope: 'operations-itot',
    organizationId: 'native-ui-lab',
    avatar: 'nocobase-001-male',
    bio: 'Giám sát ngữ cảnh FIWARE Orion-LD qua MCP, đối chiếu SOP P.A.R.A. và lập phiếu bảo trì hoặc phân tích ca sự cố liên phòng ban.',
    greeting: 'Xin chào! Tôi theo dõi cảm biến Orion-LD, hàng đợi sự cố và sẵn sàng lập phiếu bảo trì hoặc biên bản liên thông trực tiếp.',
    systemPrompt: [
      'Bạn là Chuyên viên AI Kho lạnh & Sự cố IoT.',
      'Hãy gọi MCP tools (get_live_ngsi_telemetry, get_sensor_and_incident_timeline) kết hợp dxos_orchestrate_enterprise_case và dxos_search_enterprise_context để đối chiếu SOP P.A.R.A. trước khi lập chuỗi phiếu xử lý.',
      'Không tự phê duyệt đóng case hay sửa trường bị RBAC khóa; luôn dẫn rõ ID/URN nguồn.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'combo',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_tasks_copilot: 'ALLOW',
      dxos_orchestrate_enterprise_case: 'ASK',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['incidents', 'procurement'],
    quickPrompts: [
      { label: 'Đọc telemetry Orion-LD trực tiếp', prompt: 'Gọi get_live_ngsi_telemetry và get_sensor_and_incident_timeline kiểm tra tình trạng kho lạnh hiện tại.' },
      { label: 'Điều phối xử lý sự cố 360°', prompt: 'Dùng dxos_orchestrate_enterprise_case đối chiếu sự cố, SOP P.A.R.A. và đề xuất chuỗi phiếu bảo trì liên thông.' },
    ],
  },
  {
    username: 'dxos-logistics',
    nickname: 'Điều phối viên Chuỗi lạnh 5 Bước AI',
    position: 'Chuyên viên AI Vận tải & Điều phối',
    departmentScope: 'logistics-5step',
    organizationId: 'native-ui-lab',
    avatar: 'nocobase-003-female',
    bio: 'Hỗ trợ theo dõi đơn vận chuyển 5 bước liên phòng ban, radar điểm nghẽn, đối soát công việc thủ công và tạo nháp đơn hàng đúng chuẩn.',
    greeting: 'Chào bạn! Tôi hỗ trợ theo dõi đơn vận chuyển 5 chặng, radar điểm nghẽn và tóm tắt công việc giao nhận của bạn.',
    systemPrompt: [
      'Bạn là Điều phối viên Chuỗi lạnh AI của LatticeDX.',
      'Dùng dxos_search_enterprise_context đọc trạng thái latticeOrders, dxos_orchestrate_enterprise_case xem radar, và dxos_my_tasks_copilot kiểm tra manual task đang giao cho người dùng.',
      'Chỉ nộp bước manual task khi được người dùng xác nhận qua ASK.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'combo',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_tasks_copilot: 'ASK',
      dxos_orchestrate_enterprise_case: 'ALLOW',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['logistics'],
    quickPrompts: [
      { label: 'Việc giao nhận đang chờ tôi', prompt: 'Dùng dxos_my_tasks_copilot liệt kê và tóm tắt các công việc logistics đang chờ tôi xử lý.' },
      { label: 'Rà soát đơn chuỗi lạnh', prompt: 'Tìm các đơn vận chuyển chuỗi lạnh đang mở và đối chiếu lộ trình mới nhất.' },
    ],
  },
  {
    username: 'dxos-workspace',
    nickname: 'Trợ lý Nội bộ, Mua sắm & P.A.R.A. AI',
    position: 'Chuyên viên AI Dịch vụ & Tri thức',
    departmentScope: 'workspace-para',
    organizationId: 'native-ui-lab',
    avatar: 'nocobase-004-female',
    bio: 'Tra cứu tri thức P.A.R.A. có trích dẫn nguồn, tạo yêu cầu mua sắm / phiếu dịch vụ / phân hệ tùy chỉnh và điều phối liên phòng ban.',
    greeting: 'Xin chào! Tôi có thể tra cứu SOP P.A.R.A., soạn phiếu dịch vụ, lập biên bản phân hệ mới hoặc tóm tắt hộp việc giúp bạn.',
    systemPrompt: [
      'Bạn là Trợ lý Dịch vụ Nội bộ & Kho tri thức P.A.R.A.',
      'Mọi hướng dẫn đều phải trích dẫn nguồn [latticeParaDocuments:code#id].',
      'Khi tạo bản ghi mới qua dxos_execute_record_action hoặc dxos_orchestrate_enterprise_case, luôn tuân thủ RBAC và để người dùng xác nhận.',
    ].join('\n'),
    llmService: 'local-9router',
    modelName: 'combo',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_tasks_copilot: 'ALLOW',
      dxos_orchestrate_enterprise_case: 'ASK',
    },
    mcpServers: [],
    portalBindings: ['services', 'procurement'],
    quickPrompts: [
      { label: 'Tra cứu SOP trong Kho P.A.R.A.', prompt: 'Tìm tài liệu SOP/Projects trong Kho tri thức P.A.R.A. kèm trích dẫn nguồn.' },
      { label: 'Lập phiếu dịch vụ / mua sắm', prompt: 'Hỗ trợ soạn phiếu dịch vụ nội bộ hoặc yêu cầu mua sắm theo thông tin tôi cung cấp.' },
    ],
  },
];

const aiProfiles = {
  name: 'latticeAiProfiles',
  title: 'Cấu hình Nhân sự AI LatticeDX',
  titleField: 'nickname',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'username', type: 'string', interface: 'input', allowNull: false, unique: true },
    { name: 'nickname', type: 'string', interface: 'input', allowNull: false },
    { name: 'position', type: 'string', interface: 'input' },
    { name: 'departmentScope', type: 'string', interface: 'input', defaultValue: 'general' },
    { name: 'organizationId', type: 'string', interface: 'input', allowNull: false, defaultValue: 'native-ui-lab' },
    { name: 'avatar', type: 'string', interface: 'input', defaultValue: 'nocobase-015-male' },
    { name: 'bio', type: 'text', interface: 'textarea' },
    { name: 'greeting', type: 'text', interface: 'textarea' },
    { name: 'systemPrompt', type: 'text', interface: 'textarea' },
    { name: 'llmService', type: 'string', interface: 'input', defaultValue: 'local-9router' },
    { name: 'modelName', type: 'string', interface: 'input', defaultValue: 'combo' },
    { name: 'enabled', type: 'boolean', defaultValue: true, allowNull: false },
    { name: 'isAdminBuilder', type: 'boolean', defaultValue: false, allowNull: false },
    { name: 'allowSubAgentDispatch', type: 'boolean', defaultValue: false, allowNull: false },
    { name: 'allowedRoles', type: 'jsonb', defaultValue: ['ldx_employee', 'ldx_manager'] },
    { name: 'toolPermissions', type: 'jsonb', defaultValue: {} },
    { name: 'mcpServers', type: 'jsonb', defaultValue: [] },
    { name: 'portalBindings', type: 'jsonb', defaultValue: [] },
    { name: 'quickPrompts', type: 'jsonb', defaultValue: [] },
    { name: 'version', type: 'integer', defaultValue: 1, allowNull: false },
  ],
};

const aiAuditLogs = {
  name: 'latticeAiAuditLogs',
  title: 'Nhật ký Kiểm toán AI & MCP',
  titleField: 'toolName',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'actorUserId', type: 'bigInt' },
    { name: 'actorUsername', type: 'string' },
    { name: 'organizationId', type: 'string' },
    { name: 'channel', type: 'string', allowNull: false },
    { name: 'aiEmployee', type: 'string' },
    { name: 'toolName', type: 'string', allowNull: false },
    { name: 'argsSummary', type: 'jsonb', defaultValue: {} },
    { name: 'status', type: 'string', allowNull: false },
    { name: 'durationMs', type: 'integer', defaultValue: 0 },
    { name: 'errorCode', type: 'string' },
    { name: 'resultSummary', type: 'text' },
  ],
};

function failSchema(code, message, status = 400) {
  return Object.assign(new Error(message || code), { code, status });
}

function validateMcpServerUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw failSchema('MCP_URL_INVALID', 'Invalid MCP URL format');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw failSchema('MCP_URL_PROTOCOL_INVALID', 'Only http/https protocols are allowed for MCP URL');
  }
  if (parsed.username || parsed.password) {
    throw failSchema('MCP_URL_CREDENTIALS_FORBIDDEN', 'Credentials inside MCP URL are forbidden');
  }
  const host = parsed.hostname.toLowerCase();
  if (SSRF_BLOCKED_HOST_RE.test(host)) {
    throw failSchema('MCP_URL_SSRF_BLOCKED', 'Unsafe SSRF metadata or wildcard host blocked');
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_OR_INTERNAL_HOST_RE.test(host)) {
    throw failSchema('MCP_URL_HTTPS_REQUIRED', 'External HTTP MCP endpoints must use https://');
  }
  return parsed.toString();
}

function sanitizeAuditSummary(value, depth = 0) {
  if (depth > 4) return '[TRUNCATED]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditSummary(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : sanitizeAuditSummary(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function validateAiProfilePayload(input = {}, { adminToolNames = [] } = {}) {
  const username = String(input.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw failSchema('AI_USERNAME_INVALID', 'username phải gồm 2-63 ký tự [a-z0-9_-].');
  }
  const nickname = String(input.nickname || '').trim();
  if (!nickname) {
    throw failSchema('AI_NICKNAME_REQUIRED', 'Vui lòng nhập tên hiển thị của AI Employee.');
  }
  const organizationId = String(input.organizationId || 'native-ui-lab').trim();
  if (!ORG_RE.test(organizationId)) {
    throw failSchema('AI_ORG_INVALID', 'Mã tổ chức không hợp lệ.');
  }
  const toolPermissions = {};
  if (input.toolPermissions && typeof input.toolPermissions === 'object' && !Array.isArray(input.toolPermissions)) {
    for (const [toolName, mode] of Object.entries(input.toolPermissions)) {
      const m = String(mode || '').toUpperCase();
      if (!VALID_MODES.has(m)) throw failSchema('AI_TOOL_MODE_INVALID', `Chế độ tool "${m}" không hợp lệ.`);
      if (m !== 'OFF') toolPermissions[String(toolName).trim()] = m;
    }
  }
  const adminSet = new Set(adminToolNames);
  const grantsAdminTool = Object.keys(toolPermissions).some((t) => adminSet.has(t));
  const isAdminBuilder = Boolean(input.isAdminBuilder) || grantsAdminTool;
  const rawRoles = Array.isArray(input.allowedRoles) ? input.allowedRoles.map((r) => String(r).trim()).filter(Boolean) : [];
  const allowedRoles = isAdminBuilder
    ? ['root', 'admin']
    : rawRoles.length
      ? [...new Set(rawRoles)]
      : ['ldx_employee', 'ldx_manager'];

  const mcpServers = [];
  for (const srv of Array.isArray(input.mcpServers) ? input.mcpServers : []) {
    if (!srv || typeof srv !== 'object') continue;
    const name = String(srv.name || '').trim();
    if (!USERNAME_RE.test(name)) throw failSchema('MCP_NAME_INVALID', `Tên kết nối MCP "${name}" không hợp lệ.`);
    mcpServers.push({
      name,
      url: validateMcpServerUrl(srv.url),
      useUserContext: srv.useUserContext !== false,
      enabled: srv.enabled !== false,
    });
  }

  const portalBindings = [...new Set((Array.isArray(input.portalBindings) ? input.portalBindings : []).map((s) => String(s).trim()).filter(Boolean))];
  const quickPrompts = [];
  for (const qp of Array.isArray(input.quickPrompts) ? input.quickPrompts : []) {
    if (!qp || typeof qp !== 'object') continue;
    const label = String(qp.label || '').trim();
    const prompt = String(qp.prompt || '').trim();
    if (label && prompt) quickPrompts.push({ label: label.slice(0, 80), prompt: prompt.slice(0, 1000) });
  }

  return {
    username,
    nickname: nickname.slice(0, 120),
    position: String(input.position || 'Trợ lý AI Doanh nghiệp').trim().slice(0, 120),
    departmentScope: String(input.departmentScope || 'general').trim().slice(0, 80),
    organizationId,
    avatar: String(input.avatar || 'nocobase-015-male').trim().slice(0, 80),
    bio: String(input.bio || '').trim().slice(0, 1000),
    greeting: String(input.greeting || '').trim().slice(0, 1000),
    systemPrompt: String(input.systemPrompt || '').trim().slice(0, 8000),
    llmService: String(input.llmService || 'local-9router').trim().slice(0, 80),
    modelName: String(input.modelName || 'combo').trim().slice(0, 120),
    enabled: input.enabled !== false,
    isAdminBuilder,
    allowSubAgentDispatch: Boolean(input.allowSubAgentDispatch),
    allowedRoles,
    toolPermissions,
    mcpServers,
    portalBindings,
    quickPrompts,
    version: Math.max(1, Number(input.version) || 1),
  };
}

async function recordAiAuditLog(db, entry = {}) {
  const repo = db?.getRepository?.('latticeAiAuditLogs');
  if (!repo || typeof repo.create !== 'function') return null;
  try {
    return await repo.create({
      values: {
        actorUserId: entry.actorUserId ?? null,
        actorUsername: String(entry.actorUsername || '').slice(0, 100) || null,
        organizationId: String(entry.organizationId || '').slice(0, 80) || null,
        channel: String(entry.channel || 'ai-tool').slice(0, 40),
        aiEmployee: entry.aiEmployee ? String(entry.aiEmployee).slice(0, 80) : null,
        toolName: String(entry.toolName || 'unknown').slice(0, 120),
        argsSummary: sanitizeAuditSummary(entry.argsSummary || {}),
        status: String(entry.status || 'allowed').slice(0, 32),
        durationMs: Math.max(0, Number(entry.durationMs) || 0),
        errorCode: entry.errorCode ? String(entry.errorCode).slice(0, 80) : null,
        resultSummary: entry.resultSummary ? String(entry.resultSummary).slice(0, 1000) : null,
      },
    });
  } catch {
    return null;
  }
}

module.exports = {
  STARTER_AI_BLUEPRINTS,
  aiProfiles,
  aiAuditLogs,
  validateMcpServerUrl,
  sanitizeAuditSummary,
  validateAiProfilePayload,
  recordAiAuditLog,
};
