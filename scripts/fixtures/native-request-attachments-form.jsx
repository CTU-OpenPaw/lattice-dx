/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { useState } = ctx.libs.React;
const { Alert, Button, Input, Space, Tag } = ctx.libs.antd;
const request = options => ctx.request({ skipNotify: true, ...options });
const listRequests = async () => (await request({
  url: 'latticeRequests:list', params: { pageSize: 25, sort: '-createdAt' },
})).data.data;
const actor = await request({ url: 'latticeNative:context' }).then(response => response.data.data).catch(() => null);
const initialRows = actor?.organizationId === attachmentOrganization ? await listRequests().catch(() => null) : null;

function encode(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function RequestForm({ actor, requests }) {
  const [rows, setRows] = useState(requests);
  const [selected, setSelected] = useState(null);
  const [files, setFiles] = useState([]);
  const [name, setName] = useState('');
  const [upload, setUpload] = useState(null);
  const [download, setDownload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const mayCreate = ctx.api.auth.role === 'ldx_employee';
  const mayEdit = selected?.status === 'draft' && String(selected.requesterId) === String(actor.employeeId);
  const statuses = { draft: 'Bản nháp', submitted: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối', assigned: 'Đã giao', completed: 'Hoàn thành' };

  async function action(work) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice({ type: 'error', message: error.response?.data?.errors?.[0]?.message ?? 'Thao tác chưa hoàn tất. Vui lòng thử lại.' });
    } finally {
      setBusy(false);
    }
  }

  async function loadFiles(requestId) {
    const response = await request({ url: 'latticeRequestAttachments:list', params: { requestId } });
    setFiles(response.data.data);
  }

  async function select(row) {
    setSelected(row);
    setFiles([]);
    setUpload(null);
    setDownload(null);
    await loadFiles(row.id);
  }

  async function submit(row) {
    const response = await request({ url: 'latticeRequestAttachments:submit', method: 'post', params: { requestId: row.id }, data: {} });
    const submitted = { ...row, status: response.data.data.status };
    setSelected(submitted);
    setRows(current => current.map(item => item.id === row.id ? submitted : item));
    setNotice({ type: 'success', message: 'Đã gửi yêu cầu để duyệt.' });
  }

  async function create(sendNow) {
    const response = await request({
      url: 'latticeRequests:create', method: 'post',
      data: { code: 'REQ-' + window.crypto.randomUUID(), name: name.trim() },
    });
    const row = response.data.data;
    setName('');
    setRows(current => [row, ...current]);
    await select(row);
    if (sendNow) await submit(row);
  }

  async function attach() {
    if (upload.file.size < 1 || upload.file.size > 1024 * 1024) {
      setNotice({ type: 'error', message: 'Chọn tệp có nội dung và dung lượng tối đa 1 MiB.' });
      return;
    }
    await request({
      url: 'latticeRequestAttachments:upload', method: 'post', timeout: 20000,
      params: { requestId: selected.id }, headers: { 'Idempotency-Key': upload.key },
      data: { filename: upload.file.name, contentBase64: encode(await upload.file.arrayBuffer()) },
    });
    setUpload(null);
    await loadFiles(selected.id);
    setNotice({ type: 'success', message: 'Đã đính kèm tệp sạch.' });
  }

  async function prepareDownload(file) {
    setDownload(null);
    const response = await request({
      url: 'latticeRequestAttachments:download', responseType: 'arraybuffer',
      params: { requestId: selected.id, fileId: file.fileId },
    });
    setDownload({ name: file.filename, href: 'data:application/octet-stream;base64,' + encode(response.data) });
  }

  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    {notice && <Alert showIcon type={notice.type} message={notice.message} />}
    {mayCreate && <section>
      <h3>Yêu cầu mới</h3>
      <Space wrap>
        <Input aria-label="Tên yêu cầu" placeholder="Tên yêu cầu" maxLength={200} value={name} onChange={event => setName(event.target.value)} />
        <Button disabled={busy || !name.trim()} onClick={() => action(() => create(false))}>Lưu nháp</Button>
        <Button type="primary" disabled={busy || !name.trim()} onClick={() => action(() => create(true))}>Tạo và gửi</Button>
      </Space>
    </section>}
    <section>
      <h3>Yêu cầu gần đây</h3>
      <Space wrap>
        <Button disabled={busy} onClick={() => action(async () => setRows(await listRequests()))}>Tải lại danh sách</Button>
        {rows.map(row => <Button key={row.id} disabled={busy} onClick={() => action(() => select(row))}>{row.name}</Button>)}
      </Space>
    </section>
    {selected && <section>
      <h3>{selected.name} <Tag>{statuses[selected.status] ?? selected.status}</Tag></h3>
      <h4>Tệp đính kèm</h4>
      {files.length ? <ul>{files.map(file => <li key={file.fileId}>
        <Button type="link" disabled={busy} onClick={() => action(() => prepareDownload(file))}>Tải {file.filename}</Button>
      </li>)}</ul> : <p>Chưa có tệp.</p>}
      {download && <p><a href={download.href} download={download.name} onClick={() => setDownload(null)}>Lưu {download.name}</a></p>}
      {mayEdit && <Space wrap>
        <input aria-label="Chọn tệp đính kèm" type="file" disabled={busy} onChange={event => {
          const file = event.target.files[0];
          setUpload(file ? { file, key: window.crypto.randomUUID() } : null);
        }} />
        <Button disabled={busy || !upload} onClick={() => action(attach)}>Đính kèm</Button>
        <Button type="primary" disabled={busy || Boolean(upload)} onClick={() => action(() => submit(selected))}>Gửi duyệt</Button>
      </Space>}
    </section>}
  </Space>;
}

ctx.render(initialRows
  ? <RequestForm actor={actor} requests={initialRows} />
  : <Alert type="warning" message="Trang thử chỉ dành cho tài khoản thuộc tổ chức đã cấu hình." />);
