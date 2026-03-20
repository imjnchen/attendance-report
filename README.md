# 出勤狀況報表

純前端出勤資料分析工具，上傳 CSV 即可查看每位員工的月度出勤統計。

## 支援格式

- **格式 A**：鼎永刷卡資料一覽表（Excel 另存 CSV）
- **格式 B**：含標頭列的出勤 CSV（欄位：員工代號/員工姓名/出勤日期/所有刷卡時間/班表區分）

自動偵測編碼（UTF-8 / Big5）。

## 本地開發

```bash
npm install
npm run dev
```

## 部署（GitHub Pages）

1. 推送到 `main` 分支
2. GitHub repo → Settings → Pages → Source 選 **GitHub Actions**
3. 自動部署完成

## 技術

Vite + React，無後端，所有資料在瀏覽器端解析。
