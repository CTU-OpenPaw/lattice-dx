# NocoBase plugins

Thư mục này chứa trọn bộ **7 plugin gốc chuẩn `Apache-2.0` (`0.4.1`)** do CTU-OpenPaw phát triển cho **LatticeDX** trên host runtime **NocoBase `2.2.50`**, khai báo `"nocobase": { "sdkProvidedByHost": true }`, giữ nguyên nhận diện **Điều 5.2 NocoBase** (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`), và kèm đầy đủ `LICENSE` + `README.md` riêng cho từng plugin:

- `@latticedx/plugin-action-bridge` (`action-bridge/`)
- `@latticedx/plugin-lattice-foundation` (`plugin-lattice-foundation/`)
- `@latticedx/plugin-enterprise-auth` (`plugin-enterprise-auth/`)
- `@latticedx/plugin-dxos-para` (`plugin-dxos-para/`)
- `@latticedx/plugin-dxos-blocks` (`plugin-dxos-blocks/`)
- `@latticedx/plugin-dxos-studio` (`plugin-dxos-studio/`, đóng gói tại bước build từ `devDependencies` các thư viện MIT `@xyflow/react@12.12.1`, `@dagrejs/dagre@3.1.3` qua `esbuild@0.28.2` cho LatticeFlow v2 DAG Studio trong khi vẫn giữ host NocoBase, `react`, `react-dom` và `antd` external)
- `@latticedx/plugin-dxos-ai` (`plugin-dxos-ai/`)

Kho mã nguồn Git của LatticeDX là **100% thuần chuẩn OSI**: không lưu hay phân phối mã nguồn upstream NocoBase, **hoàn toàn không chứa submodule `upstream/nocobase` hay tệp `.gitmodules`** (đã gỡ bỏ hoàn toàn khỏi cây Git; xem [ghi nhận nguồn và giấy phép](../../docs/nocobase-source-review.md)). Runtime host `nocobase/nocobase:2.2.50@sha256:04b75164936e7314ef74d82844bc56c9f34ed7ff1ca976ca53ffac2d3c88d777` chỉ được nạp độc lập lúc chạy dưới dạng OCI container bên ngoài (`infra/compose/nocobase.yml`, `native-rehearsal.yml`, `prod.yml`).

Chỉ thêm plugin sau khi kiểm chứng tương thích giấy phép OSI-approved và hợp đồng SDK host (`"sdkProvidedByHost": true`). Mỗi plugin là một package độc lập trong thư mục con với `LICENSE`, `README.md` và `package.json` riêng.
