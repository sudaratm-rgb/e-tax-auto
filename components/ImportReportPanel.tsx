"use client";

import { useRef, useState } from "react";
import { Icon } from "./icons";
import { fmtAmount } from "@/lib/dashboard";

interface AwaitRow {
  code: string;
  issueDate: string;
  status: string;
  customerName: string;
  taxId: string;
  grandTotal: unknown;
  statusEDoc: string;
  documentLink: string;
  valid: boolean;
  checkReason: string;
}

interface ImportResult {
  total: number;
  awaitCount: number;
  rows: AwaitRow[];
  sentInFileCount: number;
  needsReconcile: string[];
}

interface SendApiResult {
  code: string;
  success: boolean;
  skipped?: boolean;
  message: string;
}

interface EtaxStatusEntry {
  status: "issued" | "failed" | "pending" | "unknown";
  message: string;
}

// สถานะจริงของแต่ละใบหลังกดส่ง — "accepted" คือ PEAK รับคำขอแล้ว (resCode 200) เท่านั้น
// ยังไม่ใช่ผลยืนยันจริงจาก INET ต้อง poll ต่อจนกว่าจะได้ "issued"/"failed" ที่แน่นอนแล้ว
type Phase = "accepted" | "issued" | "failed" | "skipped" | "send-error";
interface RowOutcome {
  phase: Phase;
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// จัดกลุ่มสถานะของแต่ละแถวสำหรับ filter — แยกจาก outcome.phase ตรง ๆ เพราะ "skipped"/
// "send-error"/"failed" รวมกันเป็นกลุ่มเดียว ("ส่งไม่สำเร็จ") จากมุมมองผู้ใช้ ไม่ต้องแยกย่อย
type FilterKey = "all" | "ready" | "invalid" | "issued" | "waiting" | "notOk";
const FILTER_LABEL: Record<FilterKey, string> = {
  all: "ทั้งหมด",
  ready: "พร้อมส่ง",
  invalid: "มีปัญหา",
  issued: "ส่งสำเร็จ",
  waiting: "รอผล INET",
  notOk: "ส่งไม่สำเร็จ",
};
function categoryOf(r: AwaitRow, oc: RowOutcome | undefined): FilterKey {
  if (oc) {
    if (oc.phase === "issued") return "issued";
    if (oc.phase === "accepted") return "waiting";
    return "notOk"; // failed | send-error | skipped
  }
  return r.valid ? "ready" : "invalid";
}

/**
 * นำเข้าไฟล์รายงานที่ export จากหน้าเว็บ PEAK เอง มาดูเฉพาะแถวที่ "ยังไม่ส่ง" — ใช้เป็นแหล่ง
 * ความจริงสำรอง เพราะ PEAK Open API ไม่มี endpoint เช็คสถานะนี้โดยตรงเลย (ตรวจสอบแล้วหลายทาง
 * ในเซสชันนี้ ไม่มีจริง ๆ) แถวที่จะเลือกส่งได้ต้องผ่านการตรวจสอบ contact/journal เหมือนตาราง
 * หลักทุกประการก่อนเสมอ (เช็คจากฝั่ง server ด้วย buildRow ตัวเดียวกัน) กันส่งใบข้อมูลไม่ครบ/
 * ผิดผ่านทางลัดนี้ไปได้ — ใช้ /api/send-etax เส้นทางเดียวกับตารางหลักตอนกดส่งจริง
 *
 * หลังส่ง ต้อง poll /api/etax-status ต่อเพื่อรอผลยืนยันจริงจาก INET เสมอ (resCode 200 ตอน
 * ส่งแปลว่า "PEAK รับคำขอแล้ว" เท่านั้น ไม่ใช่ "ออกใบสำเร็จจริง" — ผลจริงมาทาง callback แบบ
 * async) เหมือนพฤติกรรมของตารางหลักทุกประการ ไม่ใช่แค่โชว์ผล accepted แล้วจบเลย
 *
 * นอกจากนี้ยังเทียบใบที่รายงานบอกว่า "ส่งแล้ว" กับ log ของเราเอง หาใบที่เรายังไม่มีประวัติ
 * (เช่น ส่งผ่าน PEAK UI ตรง ๆ ไม่ผ่านแอปนี้) ให้ sync สถานะเข้า database ได้เลย
 */
export function ImportReportPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendLoading, setSendLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, RowOutcome>>({});
  const [reconciling, setReconciling] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [statusFilter, setStatusFilter] = useState<FilterKey>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = () => inputRef.current?.click();

