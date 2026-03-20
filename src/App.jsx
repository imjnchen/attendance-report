import { useState, useCallback, useMemo } from "react";

/* ── Format Detection & Parsing ── */

const HEADER_KEYWORDS = ["鼎永工業股份有限公司", "刷卡資料一覽表", "出勤日期：", "員工區間：", "員工代號"];
const PAGE_BREAK = "NO.0080-A4-2";

function parseTimeString(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw.trim().split(/\s+/).filter(t => /^\d{2}:\d{2}$/.test(t));
}

function normalizeDate(d) {
  if (!d) return null;
  const m = d.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
}

function extractMonth(dateStr) {
  const d = normalizeDate(dateStr);
  return d ? d.substring(0, 7) : null;
}

/* Format B: columnar CSV with header row (員工代號 in col 15) */
function parseFormatB(text) {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map(h => h.trim());
  const empIdIdx = header.indexOf("員工代號");
  const empNameIdx = header.indexOf("員工姓名");
  const dateIdx = header.indexOf("出勤日期");
  const timeIdx = header.indexOf("所有刷卡時間");
  const statusIdx = header.indexOf("班表區分");
  if (empIdIdx < 0 || dateIdx < 0 || statusIdx < 0) return null;

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const empId = (cols[empIdIdx] || "").trim();
    const empName = (cols[empNameIdx] || "").trim();
    const rawDate = (cols[dateIdx] || "").trim();
    const status = (cols[statusIdx] || "").trim();
    const rawTime = (cols[timeIdx] || "").trim();
    if (!empId || !rawDate || !status) continue;
    const date = normalizeDate(rawDate);
    const month = extractMonth(rawDate);
    if (!date || !month) continue;
    records.push({ empId, empName, date, status, times: parseTimeString(rawTime), month });
  }
  return records.length > 0 ? records : null;
}

/* Format A: old report format (鼎永刷卡資料一覽表) */
function parseFormatA(text) {
  const splitLine = (l) => l.includes("\t") ? l.split("\t") : l.split(",");
  const lines = text.split("\n").filter(l => l.trim()).map(splitLine);
  const records = [];
  let currentId = null, currentName = null, monthLabel = "";

  for (const cols of lines) {
    const c = Array.from({ length: 6 }, (_, i) => (cols[i] || "").trim());
    if (c[0] === "出勤日期：" && c[1]) {
      const m = c[1].match(/(\d{4})\/(\d{2})/);
      if (m) monthLabel = `${m[1]}/${m[2]}`;
    }
    if (HEADER_KEYWORDS.includes(c[0]) || c[0] === PAGE_BREAK) continue;
    if (c[0] && c[1] && !HEADER_KEYWORDS.includes(c[0]) && c[0] !== PAGE_BREAK) {
      currentId = c[0]; currentName = c[1];
    }
    if (!currentId) continue;

    let date = null, status = null, times = [];
    if (c[2] === "*") { date = normalizeDate(c[3]); status = c[4] || "未刷卡"; }
    else if (/^\d{4}\/\d{2}\/\d{2}$/.test(c[2])) {
      date = c[2]; status = c[3]; times = parseTimeString(cols.slice(5).join(" "));
    }
    if (date && status) {
      const month = monthLabel || extractMonth(date) || "";
      records.push({ empId: currentId, empName: currentName, date, status, times, month });
    }
  }
  return records.length > 0 ? records : null;
}

function parseAuto(rawText) {
  const text = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Try format B first (has header with 員工代號)
  const b = parseFormatB(text);
  if (b) return b;
  // Fallback to format A
  return parseFormatA(text) || [];
}

/* ── Statistics ── */

function processRecords(records) {
  const byEmp = {};
  for (const r of records) {
    if (!byEmp[r.empId]) byEmp[r.empId] = { empId: r.empId, empName: r.empName, months: {} };
    if (!byEmp[r.empId].months[r.month]) byEmp[r.empId].months[r.month] = { days: [], stats: {} };
    byEmp[r.empId].months[r.month].days.push(r);
  }
  for (const emp of Object.values(byEmp)) {
    for (const data of Object.values(emp.months)) {
      const s = { 排班: 0, 排休: 0, 未刷卡: 0, total: data.days.length };
      let late = 0, early = 0, totalMin = 0, workDays = 0;
      for (const d of data.days) {
        if (d.status === "排班") s.排班++;
        else if (d.status === "排休") s.排休++;
        if (d.status === "未刷卡") s.未刷卡++;
        if (d.times.length >= 2 && d.status === "排班") {
          const [fh, fm] = d.times[0].split(":").map(Number);
          const [lh, lm] = d.times[d.times.length - 1].split(":").map(Number);
          if (fh > 8 || (fh === 8 && fm > 0)) late++;
          if (lh < 17) early++;
          const dur = (lh * 60 + lm) - (fh * 60 + fm);
          if (dur > 0) { totalMin += dur; workDays++; }
        }
      }
      s.lateCount = late; s.earlyCount = early;
      s.avgWorkHours = workDays > 0 ? (totalMin / workDays / 60).toFixed(1) : "-";
      s.workDays = workDays;
      data.stats = s;
    }
  }
  return byEmp;
}

