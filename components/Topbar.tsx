"use client";

import { Icon } from "./icons";
import { ImportReportPanel } from "./ImportReportPanel";
import { addDays, parseYMD, startOfToday, ymd } from "@/lib/dashboard";

const PRESETS = [
  { key: "today", label: "วันนี้" },
  { key: "yesterday", label: "เมื่อวาน" },
  { key: "week", label: "7 วัน" },
  { key: "month", label: "30 วัน" },
];

interface Props {
  from: Date;
  to: Date;
  setRange: (f: Date, t: Date) => void;
  onRefresh: () => void;
  lastUpdated: Date | null;
  loading: boolean;
}

export function Topbar({ from, to, setRange, onRefresh, lastUpdated, loading }: Props) {
  const today = startOfToday();

  const onFrom = (e: React.ChangeEvent<HTMLInputElement>) => {
    // เลือกวันที่ใหม่ทางช่อง "จาก" = ดูวันนั้นวันเดียวเสมอ (sync "ถึง" ให้เท่ากัน)
    // ไม่งั้นถ้าเดิม from=to=วันนี้ แล้วเลือกวันก่อนหน้า จะได้ช่วง [วันที่เลือก, วันนี้]
    // แทนที่จะเป็นวันที่เลือกวันเดียว — ข้อมูลของวันนี้ (ที่เห็นอยู่แล้ว) จะกลบจนดูเหมือน
    // ไม่มีอะไรเปลี่ยน ทั้งที่จริงเปลี่ยนช่วงแล้ว
    const d = parseYMD(e.target.value);
    setRange(d, d);
  };
  const onTo = (e: React.ChangeEvent<HTMLInputElement>) => {
    // ปรับ "ถึง" = ขยาย/หดช่วงจากวันเริ่ม "จาก" เดิม (สำหรับคนที่ตั้งใจดูหลายวัน)
    const d = parseYMD(e.target.value);
    setRange(d < from ? d : from, d);
  };
  const shift = (n: number) => setRange(addDays(from, n), addDays(to, n));
  const applyPreset = (k: string) => {
    if (k === "today") setRange(today, today);
    else if (k === "yesterday") setRange(addDays(today, -1), addDays(today, -1));
    else if (k === "week") setRange(addDays(today, -6), today);
    else if (k === "month") setRange(addDays(today, -29), today);
  };

  const isSameDay = ymd(from) === ymd(to);
  const presetKey = (() => {
    if (isSameDay && ymd(from) === ymd(today)) return "today";
    if (isSameDay && ymd(from) === ymd(addDays(today, -1))) return "yesterday";
    if (ymd(to) === ymd(today) && ymd(from) === ymd(addDays(today, -6))) return "week";
    if (ymd(to) === ymd(today) && ymd(from) === ymd(addDays(today, -29))) return "month";
    return null;
  })();

  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark">e-T</div>
        <div>
          <h1>e-Tax Automation</h1>
          <div className="sub">PEAK e-Tax submission dashboard</div>
        </div>
      </div>
      <div className="topbar-actions">
        <div className="last-updated">
          <span className={"pulse" + (loading ? " loading" : "")}></span>
          {loading ? (
            "กำลังดึงข้อมูล..."
          ) : lastUpdated ? (
            <>
              อัปเดตล่าสุด{" "}
              <span className="mono num" style={{ marginLeft: 4 }}>
                {lastUpdated.toLocaleTimeString("th-TH")}
              </span>
            </>
          ) : (
            "ยังไม่ได้โหลดข้อมูล"
          )}
        </div>

        <button
          className="btn ghost sm"
          onClick={onRefresh}
          disabled={loading}
          title="ดึงข้อมูลลูกค้าใหม่ทั้งหมด ไม่ใช้ค่าที่แคชไว้ — ใช้เมื่อเพิ่งแก้ไขข้อมูล contact ใน PEAK แล้วอยากเห็นผลทันที"
        >
          <Icon.Refresh size={13} className={loading ? "spin" : ""} /> รีเฟรช
        </button>

        <ImportReportPanel />

        <div className="filter-group" role="tablist">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={"pill" + (presetKey === p.key ? " active" : "")}
              onClick={() => applyPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="date-group">
          <button className="seg nav" onClick={() => shift(-1)} aria-label="shift earlier">
            <Icon.ChevronLeft size={14} />
          </button>
          <div className="seg input">
            <Icon.Calendar size={14} />
            <input type="date" value={ymd(from)} onChange={onFrom} max={ymd(today)} />
          </div>
          <div className="seg" style={{ padding: "8px 6px", color: "var(--muted)" }}>
            →
          </div>
          <div className="seg input">
            <input type="date" value={ymd(to)} onChange={onTo} min={ymd(from)} max={ymd(today)} />
          </div>
          <button className="seg nav" onClick={() => shift(1)} aria-label="shift later">
            <Icon.ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
