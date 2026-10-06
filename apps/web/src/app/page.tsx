// SPDX-License-Identifier: Apache-2.0
'use client';
import { useState, type FormEvent } from 'react';
import { isDemoResult, type DemoResult } from '@dx/contracts';

export default function Home() {
  const [result, setResult] = useState<DemoResult>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = String(new FormData(event.currentTarget).get('message') ?? '');
    setPending(true); setError(''); setResult(undefined);
    try {
      const response = await fetch('/api/agent/demo', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }),
      });
      const data: unknown = await response.json();
      if (!response.ok || !isDemoResult(data)) {
        const detail = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'Không thể gửi yêu cầu.';
        throw new Error(detail);
      }
      setResult(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể kết nối hệ thống.'); }
    finally { setPending(false); }
  }
  return <main>
    <header><a className="brand" href="/">Lattice<span>DX</span></a><span className="tag">WORKSPACE · 0.1</span></header>
    <section className="intro"><p className="eyebrow">NỀN TẢNG CHUYỂN ĐỔI SỐ</p>
      <h1>Một không gian.<br /><span>Nhiều khả năng.</span></h1>
      <p>Kết nối ứng dụng, dữ liệu và agent trong một nền tảng chung.</p>
    </section>
    <section className="grid" aria-label="Các thành phần nền tảng">
      <article><span className="number">01</span><h2>Ứng dụng</h2><p>Nơi truy cập các ứng dụng nghiệp vụ.</p><span className="status">Chưa tích hợp</span></article>
      <article><span className="number">02</span><h2>Dữ liệu</h2><p>Kết nối dữ liệu ngữ cảnh theo chuẩn NGSI-LD.</p><span className="status">Chưa tích hợp</span></article>
      <article><span className="number">03</span><h2>Agent</h2><p>Điểm tiếp nhận tác vụ cho agent.</p><span className="status active">Có bản demo kết nối</span></article>
    </section>
    <section className="demo"><div><p className="eyebrow">THỬ KẾT NỐI</p><h2>Gửi một yêu cầu</h2>
      <p>Bản demo chỉ xác nhận đã nhận yêu cầu, chưa sử dụng mô hình AI.</p></div>
      <form onSubmit={submit}><label htmlFor="message">Nội dung yêu cầu</label>
        <textarea id="message" name="message" required maxLength={2000} rows={3} defaultValue="Kiểm tra kết nối giữa các thành phần" />
        <button disabled={pending} type="submit">{pending ? 'Đang gửi…' : 'Gửi yêu cầu →'}</button>
        <div aria-live="polite">{result && <p className="result">{result.summary}</p>}{error && <p className="error">{error}</p>}</div>
      </form>
    </section>
    <footer>CTU · PMNM 2026 <span>Nền tảng đang được xây dựng</span></footer>
  </main>;
}
