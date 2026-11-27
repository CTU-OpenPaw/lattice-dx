/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const TRACK_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRACK_TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;

function sanitizeTrackCode(raw) {
  let val = String(raw || '').trim();
  if (!val) return '';
  try {
    val = decodeURIComponent(val);
  } catch {
    return '';
  }
  if (!val || val.includes('..') || val.includes('/') || val.includes('\\')) return '';
  return TRACK_CODE_RE.test(val) ? val : '';
}

function sanitizeTrackToken(raw) {
  let val = String(raw || '').trim();
  if (!val) return '';
  try {
    val = decodeURIComponent(val);
  } catch {
    return '';
  }
  return TRACK_TOKEN_RE.test(val) ? val : '';
}

function parseQueryString(searchStr) {
  const out = new Map();
  const raw = String(searchStr || '').replace(/^\?/, '');
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const k = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
    const v = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
    try {
      const key = decodeURIComponent(k.replace(/\+/g, ' '));
      out.set(key, decodeURIComponent(v.replace(/\+/g, ' ')));
    } catch {
      // Ignore malformed query pair
    }
  }
  return out;
}

function parseTrackParams(locationLike) {
  const loc = locationLike || (typeof window !== 'undefined' ? window.location : null);
  if (!loc) return { trackingCode: '', token: '' };
  const pathname = String(loc.pathname || '');
  const match = pathname.match(/^\/(?:v\/)?track\/([^/?#]+)\/?$/i);
  const trackingCode = match ? sanitizeTrackCode(match[1]) : '';
  const query = parseQueryString(loc.search || '');
  const rawHash = String(loc.hash || '').replace(/^#/, '');
  const hashQueryIdx = rawHash.indexOf('?');
  const hashParams = parseQueryString(hashQueryIdx >= 0 ? rawHash.slice(hashQueryIdx + 1) : rawHash);
  const token = sanitizeTrackToken(query.get('token') || query.get('trackingToken') || '');
  const verify = sanitizeTrackToken(query.get('verify') || hashParams.get('verify') || '');
  return { trackingCode, token, ...(verify ? { verify } : {}) };
}

function resolveLegacyTrackRedirect(winLike) {
  if (!winLike || winLike.__nocobase_app_client_entry_mode__ !== 'legacy-default') return null;
  const loc = winLike.location;
  if (!loc) return null;
  const pathname = String(loc.pathname || '');
  if (!pathname || pathname === '/mobile' || pathname.startsWith('/mobile/') || pathname.startsWith('/v/')) {
    return null;
  }
  if (pathname === '/track' || pathname.startsWith('/track/')) {
    return `/v${pathname}${loc.search || ''}${loc.hash || ''}`;
  }
  return null;
}

function projectZeroPiiPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const temp = raw.tempSummary && typeof raw.tempSummary === 'object'
    ? {
      ...(raw.tempSummary.mktCelsius !== undefined ? { mktCelsius: raw.tempSummary.mktCelsius } : {}),
      ...(raw.tempSummary.inRange !== undefined ? { inRange: Boolean(raw.tempSummary.inRange) } : {}),
      ...(raw.tempSummary.evidencePhotoCount !== undefined ? { evidencePhotoCount: Number(raw.tempSummary.evidencePhotoCount) || 0 } : {}),
    }
    : null;
  const ledger = raw.ledgerVerification && typeof raw.ledgerVerification === 'object'
    ? {
      seq: raw.ledgerVerification.seq ?? null,
      keyId: String(raw.ledgerVerification.keyId || ''),
      verifiedFormat: Boolean(raw.ledgerVerification.verifiedFormat),
    }
    : null;
  return {
    trackingCode: String(raw.trackingCode || ''),
    status: String(raw.status || ''),
    deliveredAt: raw.deliveredAt ? String(raw.deliveredAt) : '',
    orderCode: raw.orderCode ? String(raw.orderCode) : '',
    tempSummary: temp,
    ledgerVerification: ledger,
  };
}

function extractApiError(err, fallbackMsg) {
  const serverMsg = err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message;
  const status = err?.response?.status || err?.status;
  if (serverMsg) return { message: String(serverMsg), status };
  if (err?.message) return { message: String(err.message), status };
  return { message: fallbackMsg, status };
}

function createPublicTrackPage(client, React, app) {
  return function PublicTrackPage(props = {}) {
    const h = React.createElement;
    const useAPIClient = client?.useAPIClient;
    let hookApiClient = null;
    if (typeof useAPIClient === 'function') {
      try {
        hookApiClient = useAPIClient();
      } catch {
        hookApiClient = null;
      }
    }
    const apiClient = props?.apiClient || hookApiClient || app?.apiClient || null;

    const initialParams = parseTrackParams(props?.location);
    const propCode = props?.trackingCode ? sanitizeTrackCode(props.trackingCode) : '';
    const propToken = props?.token ? sanitizeTrackToken(props.token) : '';
    const propVerify = props?.verify ? sanitizeTrackToken(props.verify) : '';
    const effectiveCode = propCode || initialParams.trackingCode;
    const effectiveToken = propToken || initialParams.token;
    const effectiveVerify = propVerify || initialParams.verify || '';

    const [codeInput, setCodeInput] = React.useState(effectiveCode);
    const [tokenInput, setTokenInput] = React.useState(effectiveToken);
    const [activeCode, setActiveCode] = React.useState(effectiveCode);
    const [activeToken, setActiveToken] = React.useState(effectiveToken);
    const [showToken, setShowToken] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState('');
    const [trackData, setTrackData] = React.useState(null);
    const [proofData, setProofData] = React.useState(null);
    const [verifying, setVerifying] = React.useState(false);
    const [verifyResult, setVerifyResult] = React.useState(null);
    const [verifyError, setVerifyError] = React.useState('');

    async function callEndpoint(actionUrl, opts = {}) {
      if (apiClient && typeof apiClient.request === 'function') {
        const res = await apiClient.request({
          url: actionUrl,
          method: opts.method || 'GET',
          ...(opts.params ? { params: opts.params } : {}),
          ...(opts.data ? { data: opts.data } : {}),
        });
        return res?.data?.data ?? res?.data ?? res;
      }
      if (typeof fetch !== 'function') {
        throw new Error('Không tìm thấy API client khả dụng.');
      }
      const query = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : '';
      const resp = await fetch(`/api/${actionUrl}${query}`, {
        method: opts.method || 'GET',
        headers: opts.data ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.data ? JSON.stringify(opts.data) : undefined,
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = new Error(json?.errors?.[0]?.message || json?.message || `HTTP ${resp.status}`);
        err.response = { status: resp.status, data: json };
        throw err;
      }
      return json?.data ?? json;
    }

    React.useEffect(() => {
      let active = true;
      if (activeCode && activeToken) {
        setLoading(true);
        setErrorMsg('');
        setProofData(null);
        setVerifyResult(null);
        setVerifyError('');
        callEndpoint('dxosWms:publicTrack', {
          method: 'GET',
          params: { trackingCode: activeCode, token: activeToken },
        })
          .then((payload) => {
            if (!active) return;
            setTrackData(projectZeroPiiPayload(payload));
            setLoading(false);
          })
          .catch((err) => {
            if (!active) return;
            const info = extractApiError(err, 'Không thể tải trạng thái vận đơn công khai.');
            setTrackData(null);
            setErrorMsg(info.message);
            setLoading(false);
          });
        return () => { active = false; };
      }
      if (activeCode && effectiveVerify) {
        setLoading(true);
        setErrorMsg('');
        setTrackData(null);
        callEndpoint('dxosWms:verifyTrackSignature', {
          method: 'POST',
          data: { code: activeCode, trackingCode: activeCode, verify: effectiveVerify },
        })
          .then((res) => {
            if (!active) return;
            setProofData(res || null);
            setLoading(false);
          })
          .catch((err) => {
            if (!active) return;
            const info = extractApiError(err, 'Không thể xác thực mã QR công khai.');
            setProofData(null);
            setErrorMsg(info.message);
            setLoading(false);
          });
        return () => { active = false; };
      }
      setTrackData(null);
      setProofData(null);
      setLoading(false);
      return () => { active = false; };
    }, [activeCode, activeToken, effectiveVerify]);

    function handleLookupSubmit(evt) {
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      const nextCode = sanitizeTrackCode(codeInput);
      const nextToken = sanitizeTrackToken(tokenInput);
      if (!nextCode || !nextToken) {
        setErrorMsg('Vui lòng nhập đầy đủ mã vận đơn và mã xác thực (Tracking Token).');
        return;
      }
      setErrorMsg('');
      setActiveCode(nextCode);
      setActiveToken(nextToken);
    }

    async function handleVerifySignature() {
      if (!trackData?.trackingCode || !activeToken) {
        setVerifyError('Thiếu mã vận đơn hoặc mã xác thực để kiểm định chữ ký.');
        return;
      }
      if (!trackData?.ledgerVerification?.keyId) {
        setVerifyError('Chứng từ chưa có thông tin khóa Ed25519 để kiểm định.');
        return;
      }
      setVerifying(true);
      setVerifyError('');
      setVerifyResult(null);
      try {
        const res = await callEndpoint('dxosWms:verifyTrackSignature', {
          method: 'POST',
          data: {
            code: trackData.trackingCode,
            token: activeToken,
          },
        });
        const verified = Boolean(res?.verified);
        setVerifyResult({
          verified,
          ledgerSeq: res?.ledgerSeq ?? res?.seq ?? trackData.ledgerVerification.seq ?? null,
          entryHash: String(res?.entryHash || ''),
          keyId: String(res?.keyId || trackData.ledgerVerification.keyId || ''),
          publicKeyFingerprint: String(res?.publicKeyFingerprint || ''),
          reason: res?.reason ? String(res.reason) : '',
        });
      } catch (err) {
        const info = extractApiError(err, 'Không thể kiểm định chữ ký Ed25519.');
        setVerifyError(info.message);
      } finally {
        setVerifying(false);
      }
    }

    const ledger = trackData?.ledgerVerification;
    const temp = trackData?.tempSummary;

    return h(
      'div',
      {
        'data-testid': 'public-track-page',
        style: {
          maxWidth: 720,
          margin: '32px auto',
          padding: 24,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#f8fafc',
          borderRadius: 12,
          border: '1px solid #e2e8f0',
          color: '#0f172a',
        },
      },
      h(
        'header',
        { style: { marginBottom: 20, borderBottom: '1px solid #cbd5e1', paddingBottom: 12 } },
        h('div', { style: { fontSize: 12, fontWeight: 700, color: '#0284c7', textTransform: 'uppercase' } }, 'LatticeDX Cold-Chain Trust · Zero-PII'),
        h('h1', { style: { margin: '4px 0 0', fontSize: 22, fontWeight: 700 } }, 'Tra cứu Vận đơn & Xác thực Chuỗi ký số Ed25519'),
      ),
      h(
        'form',
        {
          'data-testid': 'public-track-lookup-form',
          noValidate: true,
          onSubmit: handleLookupSubmit,
          style: { background: '#ffffff', padding: 16, borderRadius: 10, border: '1px solid #cbd5e1', marginBottom: 16 },
        },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 12 } },
          h('div', null,
            h('label', { style: { display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6 } }, 'Mã vận đơn (Tracking Code) *'),
            h('input', {
              type: 'text',
              name: 'trackingCode',
              'data-testid': 'public-track-code-input',
              value: codeInput,
              onChange: (e) => { setCodeInput(e?.target?.value ?? ''); if (errorMsg) setErrorMsg(''); },
              placeholder: 'VD: LDX-TRK-001',
              style: { width: '100%', minHeight: 44, padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 14, boxSizing: 'border-box' },
            }),
          ),
          h('div', null,
            h('label', { style: { display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6 } }, 'Mã xác thực (Tracking Token) *'),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', {
                type: showToken ? 'text' : 'password',
                name: 'token',
                'data-testid': 'public-track-token-input',
                value: tokenInput,
                onChange: (e) => { setTokenInput(e?.target?.value ?? ''); if (errorMsg) setErrorMsg(''); },
                placeholder: 'Nhập Tracking Token (?token=...)',
                style: { flex: 1, minWidth: 0, minHeight: 44, padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 14, boxSizing: 'border-box' },
              }),
              h('button', {
                type: 'button',
                'data-testid': 'public-track-token-toggle',
                'aria-label': 'Hiện/ẩn mã xác thực',
                'aria-pressed': String(showToken),
                onClick: () => setShowToken((v) => !v),
                style: { minHeight: 44, minWidth: 44, flexShrink: 0, padding: '8px 12px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#ffffff', color: '#334155', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
              }, showToken ? 'Ẩn' : 'Hiện'),
            ),
          ),
        ),
        h('button', {
          type: 'submit',
          'data-testid': 'public-track-lookup-btn',
          disabled: loading,
          style: { minHeight: 44, minWidth: 44, padding: '9px 16px', borderRadius: 6, border: '1px solid #0284c7', background: '#0284c7', color: '#ffffff', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer' },
        }, loading ? 'Đang tra cứu...' : 'Tra cứu vận đơn'),
      ),
      loading
        ? h('div', { 'data-testid': 'public-track-loading', role: 'status', style: { padding: 16, background: '#e0f2fe', borderRadius: 8 } }, 'Đang tải thông tin vận đơn...')
        : null,
      errorMsg
        ? h('div', { 'data-testid': 'public-track-error', role: 'alert', style: { padding: 16, background: '#fee2e2', color: '#991b1b', borderRadius: 8, marginBottom: 16 } }, errorMsg)
        : null,
      proofData && !trackData
        ? h('section', {
          'data-testid': 'public-track-proof-card',
          style: { background: '#ffffff', padding: 20, borderRadius: 10, border: '1px solid #cbd5e1', marginBottom: 16 },
        },
        h('div', { style: { fontWeight: 700, fontSize: 15, marginBottom: 8 } },
          proofData.verified ? 'Chứng thực Sổ cái công khai Ed25519 hợp lệ' : 'Không xác thực được chứng thực công khai'),
        h('div', { style: { fontSize: 14, marginBottom: 4 } }, `Mã vận đơn: ${proofData.trackingCode || activeCode}`),
        proofData.keyId ? h('div', { style: { fontSize: 13, color: '#475569', marginBottom: 4 } }, `Khóa ký số: ${proofData.keyId}`) : null,
        (proofData.ledgerEntryHash || proofData.entryHash)
          ? h('div', { style: { fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 4 } }, `Ledger Hash: ${proofData.ledgerEntryHash || proofData.entryHash}`)
          : null,
        (proofData.signedAt || proofData.verifiedAt)
          ? h('div', { style: { fontSize: 13, color: '#475569', marginBottom: 8 } }, `Thời điểm ký: ${proofData.signedAt || proofData.verifiedAt}`)
          : null,
        h('div', { style: { padding: 10, borderRadius: 8, background: '#e0f2fe', color: '#075985', fontSize: 13 } },
          'Chế độ xác thực công khai (Zero-PII). Vui lòng nhập Mã xác thực (Tracking Token) ở trên để xem chi tiết ePOD và nhật ký giao nhận.'),
        )
        : null,
      trackData
        ? h(
          'section',
          {
            'data-testid': 'public-track-status-card',
            style: { background: '#ffffff', padding: 20, borderRadius: 10, border: '1px solid #cbd5e1' },
          },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 } },
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Mã theo dõi (Tracking Code)'), h('strong', null, trackData.trackingCode)),
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Mã đơn hàng (Order)'), h('strong', null, trackData.orderCode || '—')),
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Trạng thái giao nhận'), h('strong', null, trackData.status || '—')),
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Thời điểm giao'), h('strong', null, trackData.deliveredAt || '—')),
          ),
          temp
            ? h('div', { style: { padding: 12, borderRadius: 8, background: temp.inRange === false ? '#fef2f2' : '#f0fdf4', marginBottom: 16 } },
              h('span', { style: { fontWeight: 600 } }, 'Chuỗi lạnh (MKT): '),
              temp.mktCelsius !== undefined ? `${temp.mktCelsius} °C` : 'Chưa ghi nhận',
              ' · ',
              temp.inRange === false ? 'Cảnh báo vượt ngưỡng' : 'Đạt chuẩn 2–8 °C',
            )
            : null,
          ledger
            ? h('div', { style: { padding: 12, borderRadius: 8, background: '#f1f5f9', marginBottom: 16 } },
              h('div', null, `Sổ cái bất biến #${ledger.seq ?? '—'} · Khóa: ${ledger.keyId || '—'}`),
              h('div', { style: { fontSize: 13, color: '#475569', marginTop: 4 } },
                ledger.verifiedFormat ? 'Định dạng chữ ký Ed25519 hợp lệ' : 'Chưa có chữ ký Ed25519',
              ),
            )
            : null,
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                'data-testid': 'public-track-verify-btn',
                disabled: verifying,
                onClick: handleVerifySignature,
                style: {
                  minHeight: 44,
                  minWidth: 44,
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: '1px solid #0284c7',
                  background: '#0284c7',
                  color: '#ffffff',
                  fontWeight: 600,
                  cursor: verifying ? 'not-allowed' : 'pointer',
                },
              },
              verifying ? 'Đang kiểm định chữ ký...' : 'Xác thực chữ ký Ed25519 trực tuyến',
            ),
          ),
          verifyResult
            ? h('div', {
              'data-testid': 'public-track-verify-result',
              style: {
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
                background: verifyResult.verified ? '#dcfce7' : '#fee2e2',
                color: verifyResult.verified ? '#166534' : '#991b1b',
              },
            },
            h('div', { style: { fontWeight: 600 } },
              `${verifyResult.verified ? 'Chữ ký Ed25519 hợp lệ' : 'Chữ ký Ed25519 không hợp lệ'}${verifyResult.ledgerSeq != null ? ` · Seq #${verifyResult.ledgerSeq}` : ''} · Key: ${verifyResult.keyId || '—'}`,
            ),
            verifyResult.publicKeyFingerprint
              ? h('div', { style: { fontSize: 12, marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' } }, `Fingerprint: ${verifyResult.publicKeyFingerprint}`)
              : null,
            verifyResult.entryHash
              ? h('div', { style: { fontSize: 12, marginTop: 2, fontFamily: 'monospace', wordBreak: 'break-all' } }, `Entry Hash: ${verifyResult.entryHash}`)
              : null,
            verifyResult.reason
              ? h('div', { style: { fontSize: 12, marginTop: 4 } }, `Lý do: ${verifyResult.reason}`)
              : null,
            )
            : null,
          verifyError
            ? h('div', {
              'data-testid': 'public-track-verify-error',
              style: { marginTop: 12, padding: 12, borderRadius: 8, background: '#fef3c7', color: '#92400e' },
            }, verifyError)
            : null,
        )
        : null,
    );
  };
}

module.exports = {
  parseTrackParams,
  resolveLegacyTrackRedirect,
  createPublicTrackPage,
};
