# Stock Radar Public Runner

Copyright © 2026. All rights reserved. This repository does not grant an open-source license.

這是 Stock Radar A-0 provider capability 的最小公開 runner bundle，只產生有界、去敏、可機器驗證的 capability evidence。它不讀寫私人 Stock Radar repository、不保存行情、不自動啟用 provider，也不執行交易或提供投資建議。

## 安全邊界

- Live workflow 僅允許 `workflow_dispatch`，不含 schedule、PR 或其他 privileged trigger。
- Fugle 與 TWSE capability 使用各自獨立的 manual workflow；TWSE 只驗證官方 raw 日行情，不宣稱提供個股 5 分 K。
- `FUGLE_API_KEY` 只能存在 `live-capability` GitHub Environment，且只注入需要 Fugle request 的最後一個第一方 Node step；TWSE fetch step 不取得 secret。
- Workflow token 只有 `contents: read`；不保存 artifact、不使用 cache、不執行 package install scripts。
- Fugle smoke 固定三個代碼、單一 session、7 個 logical operations；TWSE smoke 固定 `2330`／`0050`、1 次官方 request＋2 次 Fugle comparison。每項最多 2 attempts。
- Public log 的機器輸出只使用 closed canonical report line；完整 provider body、行情值、headers、credentials 與自由格式錯誤不得輸出。

## 本機離線驗證

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:unit
npm run test:fixture
npm run test:security
npm run test:redaction
npm run dry-run
```

以上驗證不會呼叫 provider。Live entrypoints 僅供另經授權、受保護的 GitHub Environment workflow 使用，不是一般本機操作指令。
