/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */

const pageSpec = (groupTitle, groupIcon, title, icon, key, type, collection, fields) => ({
  groupTitle,
  groupIcon,
  title,
  icon,
  block: {
    key,
    type,
    title,
    collection,
    fields,
    ...(type === 'table'
      ? { settings: { pageSize: 10 }, actions: ['filter', 'refresh'] }
      : { actions: ['submit'] }),
  },
});

export const COLLECTION_FIELD_GROUPS = Object.freeze({
  latticeIncidentCases: [
    {
      title: 'Định danh & Tài sản',
      fields: ['code', 'name', 'organizationId', 'assetEntityId', 'runId', 'notificationId'],
    },
    {
      title: 'Phân công & Trạng thái',
      fields: ['handlerId', 'severity', 'status'],
    },
    {
      title: 'Đề xuất AI & Khắc phục',
      fields: ['proposal', 'resolutionNote', 'closeNote'],
    },
  ],
  latticeIncidentRules: [
    {
      title: 'Thông tin Luật & Tài sản',
      fields: ['code', 'name', 'organizationId', 'assetEntityId', 'handlerId'],
    },
    {
      title: 'Điều kiện Cảm biến',
      fields: ['attribute', 'operator', 'threshold', 'unit', 'severity'],
    },
    {
      title: 'Ngưỡng Thời gian & Quy trình',
      fields: ['maxObservationAgeSeconds', 'cooldownSeconds', 'workflowDefinitionId', 'workflowDefinitionVersion'],
    },
  ],
  latticeOrders: [
    {
      title: 'Thông tin Đơn vận chuyển',
      fields: ['code', 'name', 'organizationId', 'category', 'customer', 'quantity'],
    },
    {
      title: 'Tuyến vận chuyển & Mô tả',
      fields: ['origin', 'destination', 'description'],
    },
    {
      title: 'Trạng thái & Phê duyệt',
      fields: ['status', 'version', 'decisionReason'],
    },
  ],
  latticeServiceTickets: [
    {
      title: 'Thông tin Phiếu dịch vụ',
      fields: ['code', 'name', 'organizationId', 'serviceType', 'priority', 'description'],
    },
    {
      title: 'Trạng thái & Kết quả',
      fields: ['status', 'version', 'resolutionNote', 'decisionReason'],
    },
  ],
  latticeParaDocuments: [
    {
      title: 'Định danh & Phân vùng P.A.R.A.',
      fields: ['code', 'title', 'organizationId', 'paraSpace', 'tags', 'status'],
    },
    {
      title: 'Nội dung & Liên kết',
      fields: ['summary', 'contentMarkdown', 'attachmentUrl', 'relatedCollection', 'relatedRecordId'],
    },
  ],
});

export const PORTALS = Object.freeze([
  {
    slug: 'procurement',
    title: 'Mua sắm & Tài sản',
    icon: 'ShoppingOutlined',
    color: '#1677FF',
    description: 'Cổng yêu cầu mua sắm và quản lý sổ cái tài sản doanh nghiệp',
    isDefault: true,
    sort: 10,
    roles: ['ldx_employee', 'ldx_manager', 'ldx_director', 'ldx_admin'],
    pages: [
      pageSpec('Yêu cầu mua sắm', 'ShoppingCartOutlined', 'Tạo yêu cầu mới', 'FormOutlined', 'procurement-request-create', 'createForm', 'latticeRequests', ['code', 'name', 'category', 'description']),
      pageSpec('Yêu cầu mua sắm', 'ShoppingCartOutlined', 'Danh sách Yêu cầu', 'UnorderedListOutlined', 'procurement-request-list', 'table', 'latticeRequests', ['code', 'name', 'category', 'status', 'description']),
      pageSpec('Quản lý Tài sản', 'DatabaseOutlined', 'Sổ cái Tài sản', 'AppstoreOutlined', 'procurement-asset-ledger', 'table', 'latticeAssets', ['code', 'name', 'kind', 'status']),
    ],
  },
  {
    slug: 'incidents',
    title: 'Vận hành & Sự cố IoT',
    icon: 'AlertOutlined',
    color: '#FA8C16',
    description: 'Giám sát hàng đợi sự cố thiết bị và luật cảnh báo cảm biến NGSI-LD',
    isDefault: false,
    sort: 20,
    roles: ['ldx_manager', 'ldx_dispatcher', 'ldx_warehouse', 'ldx_director', 'ldx_admin'],
    pages: [
      pageSpec('Giám sát Sự cố', 'AlertOutlined', 'Hàng đợi Sự cố IoT', 'ExceptionOutlined', 'incidents-queue', 'table', 'latticeIncidentCases', ['code', 'name', 'assetEntityId', 'severity', 'status']),
      pageSpec('Giám sát Sự cố', 'AlertOutlined', 'Luật Cảm biến NGSI-LD', 'ControlOutlined', 'incidents-rules', 'table', 'latticeIncidentRules', ['code', 'name', 'assetEntityId', 'attribute', 'operator', 'threshold', 'unit', 'severity']),
    ],
  },
  {
    slug: 'logistics',
    title: 'Logistics Chuỗi lạnh',
    icon: 'CarOutlined',
    color: '#10B981',
    description: 'Điều phối đơn vận chuyển và quản lý hệ thống kho lạnh, điểm giao',
    isDefault: false,
    sort: 30,
    roles: ['ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_manager', 'ldx_admin'],
    pages: [
      pageSpec('Điều phối Vận chuyển', 'CarOutlined', 'Danh sách Đơn hàng', 'OrderedListOutlined', 'logistics-orders-list', 'table', 'latticeOrders', ['code', 'name', 'customer', 'origin', 'destination', 'quantity', 'status']),
      pageSpec('Điều phối Vận chuyển', 'CarOutlined', 'Tạo đơn vận chuyển', 'PlusCircleOutlined', 'logistics-order-create', 'createForm', 'latticeOrders', ['code', 'name', 'customer', 'origin', 'destination', 'quantity', 'description']),
      pageSpec('Kho lạnh & Điểm giao', 'EnvironmentOutlined', 'Địa điểm & Kho bãi', 'BankOutlined', 'logistics-locations', 'table', 'latticeLocations', ['code', 'name', 'kind', 'address']),
    ],
  },
  {
    slug: 'services',
    title: 'Dịch vụ Nội bộ & Danh bạ',
    icon: 'TeamOutlined',
    color: '#6366F1',
    description: 'Tra cứu danh bạ, phiếu dịch vụ nội bộ và kho tri thức P.A.R.A.',
    isDefault: false,
    sort: 40,
    roles: ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'],
    pages: [
      pageSpec('Tổ chức & Nhân sự', 'TeamOutlined', 'Danh bạ Nhân viên', 'UserOutlined', 'services-employees', 'table', 'latticeEmployees', ['code', 'name', 'email']),
      pageSpec('Tổ chức & Nhân sự', 'TeamOutlined', 'Cơ cấu Phòng ban', 'ApartmentOutlined', 'services-departments', 'table', 'latticeDepartments', ['code', 'name']),
      pageSpec('Dịch vụ Nội bộ', 'SolutionOutlined', 'Phiếu Dịch vụ Nội bộ', 'FileDoneOutlined', 'services-tickets', 'table', 'latticeServiceTickets', ['code', 'name', 'serviceType', 'priority', 'status']),
      pageSpec('Kho tri thức P.A.R.A.', 'FolderOpenOutlined', 'Tài liệu P.A.R.A.', 'BookOutlined', 'services-para-docs', 'table', 'latticeParaDocuments', ['code', 'title', 'paraSpace', 'tags', 'status']),
    ],
  },
]);