/* ── UI Components ── */

function StatusBadge({ status }) {
  const m = {
    排班: { bg: "#e8f5e9", color: "#2e7d32", border: "#a5d6a7" },
    排休: { bg: "#e3f2fd", color: "#1565c0", border: "#90caf9" },
    未刷卡: { bg: "#fce4ec", color: "#c62828", border: "#ef9a9a" },
  };
  const c = m[status] || { bg: "#f5f5f5", color: "#616161", border: "#bdbdbd" };
  return <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 4, fontSize: 12, background: c.bg, color: c.color, border: `1px solid ${c.border}`, fontWeight: 600 }}>{status}</span>;
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: "var(--card-bg)", borderRadius: 10, padding: "14px 18px", border: "1px solid var(--border)", minWidth: 100, flex: "1 1 0" }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent || "var(--text)", fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const DOW = ["日", "一", "二", "三", "四", "五", "六"];

/* ── Main App ── */

export default function AttendanceReport() {
  const [data, setData] = useState(null);
  const [selectedEmp, setSelectedEmp] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fileNames, setFileNames] = useState([]);
  const [error, setError] = useState(null);
  const [parsedCount, setParsedCount] = useState(0);

  const handleFiles = useCallback(async (e) => {
    const fileList = Array.from(e.target.files);
    if (!fileList.length) return;
    setLoading(true); setError(null);

    try {
      const allRecords = [], names = [];
      for (const file of fileList) {
        names.push(file.name);
        const ab = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(ab); }
        catch { text = new TextDecoder("big5").decode(ab); }
        allRecords.push(...parseAuto(text));
      }

      if (allRecords.length === 0) {
        setError("解析到 0 筆記錄。支援兩種格式：\n① 鼎永刷卡資料一覽表（從 Excel 另存 CSV）\n② 含標頭列的出勤 CSV（員工代號/出勤日期/班表區分）");
        setLoading(false); return;
      }

      const processed = processRecords(allRecords);
      setData(processed); setFileNames(names); setParsedCount(allRecords.length);
      const firstEmp = Object.keys(processed)[0];
      setSelectedEmp(firstEmp);
      setSelectedMonth(Object.keys(processed[firstEmp].months).sort()[0]);
    } catch (err) { setError("解析錯誤：" + err.message); }
    setLoading(false);
  }, []);

  const empList = useMemo(() => data ? Object.values(data).map(e => ({ id: e.empId, name: e.empName })) : [], [data]);
  const months = useMemo(() => {
    if (!data?.[selectedEmp]) return [];
    return Object.keys(data[selectedEmp].months).sort();
  }, [data, selectedEmp]);
  const cur = useMemo(() => data?.[selectedEmp]?.months[selectedMonth] || null, [data, selectedEmp, selectedMonth]);

  return (
    <div style={{
      minHeight: "100vh", fontFamily: "'Noto Sans TC', sans-serif", background: "var(--bg)", color: "var(--text)",
      "--bg": "#f7f8fa", "--card-bg": "#fff", "--text": "#1a1a2e", "--text-muted": "#6b7280",
      "--border": "#e5e7eb", "--accent": "#2563eb", "--accent-light": "#dbeafe",
      "--green": "#16a34a", "--red": "#dc2626", "--orange": "#ea580c",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=JetBrains+Mono:wght@400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
        .emp-item { padding: 8px 12px; cursor: pointer; border-radius: 6px; transition: all .15s; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
        .emp-item:hover { background: var(--accent-light); }
        .emp-item.active { background: var(--accent); color: #fff; font-weight: 600; }
        .mtab { padding: 6px 16px; border-radius: 20px; cursor: pointer; font-size: 13px; font-weight: 500; border: 1px solid var(--border); background: var(--card-bg); transition: all .15s; user-select: none; }
        .mtab:hover { border-color: var(--accent); } .mtab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
        .drow { display: grid; grid-template-columns: 100px 64px 1fr; gap: 8px; padding: 8px 12px; border-radius: 6px; align-items: center; font-size: 13px; }
        .drow:nth-child(even) { background: rgba(0,0,0,0.02); }
        .upzone { border: 2px dashed var(--border); border-radius: 12px; padding: 40px; text-align: center; cursor: pointer; transition: all .2s; }
        .upzone:hover { border-color: var(--accent); background: var(--accent-light); }
      `}</style>

      {!data ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 24 }}>
          <div style={{ maxWidth: 480, width: "100%" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>📋</div>
              <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>出勤狀況報表</h1>
              <p style={{ fontSize: 14, color: "var(--text-muted)" }}>上傳鼎永刷卡資料，自動產出每月出勤統計</p>
            </div>
            <label className="upzone" style={{ display: "block" }}>
              <input type="file" accept=".csv,.tsv,.txt" multiple onChange={handleFiles} style={{ display: "none" }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{loading ? "解析中..." : "點擊上傳檔案"}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                支援兩種格式（可多選）：<br/>
                ① 刷卡資料一覽表 CSV<br/>
                ② 含標頭列的出勤 CSV
              </div>
            </label>
            {error && <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: "#fef2f2", color: "#dc2626", fontSize: 13, whiteSpace: "pre-wrap" }}>{error}</div>}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", height: "100vh" }}>
          <div style={{ width: 220, borderRight: "1px solid var(--border)", background: "var(--card-bg)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
            <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>👥 員工列表</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{empList.length} 人 · {parsedCount} 筆</div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
              {empList.map(e => (
                <div key={e.id} className={`emp-item ${selectedEmp === e.id ? "active" : ""}`}
                  onClick={() => { setSelectedEmp(e.id); const ms = Object.keys(data[e.id].months).sort(); if (!ms.includes(selectedMonth)) setSelectedMonth(ms[0]); }}>
                  <span>{e.name}</span>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>{e.id}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
              <label style={{ display: "block", padding: "8px 12px", borderRadius: 8, cursor: "pointer", background: "var(--accent)", color: "#fff", textAlign: "center", fontSize: 13, fontWeight: 600 }}>
                <input type="file" accept=".csv,.tsv,.txt" multiple onChange={handleFiles} style={{ display: "none" }} />
                重新上傳
              </label>
            </div>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
            {selectedEmp && data[selectedEmp] && (
              <>
                <div style={{ marginBottom: 20 }}>
                  <h2 style={{ fontSize: 20, fontWeight: 700 }}>
                    {data[selectedEmp].empName}
                    <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>{data[selectedEmp].empId}</span>
                  </h2>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>已載入：{fileNames.join("、")}</div>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                  {months.map(m => <div key={m} className={`mtab ${selectedMonth === m ? "active" : ""}`} onClick={() => setSelectedMonth(m)}>{m}</div>)}
                </div>

                {cur && (
                  <>
                    <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                      <StatCard label="排班天數" value={cur.stats.排班} accent="var(--green)" />
                      <StatCard label="排休天數" value={cur.stats.排休} accent="var(--accent)" />
                      <StatCard label="未刷卡" value={cur.stats.未刷卡} accent={cur.stats.未刷卡 > 0 ? "var(--red)" : undefined} />
                      <StatCard label="遲到" value={cur.stats.lateCount} sub="08:00 後到" accent={cur.stats.lateCount > 0 ? "var(--orange)" : undefined} />
                      <StatCard label="早退" value={cur.stats.earlyCount} sub="17:00 前離" accent={cur.stats.earlyCount > 0 ? "var(--orange)" : undefined} />
                      <StatCard label="平均工時" value={cur.stats.avgWorkHours} sub="小時/天" />
                    </div>

                    <div style={{ background: "var(--card-bg)", borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
                      <div className="drow" style={{ fontWeight: 600, fontSize: 12, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                        <div>日期</div><div>狀態</div><div>刷卡時間</div>
                      </div>
                      {[...cur.days].sort((a, b) => a.date.localeCompare(b.date)).map((d, i) => {
                        const dt = new Date(d.date.replace(/\//g, "-"));
                        const dayStr = isNaN(dt.getTime()) ? "" : `(${DOW[dt.getDay()]})`;
                        const short = d.date.replace(/^\d{4}\//, "");
                        return (
                          <div key={i} className="drow">
                            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                              {short} <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{dayStr}</span>
                            </div>
                            <div><StatusBadge status={d.status} /></div>
                            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "var(--text-muted)" }}>
                              {d.times.length > 0 ? d.times.map((t, j) => (
                                <span key={j} style={{
                                  display: "inline-block", marginRight: 12, padding: "1px 6px",
                                  background: j === 0 || j === d.times.length - 1 ? "var(--accent-light)" : "transparent",
                                  borderRadius: 3, color: j === 0 || j === d.times.length - 1 ? "var(--accent)" : "var(--text-muted)"
                                }}>{t}</span>
                              )) : (d.status === "排班" || d.status === "未刷卡") ? <span style={{ color: "var(--red)", fontSize: 12 }}>—</span> : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
