# 多來源交易決策系統

純前端 React + TypeScript + Vite 儀表板，可由 GitHub Actions 自動建置並部署到 GitHub Pages。

## 資料來源

- Massive：歷史 OHLCV 主來源
- Twelve Data：歷史 OHLCV fallback
- Finnhub：Quote、Company Profile、Earnings；若帳戶允許亦可作 K 線 fallback
- FMP：Market Cap / Sector / Earnings fallback
- FRED：10Y、2Y、CPI 官方總經資料
- SEC EDGAR：Company Facts 官方基本面（瀏覽器直接存取失敗時自動略過）

API Key 不寫在 repository。使用者在網頁的「API 設定」輸入，僅保存於該瀏覽器 localStorage。

## GitHub Pages

1. 建立一個 public repository，例如 `stock-decision-dashboard`。
2. 把本專案所有檔案放到 `main` branch。
3. 到 `Settings → Pages`。
4. `Build and deployment → Source` 選 `GitHub Actions`。
5. 推送到 main 後，`.github/workflows/deploy.yml` 會自動執行 build 與 deploy。
6. 專案型 Pages 網址通常為 `https://<username>.github.io/<repository>/`。

Vite `base` 已設定為 `./`，因此 repository 名稱不需要寫死。

## 重要安全說明

GitHub Pages 是靜態前端。任何寫入原始碼、`.env`、Vite `VITE_*` 或 build-time secret 的 API Key，只要最後進入瀏覽器 bundle，就不能視為真正的秘密。本專案因此採使用者端輸入 API Key 的方式。