  const reset = () => {
    setResult(null);
    setError(null);
    setSelected(new Set());
    setOutcomes({});
    setReconciled(false);
    setStatusFilter("all");
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // เลือกไฟล์เดิมซ้ำได้อีกครั้ง
    if (!file) return;
    setFileName(file.name);
    reset();
    setLoading(true);
    setOpen(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/import-report", { method: "POST", body: formData });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `ผิดพลาด: ${res.status}`);
        return;
      }
      setResult(json);
    } catch (exc) {
      setError(`เชื่อมต่อ server ไม่ได้: ${exc}`);
    } finally {
      setLoading(false);
    }
  };

  const allRows = result?.rows ?? [];
  const statusCounts = allRows.reduce<Record<FilterKey, number>>(
    (acc, r) => {
      acc.all++;
      acc[categoryOf(r, outcomes[r.code])]++;
      return acc;
    },
    { all: 0, ready: 0, invalid: 0, issued: 0, waiting: 0, notOk: 0 }
  );
  const filteredRows = statusFilter === "all" ? allRows : allRows.filter((r) => categoryOf(r, outcomes[r.code]) === statusFilter);

  // เลือกส่งได้เฉพาะใบที่ผ่านตรวจสอบ (valid), ยังไม่มีผลส่งในรอบนี้ และตรงกับ filter ที่กำลังดูอยู่
  const selectableRows = filteredRows.filter((r) => r.valid && !outcomes[r.code]);
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.code));
  const toggleAll = () => {
    const ns = new Set(selected);
    if (allSelected) selectableRows.forEach((r) => ns.delete(r.code));
    else selectableRows.forEach((r) => ns.add(r.code));
    setSelected(ns);
  };
  const toggleOne = (code: string) => {
    const ns = new Set(selected);
    if (ns.has(code)) ns.delete(code);
    else ns.add(code);
    setSelected(ns);
  };

  // รอผลยืนยันจริงจาก INET (poll ทุก 3 วิ สูงสุด ~45 วิ) — เหมือน pollEtaxResult ของตารางหลัก
  const pollForInetResult = async (codes: string[]) => {
    if (codes.length === 0) return;
    setPolling(true);
    const MAX = 15;
    const EVERY = 3000;
    let remaining = codes;
    for (let attempt = 1; attempt <= MAX && remaining.length > 0; attempt++) {
      await sleep(EVERY);
      let st: Record<string, EtaxStatusEntry> = {};
      try {
        const res = await fetch(`/api/etax-status?codes=${encodeURIComponent(remaining.join(","))}`);
        st = (await res.json()).status || {};
      } catch {
        continue;
      }
      const resolved: Record<string, RowOutcome> = {};
      const stillPending: string[] = [];
      for (const code of remaining) {
        const s = st[code];
        if (s?.status === "issued") resolved[code] = { phase: "issued", message: s.message || "Success" };
        else if (s?.status === "failed") resolved[code] = { phase: "failed", message: s.message || "ออกใบไม่สำเร็จ" };
        else stillPending.push(code);
      }
      if (Object.keys(resolved).length) setOutcomes((prev) => ({ ...prev, ...resolved }));
      remaining = stillPending;
    }
    if (remaining.length) {
      setOutcomes((prev) => {
        const next = { ...prev };
        for (const code of remaining) {
          next[code] = { phase: "accepted", message: "ยังรอผลยืนยันจาก INET — เช็คสถานะอีกทีที่ตารางหลักภายหลังได้" };
        }
        return next;
      });
    }
    setPolling(false);
  };

  const onSend = async () => {
    if (selected.size === 0) return;
    if (!confirm(`ยืนยันส่ง e-Tax จำนวน ${selected.size} ใบ จากไฟล์ที่นำเข้า?`)) return;
    setSendLoading(true);
    try {
      const codes = [...selected];
      // force: true — ทุกใบในรายการนี้ผ่านการยืนยันจากรายงาน PEAK แล้วว่า "ยังไม่ส่งจริง"
      // (Await) ต้องข้ามเช็ค "เคยส่งแล้ว" ของ log ฝั่งเราเอง เผื่อ log เคยค้างไว้ผิดจากตอน
      // เคยยิงคำขอไปแล้วแต่ไม่ได้รับ callback ยืนยันกลับมา — เชื่อรายงาน PEAK (ground truth)
      const res = await fetch("/api/send-etax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes, force: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `ผิดพลาด: ${res.status}`);
        return;
      }
      const next: Record<string, RowOutcome> = {};
      const acceptedCodes: string[] = [];
      for (const r of json.results as SendApiResult[]) {
        if (r.skipped) next[r.code] = { phase: "skipped", message: r.message };
        else if (!r.success) next[r.code] = { phase: "send-error", message: r.message };
        else {
          next[r.code] = { phase: "accepted", message: "PEAK รับคำขอแล้ว กำลังรอผลยืนยันจาก INET..." };
          acceptedCodes.push(r.code);
        }
      }
      setOutcomes((prev) => ({ ...prev, ...next }));
      setSelected(new Set());
      // อย่า await ตรงนี้ ไม่งั้น sendLoading จะค้างจนกว่า poll ทั้ง ~45 วิจะจบ
      void pollForInetResult(acceptedCodes);
    } catch (exc) {
      setError(`เชื่อมต่อ server ไม่ได้: ${exc}`);
    } finally {
      setSendLoading(false);
    }
  };

  const onReconcile = async () => {
    if (!result || result.needsReconcile.length === 0) return;
    if (
      !confirm(
        `รายงาน PEAK บอกว่า ${result.needsReconcile.length} ใบนี้ "ส่งแล้ว" แต่ระบบเรายังไม่มีประวัติ ` +
          `(น่าจะส่งผ่าน PEAK UI ตรง ๆ)\n\nยืนยันบันทึกสถานะ "ส่งสำเร็จ" ให้ทั้งหมดตามรายงาน?`
      )
    )
      return;
    setReconciling(true);
    try {
      const res = await fetch("/api/mark-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: result.needsReconcile }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || `ผิดพลาด: ${res.status}`);
        return;
      }
      setReconciled(true);
    } catch (exc) {
      setError(`เชื่อมต่อ server ไม่ได้: ${exc}`);
    } finally {
      setReconciling(false);
    }
  };

  const OUTCOME_LABEL: Record<Phase, string> = {
    accepted: "รอผล INET...",
    issued: "ส่งสำเร็จ",
    failed: "ผิดพลาด",
    skipped: "ข้าม",
    "send-error": "ผิดพลาด",
  };
  const OUTCOME_CLASS: Record<Phase, string> = {
    accepted: "submitted",
    issued: "success",
    failed: "failed",
    skipped: "pending",
    "send-error": "failed",
  };

  return (
    <>
      <input ref={inputRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={onFileChange} />
      <button
        className="btn ghost sm"
        onClick={onPick}
        title="นำเข้าไฟล์รายงานจาก PEAK เพื่อดูใบที่ยังไม่ส่งจริงตามข้อมูล PEAK และซิงก์สถานะใบที่ส่งผ่าน UI"
      >
        <Icon.Upload size={13} /> นำเข้ารายงาน PEAK
      </button>

      {open && (
        <div className="scrim show" onClick={() => setOpen(false)}>
          <div
            className="card"
            style={{ maxWidth: 1100, width: "92%", margin: "40px auto", maxHeight: "85vh", overflow: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
              <div>
                <div style={{ fontWeight: 600 }}>ผลนำเข้ารายงาน PEAK</div>
                <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{fileName}</div>
              </div>
              <button className="close" onClick={() => setOpen(false)} aria-label="close">
                <Icon.Close size={14} />
              </button>
            </div>

            <div style={{ padding: 18 }}>
              {loading && (
                <div className="notice">
                  <Icon.Refresh size={14} className="spin" /> กำลังอ่านไฟล์ + ตรวจสอบข้อมูล contact/journal ของทุกใบที่รอส่ง...
                </div>
              )}
              {polling && (
                <div className="notice" style={{ marginBottom: 12 }}>
                  <Icon.Refresh size={14} className="spin" /> กำลังรอผลยืนยันออกใบจริงจาก INET...
                </div>
              )}
              {error && (
                <div className="error-block">
                  <div className="em">{error}</div>
                </div>
              )}
              {result && !loading && (
                <>
                  {result.needsReconcile.length > 0 && (
                    <div className="notice" style={{ marginBottom: 12, alignItems: "center" }}>
                      <span style={{ flex: 1 }}>
                        พบ <b className="num">{result.needsReconcile.length}</b> ใบที่รายงาน PEAK บอกว่า &quot;ส่งแล้ว&quot; แต่ระบบเรายังไม่มีประวัติ
                        (น่าจะส่งผ่าน PEAK UI ตรง ๆ)
                      </span>
                      {reconciled ? (
                        <span className="status success">อัปเดตแล้ว</span>
                      ) : (
                        <button className="btn ghost sm" disabled={reconciling} onClick={onReconcile}>
                          {reconciling ? "กำลังบันทึก..." : "ซิงก์สถานะเข้า database"}
                        </button>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 13, color: "var(--text-2)", flex: 1 }}>
                      ทั้งหมด <b className="num">{result.total}</b> ใบในไฟล์ — ส่งแล้ว{" "}
                      <b className="num">{result.sentInFileCount}</b> ใบ, ยังไม่ส่ง{" "}
                      <b className="num">{result.awaitCount}</b> ใบ (พร้อมส่งจริง{" "}
                      <b className="num">{result.rows.filter((r) => r.valid).length}</b> ใบ)
                    </div>
                    {selectableRows.length > 0 && (
                      <button
                        className="btn primary update-btn"
                        disabled={selected.size === 0 || sendLoading}
                        aria-disabled={selected.size === 0 || sendLoading}
                        onClick={onSend}
                      >
                        <Icon.Send size={14} /> ส่ง e-Tax {selected.size > 0 ? `(${selected.size})` : ""}
                      </button>
                    )}
                  </div>
                  {result.rows.length > 0 && (
                    <div className="filter-group" role="tablist" style={{ marginBottom: 12 }}>
                      {(Object.keys(FILTER_LABEL) as FilterKey[]).map((key) => (
                        <button
                          key={key}
                          className={"pill" + (statusFilter === key ? " active" : "")}
                          onClick={() => setStatusFilter(key)}
                        >
                          {FILTER_LABEL[key]}
                          <span className="badge num">{statusCounts[key]}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {result.rows.length === 0 ? (
                    <div className="empty">
                      <Icon.Inbox size={36} stroke={1.4} />
                      <div style={{ fontWeight: 500, color: "var(--text-2)" }}>ไม่มีใบที่รอส่งในไฟล์นี้</div>
                    </div>
                  ) : filteredRows.length === 0 ? (
                    <div className="empty">
                      <Icon.Inbox size={36} stroke={1.4} />
                      <div style={{ fontWeight: 500, color: "var(--text-2)" }}>ไม่มีใบที่ตรงกับตัวกรองนี้</div>
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table className="tx">
                        <thead>
                          <tr>
                            <th style={{ width: 38 }}>
                              <button
                                className={"check" + (allSelected ? " on" : "")}
                                onClick={toggleAll}
                                disabled={selectableRows.length === 0}
                                aria-label="select all"
                              >
                                {allSelected && <Icon.Check size={11} />}
                              </button>
                            </th>
                            <th>เลขที่ใบเสร็จ</th>
                            <th>วันที่ออกใบ</th>
                            <th>ลูกค้า</th>
                            <th>เลขผู้เสียภาษี</th>
                            <th style={{ textAlign: "right" }}>ยอดรวม</th>
                            <th>สถานะเอกสาร</th>
                            <th>สถานะ e-Doc</th>
                            <th>หมายเหตุ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRows.map((r) => {
                            const oc = outcomes[r.code];
                            const sel = selected.has(r.code);
                            const canSelect = r.valid && !oc;
                            return (
                              <tr key={r.code} className={(sel ? "selected " : "") + (!r.valid ? "failed-row" : "")}>
                                <td>
                                  <button
                                    className={"check" + (sel ? " on" : "")}
                                    disabled={!canSelect}
                                    onClick={() => canSelect && toggleOne(r.code)}
                                    aria-label="select"
                                  >
                                    {sel && <Icon.Check size={11} />}
                                  </button>
                                </td>
                                <td onClick={(e) => r.documentLink && e.stopPropagation()}>
                                  {r.documentLink ? (
                                    <a className="receipt" href={r.documentLink} target="_blank" rel="noopener noreferrer">
                                      {r.code}
                                    </a>
                                  ) : (
                                    <span className="mono">{r.code}</span>
                                  )}
                                </td>
                                <td className="when">{r.issueDate || "-"}</td>
                                <td>{r.customerName || "-"}</td>
                                <td className="mono">{r.taxId || "-"}</td>
                                <td className="amt">
                                  {fmtAmount(typeof r.grandTotal === "number" ? r.grandTotal : Number(r.grandTotal) || undefined)}
                                </td>
                                <td>{r.status || "-"}</td>
                                <td>
                                  {oc ? (
                                    <span className={"status " + OUTCOME_CLASS[oc.phase]}>{OUTCOME_LABEL[oc.phase]}</span>
                                  ) : (
                                    <span className={"status " + (r.valid ? "pending" : "failed")}>{r.valid ? r.statusEDoc : "Error"}</span>
                                  )}
                                </td>
                                <td>
                                  <span className={"note" + (oc && oc.phase !== "issued" && oc.phase !== "accepted" ? " err" : "")}>
                                    {oc ? oc.message : r.checkReason || "-"}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
