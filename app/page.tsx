"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/Topbar";
import { SummaryBanner } from "@/components/SummaryBanner";
import { KpiGrid } from "@/components/KpiGrid";
import { ChartsRow } from "@/components/ChartsRow";
import { TxTable, type ClassifiedRow } from "@/components/TxTable";
import { DetailPanel } from "@/components/DetailPanel";
import { Icon } from "@/components/icons";
import { classifyRow, startOfToday, ymd, type EtaxStatusEntry, type Row } from "@/lib/dashboard";

interface FetchResponse {
  total: number;
  validCount: number;
  alreadySentCount: number;
  rows: Row[];
}

interface SendResult {
  code: string;
  success: boolean;
  skipped?: boolean;
  message: string;
}

type Notice = { kind: "info" | "err"; text: string } | null;

const fmtDate = (d: Date) => ymd(d).replaceAll("-", ""); // yyyy-mm-dd -> yyyymmdd
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Home() {
  const today = startOfToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const setRange = (f: Date, t: Date) => {
    setFrom(f);
    setTo(t);
  };

  const [rawRows, setRawRows] = useState<Row[]>([]);
  const [etaxStatus, setEtaxStatus] = useState<Record<string, EtaxStatusEntry>>({});
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<"fetch" | "status" | null>(null);
  const [loadingElapsed, setLoadingElapsed] = useState(0);
  const [sendLoading, setSendLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [resending, setResending] = useState(false);

  // นับเวลาระหว่างส่ง e-Tax / ยืนยันสถานะด้วยมือ เพื่อบอกว่ายังทำงานอยู่ ไม่ได้ค้าง — ผู้ใช้
  // แจ้งว่าบางครั้งกดส่งแล้วไม่รู้ว่าระบบกำลังทำงานหรือไม่ (ปุ่มแค่จางลงเฉย ๆ ไม่มีข้อความ)
  const busy = sendLoading || resending;
  const [busyElapsed, setBusyElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setBusyElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setBusyElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  // นับเวลาที่ใช้ดึงข้อมูล เพื่อบอกผู้ใช้ว่ายังทำงานอยู่ ไม่ได้ค้าง (บางช่วงวันที่ที่มีใบ
  // เยอะ + ตรวจ contact/ชำระเงินทีละใบ อาจใช้เวลาหลักนาที)
  useEffect(() => {
    if (!loading) {
      setLoadingElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setLoadingElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loading]);

  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailCode, setDetailCode] = useState<string | null>(null);

  // กัน race condition: ถ้าเปลี่ยนช่วงวันที่ก่อนคำขอเก่า (ซึ่งอาจช้ากว่า เช่นดึงวันที่มีใบเยอะ)
  // จะได้ผลกลับมา คำขอเก่าต้องไม่ทับผลของคำขอใหม่ล่าสุด — ใช้เลขลำดับคำขอกำกับไว้เช็ค
  const fetchSeq = useRef(0);

  const fetchAll = useCallback(async (f: Date, t: Date, forceRefresh = false) => {
    const seq = ++fetchSeq.current;
    const isCurrent = () => seq === fetchSeq.current;

    setLoading(true);
    setLoadingStage("fetch");
    try {
      const res = await fetch("/api/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateStart: fmtDate(f), dateEnd: fmtDate(t), forceRefresh }),
      });
      const json = await res.json();
      if (!isCurrent()) return; // มีคำขอใหม่กว่าเริ่มไปแล้ว ทิ้งผลของคำขอนี้

      if (!res.ok) {
        setNotice({ kind: "err", text: `ดึงข้อมูลไม่สำเร็จ: ${json.error || res.status}` });
        setRawRows([]);
        return;
      }
      const resp: FetchResponse = json;
      setRawRows(resp.rows);

      if (resp.rows.length) {
        setLoadingStage("status");
        const codes = resp.rows.map((r) => r.code).join(",");
        const stRes = await fetch(`/api/etax-status?codes=${encodeURIComponent(codes)}`);
        const stJson = await stRes.json();
        if (!isCurrent()) return;
        setEtaxStatus(stJson.status || {});
      } else {
        setEtaxStatus({});
      }
      setLastUpdated(new Date());
      setSelected(new Set());
    } catch (e) {
      if (!isCurrent()) return;
      setNotice({ kind: "err", text: `เชื่อมต่อ server ไม่ได้: ${e}` });
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setLoadingStage(null);
      }
    }
  }, []);

  useEffect(() => {
    // ต้องรีเซ็ต filter ทุกครั้งที่เปลี่ยนช่วงวันที่ ไม่งั้น filter เก่า (เช่นเพิ่งกด
    // การ์ด "ผิดพลาด" ค้างไว้) จะไปกรองข้อมูลชุดใหม่ต่อ ทำให้เห็นว่า "ดึงมาน้อย"
    // ทั้งที่จริงดึงมาครบ แค่ถูกกรองซ้อนอยู่
    setStatusFilter("all");
    setTypeFilter("all");
    fetchAll(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ymd(from), ymd(to)]);

  const classified: ClassifiedRow[] = useMemo(
    () =>
      rawRows.map((r) => {
        const es = etaxStatus[r.code];
        const { filterBucket, display } = classifyRow(r, es);
        // ยังไม่เคยมีผลส่งจริง (es.status "unknown"/ไม่มี es เลย) -> โชว์เหตุผลจากการตรวจ
        // contact/approve (r.reason) เพราะเป็นข้อมูล actionable กว่า ส่วนที่เคยมีผลส่ง
        // จริงแล้ว (sent/pending/error จาก callback) ต้องยึด es.message เสมอ ไม่ว่า r.valid ณ
        // ตอนนี้จะเป็นอะไรก็ตาม — เพราะ es.message สะท้อนผลจริงจาก INET/callback ส่วน r.valid
        // สะท้อนแค่ผลตรวจสอบข้อมูล ณ ตอนดึงครั้งนี้เท่านั้น ถ้าใบเคยออกสำเร็จไปแล้วจริง แต่
        // ข้อมูลตอนนี้ดันไม่ผ่าน (เช่น contact ถูกแก้ทีหลัง) ก็ต้องยังโชว์ "Success" ไม่ใช่
        // ข้อความจากการตรวจสอบครั้งนี้ที่ทำให้ดูขัดแย้งกับ badge "Sent"
        const hasRealSendResult = Boolean(es) && es!.status !== "unknown";
        const noteText = hasRealSendResult ? es!.message || r.reason : r.reason;
        return { ...r, filterBucket, display, lastAttempt: es?.timestamp || "", noteText, pdfUrl: es?.pdfUrl };
      }),
    [rawRows, etaxStatus]
  );

  // วนเช็คสถานะ e-Tax ของแถวที่ยัง "pending" ต่อเนื่องในพื้นหลัง (ไม่ใช่แค่ ~45 วิ
  // หลังกดส่งครั้งเดียวเหมือน pollEtaxResult) เพราะ INET อาจใช้เวลานานกว่านั้นมาก —
  // ผู้ใช้ไม่ต้องกดรีเฟรชเองซ้ำ ๆ เพื่อรอผล หยุดอัตโนมัติเมื่อไม่มีแถว pending เหลือแล้ว
  const pendingCodesKey = useMemo(
    () =>
      classified
        .filter((r) => r.display === "submitted")
        .map((r) => r.code)
        .sort()
        .join(","),
    [classified]
  );

  useEffect(() => {
    if (!pendingCodesKey) return;
    const codes = pendingCodesKey.split(",");
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/etax-status?codes=${encodeURIComponent(codes.join(","))}`);
        const json = await res.json();
        setEtaxStatus((prev) => ({ ...prev, ...(json.status || {}) }));
      } catch {
        // เงียบไว้ รอบถัดไปค่อยลองใหม่
      }
    }, 20000); // ทุก 20 วินาที
    return () => clearInterval(interval);
  }, [pendingCodesKey]);

  const counts = useMemo(() => {
    const c = {
      sent: 0, await: 0, error: 0,
      juristicSent: 0, juristicAwait: 0, juristicError: 0,
      ordinarySent: 0, ordinaryAwait: 0, ordinaryError: 0,
    };
    classified.forEach((r) => {
      c[r.filterBucket]++;
      if (r.contactType === "juristic") {
        if (r.filterBucket === "sent") c.juristicSent++;
        else if (r.filterBucket === "await") c.juristicAwait++;
        else c.juristicError++;
      } else if (r.contactType === "ordinary") {
        if (r.filterBucket === "sent") c.ordinarySent++;
        else if (r.filterBucket === "await") c.ordinaryAwait++;
        else c.ordinaryError++;
      }
    });
    return c;
  }, [classified]);

  const invalidCount = useMemo(() => classified.filter((r) => !r.valid).length, [classified]);
  const retryableCodes = useMemo(
    () => classified.filter((r) => r.valid && r.filterBucket === "error").map((r) => r.code),
    [classified]
  );

  const applyPick = (type: string, status: string) => {
    const isActive = statusFilter === status && typeFilter === type;
    if (isActive) {
      setStatusFilter("all");
      setTypeFilter("all");
    } else {
      setStatusFilter(status);
      setTypeFilter(type);
    }
  };
  const clearFilters = () => {
    setStatusFilter("all");
    setTypeFilter("all");
  };

  const detailRow = useMemo(() => classified.find((r) => r.code === detailCode) ?? null, [classified, detailCode]);

  async function pollEtaxResult(codes: string[]) {
    if (codes.length === 0) return;
    const MAX = 15;
    const EVERY = 3000; // รอสูงสุด ~45 วินาที
    for (let attempt = 1; attempt <= MAX; attempt++) {
      await sleep(EVERY);
      let st: Record<string, EtaxStatusEntry> = {};
      try {
        const res = await fetch(`/api/etax-status?codes=${encodeURIComponent(codes.join(","))}`);
        st = (await res.json()).status || {};
      } catch {
        continue;
      }
      setEtaxStatus((prev) => ({ ...prev, ...st }));
      const pending = codes.filter((c) => (st[c] || {}).status === "pending");
      const issued = codes.filter((c) => (st[c] || {}).status === "issued").length;
      const failed = codes.filter((c) => (st[c] || {}).status === "failed").length;
      if (pending.length === 0) {
        setNotice({
          kind: failed ? "err" : "info",
          text: `ออกใบสำเร็จ ${issued} ใบ / ส่งไม่ผ่าน ${failed} ใบ`,
        });
        return;
      }
      setNotice({ kind: "info", text: `กำลังรอผลออกใบจริงจาก INET... (${attempt}/${MAX}) — เหลือ ${pending.length} ใบ` });
    }
    setNotice({ kind: "info", text: "ยังรอผลออกใบจริงจาก INET ไม่ครบ — ข้อมูลจะอัปเดตเมื่อรีเฟรชครั้งถัดไป" });
  }

  async function sendCodes(codes: string[]) {
    if (codes.length === 0) return;
    setSendLoading(true);
    // ตั้ง notice ทันทีก่อนยิง request — ไม่งั้นระหว่างรอ PEAK ตอบ (ตรวจ Approve + ส่งทีละใบ
    // อาจใช้เวลาหลายวินาทีถึงหลักนาทีถ้าเลือกหลายใบ) หน้าจอจะว่างเปล่า ดูเหมือนค้าง
    setNotice({ kind: "info", text: `กำลังส่ง e-Tax ${codes.length} ใบ...` });
    try {
      const res = await fetch("/api/send-etax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes }),
      });
      const json = await res.json();
      if (!res.ok) {
        setNotice({ kind: "err", text: `ผิดพลาด: ${json.error || res.status}` });
        return;
      }
      const results: SendResult[] = json.results;
      const accepted = results.filter((r) => r.success).map((r) => r.code);
      setNotice({ kind: "info", text: `📨 ส่งคำขอแล้ว ${json.sent} ใบ — กำลังรอผลออกใบจริงจาก INET...` });
      setSelected(new Set());
      await pollEtaxResult(accepted);
      await fetchAll(from, to);
    } catch (e) {
      setNotice({ kind: "err", text: `เชื่อมต่อ server ไม่ได้: ${e}` });
    } finally {
      setSendLoading(false);
    }
  }

  const onSendSelected = () => {
    if (selected.size === 0) return;
    if (!confirm(`ยืนยันส่ง e-Tax จำนวน ${selected.size} ใบ?`)) return;
    sendCodes([...selected]);
  };

  const onResendOne = async (code: string) => {
    setResending(true);
    try {
      await sendCodes([code]);
    } finally {
      setResending(false);
    }
  };

  const onResendAllErrors = () => {
    if (retryableCodes.length === 0) return;
    if (!confirm(`ยืนยันส่ง e-Tax ซ้ำจำนวน ${retryableCodes.length} ใบ?`)) return;
    sendCodes(retryableCodes);
  };

  // สำหรับใบที่ตรวจสอบใน PEAK UI แล้วพบว่าออก e-Tax สำเร็จจริง แต่แอปไม่เคยได้ callback
  // ยืนยัน (เช่น ส่งผ่าน PEAK UI โดยตรง หรือ callback หลุดหายตอน tunnel ล่ม) — ยืนยันมือ
  const onMarkSent = async (code: string) => {
    if (!confirm(`ยืนยันว่าใบ ${code} ออก e-Tax สำเร็จแล้วจริง (เช็คใน PEAK UI แล้ว)?\nการยืนยันนี้จะทำให้แอปแสดงสถานะ "ส่งสำเร็จ" ทันที`)) return;
    setResending(true);
    setNotice({ kind: "info", text: `กำลังบันทึกสถานะใบ ${code}...` });
    try {
      const res = await fetch("/api/mark-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setNotice({ kind: "err", text: `ผิดพลาด: ${json.error || res.status}` });
        return;
      }
      setNotice({ kind: "info", text: `ยืนยันใบ ${code} เป็น "ส่งสำเร็จ" แล้ว` });
      await fetchAll(from, to);
    } catch (e) {
      setNotice({ kind: "err", text: `เชื่อมต่อ server ไม่ได้: ${e}` });
    } finally {
      setResending(false);
    }
  };

  // เหมือน onMarkSent แต่ทำทีเดียวหลายใบตามที่เลือกด้วย checkbox — ต้องเช็คใน PEAK UI มาแล้ว
  // ทุกใบก่อนเสมอ ไม่ใช่แค่บางใบ เพราะ error message เดียวกัน (เช่น 500 "contact support")
  // ไม่ได้แปลว่า "เคยส่งแล้ว" เสมอไป บางใบอาจเป็นปัญหาชั่วคราวจริง ๆ ที่ยังไม่เคยส่งเลยก็ได้
  const onMarkSentSelected = async () => {
    if (selected.size === 0) return;
    if (
      !confirm(
        `ยืนยันว่าตรวจสอบใน PEAK UI แล้ว "ทุกใบ" ที่เลือกไว้ (${selected.size} ใบ) ออก e-Tax สำเร็จจริงหมดแล้ว?\n\n` +
          `ห้ามกดถ้ายังไม่ได้เช็คทีละใบใน PEAK UI จริง — ใบที่จริง ๆ ยังไม่เคยส่งจะถูกเข้าใจผิดว่าส่งแล้ว และจะไม่มีทางกด "ส่ง e-Tax" ซ้ำได้อีก`
      )
    )
      return;
    setResending(true);
    setNotice({ kind: "info", text: `กำลังบันทึกสถานะ ${selected.size} ใบ...` });
    try {
      const codes = [...selected];
      const res = await fetch("/api/mark-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setNotice({ kind: "err", text: `ผิดพลาด: ${json.error || res.status}` });
        return;
      }
      setNotice({ kind: "info", text: `ยืนยัน ${codes.length} ใบเป็น "ส่งสำเร็จ" แล้ว` });
      setSelected(new Set());
      await fetchAll(from, to);
    } catch (e) {
      setNotice({ kind: "err", text: `เชื่อมต่อ server ไม่ได้: ${e}` });
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="shell">
      <Topbar from={from} to={to} setRange={setRange} onRefresh={() => fetchAll(from, to, true)} lastUpdated={lastUpdated} loading={loading} />

      {loading && (
        <div className="notice">
          <Icon.Refresh size={14} className="spin" />
          {loadingStage === "status" ? "กำลังตรวจสอบสถานะการส่ง..." : "กำลังดึงใบเสร็จ + ตรวจสอบข้อมูลลูกค้า/การชำระเงิน..."}{" "}
          <span className="mono num">({loadingElapsed} วินาที)</span>
          {loadingElapsed > 20 && " — ช่วงวันที่กว้างอาจใช้เวลาถึงหลายนาที"}
        </div>
      )}

      {notice && (
        <div className={"notice" + (notice.kind === "err" ? " err" : "")}>
          {busy ? <Icon.Refresh size={14} className="spin" /> : <Icon.Alert size={14} />} {notice.text}
          {busy && <span className="mono num"> ({busyElapsed} วินาที)</span>}
        </div>
      )}

      <SummaryBanner from={from} to={to} total={classified.length} sent={counts.sent} awaitCount={counts.await} errorCount={counts.error} />

      {invalidCount > 0 && (
        <div className="alert warn">
          <div className="ico">
            <Icon.Alert size={16} />
          </div>
          <div className="alert-body">
            <div className="alert-title">พบ {invalidCount} รายการที่ไม่ผ่านการตรวจสอบข้อมูลลูกค้า</div>
            <div className="alert-sub">
              ต้องแก้ไขข้อมูล contact ใน PEAK ก่อนจึงจะส่ง e-Tax ได้
              {retryableCodes.length > 0 ? ` · มีอีก ${retryableCodes.length} ใบที่ส่งไม่สำเร็จ พร้อมส่งใหม่` : ""}
            </div>
          </div>
          <div className="alert-actions">
            <button className="btn sm" onClick={() => applyPick("all", "error")}>
              ดูรายการที่มีปัญหา
            </button>
            {retryableCodes.length > 0 && (
              <button className="btn sm danger" disabled={sendLoading} onClick={onResendAllErrors}>
                <Icon.Send size={12} /> Resend ที่ส่งไม่ผ่าน ({retryableCodes.length})
              </button>
            )}
          </div>
        </div>
      )}

      <KpiGrid counts={counts} statusFilter={statusFilter} typeFilter={typeFilter} onPick={applyPick} />

      <ChartsRow
        sent={counts.sent}
        awaitCount={counts.await}
        errorCount={counts.error}
        juristic={{ sent: counts.juristicSent, await: counts.juristicAwait, error: counts.juristicError }}
        ordinary={{ sent: counts.ordinarySent, await: counts.ordinaryAwait, error: counts.ordinaryError }}
        statusFilter={statusFilter}
        typeFilter={typeFilter}
        onPick={applyPick}
        onClear={clearFilters}
      />

      <TxTable
        key={`${ymd(from)}_${ymd(to)}`} // เปลี่ยนช่วงวันที่ -> รีเซ็ต search/sort/หน้า ในตารางทั้งหมด
        rows={classified}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        typeFilter={typeFilter}
        setTypeFilter={setTypeFilter}
        selected={selected}
        setSelected={setSelected}
        onOpenDetail={(r) => setDetailCode(r.code)}
        onSend={onSendSelected}
        onMarkSentSelected={onMarkSentSelected}
        sendLoading={sendLoading}
        resending={resending}
      />

      <DetailPanel
        row={detailRow}
        onClose={() => setDetailCode(null)}
        onResend={onResendOne}
        onMarkSent={onMarkSent}
        resending={resending}
      />
    </div>
  );
}
