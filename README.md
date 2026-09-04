# Stock Radar Public Runner

Copyright © 2026. All rights reserved. This repository does not grant an open-source license.

這是 Stock Radar A-0 provider capability 的最小公開 runner bundle，只產生有界、去敏、可機器驗證的 capability evidence。它不讀寫私人 Stock Radar repository、不保存行情、不自動啟用 provider，也不執行交易或提供投資建議。

## 安全邊界

- Live workflow 僅允許 `workflow_dispatch`，不含 schedule、PR 或其他 privileged trigger。
- `FUGLE_API_KEY` 只能存在 `live-capability` GitHub Environment，且只注入最後一個第一方 Node step。
- Workflow token 只有 `contents: read`；不保存 artifact、不使用 cache、不執行 package install scripts。
- 初次 live smoke 固定三個代碼、單一 session、7 個 logical operations、每項最多 2 attempts。
- Public log 的機器輸出只有一行 `STOCK_RADAR_CAPABILITY_REPORT=<canonical-json>`；完整 provider body、headers、credentials 與自由格式錯誤不得輸出。

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

以上驗證不會呼叫 provider。`npm run live` 僅供另經授權、受保護的 GitHub Environment workflow 使用，不是一般本機操作指令。
