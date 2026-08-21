"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { fmtAmount, type DisplayStatus, type FilterBucket, type Row } from "@/lib/dashboard";

export interface ClassifiedRow extends Row {
  filterBucket: FilterBucket;
  display: DisplayStatus;
  lastAttempt: string;
  noteText: string;
  pdfUrl?: string;
}

const STATUS_LABEL: Record<string, string> = { all: "ทั้งหมด", sent: "ส่งสำเร็จ", await: "รอส่ง", error: "ผิดพลาด" };
const DISPLAY_LABEL: Record<DisplayStatus, string> = { sent: "Sent", submitted: "Sent", queued: "Await", error: "Error" };
const DISPLAY_CLASS: Record<DisplayStatus, string> = { sent: "success", submitted: "submitted", queued: "pending", error: "failed" };

interface Props {
  rows: ClassifiedRow[];
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  typeFilter: string;
  setTypeFilter: (v: string) => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onOpenDetail: (row: ClassifiedRow) => void;
  onSend: () => void;
  onMarkSentSelected: () => void;
  sendLoading: boolean;
  resending: boolean;
}

export function TxTable({
  rows,
  statusFilter,
  setStatusFilter,
  typeFilter,
  setTypeFilter,
  selected,
  setSelected,
  onOpenDetail,
  onSend,
  onMarkSentSelected,
  sendLoading,
  resending,
}: Props) {
  // ปุ่มทั้งสองแยก loading ของตัวเอง แต่ปิดทั้งคู่เวลามีการทำงานอย่างใดอย่างหนึ่งอยู่ กันกด
  // ซ้อนกัน (เช่น กด "ส่ง e-Tax" ระหว่างที่ "ยืนยันว่าส่งแล้ว" ยังทำงานค้างอยู่)
  const busy = sendLoading || resending;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "priority", dir: "asc" });
  const [page, setPage] = useState(1);
  const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
  const [pageSize, setPageSize] = useState<number>(10);

  const priority = (r: ClassifiedRow) => (r.filterBucket === "error" ? 0 : r.filterBucket === "await" ? 1 : 2);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const arr = rows.filter((r) => {
      if (statusFilter !== "all" && r.filterBucket !== statusFilter) return false;
      if (typeFilter !== "all" && r.contactType !== typeFilter) return false;
      if (q) {
        const hay = (r.code + " " + r.contactCode + " " + r.contactName).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const cmp = (a: ClassifiedRow, b: ClassifiedRow) => {
      let av: string | number;
      let bv: string | number;
      if (sort.key === "priority") {
        av = priority(a);
        bv = priority(b);
      } else if (sort.key === "amount") {
        av = typeof a.netAmount === "number" ? a.netAmount : -Infinity;
        bv = typeof b.netAmount === "number" ? b.netAmount : -Infinity;
      } else if (sort.key === "issuedDate") {
        av = a.issuedDate;
        bv = b.issuedDate;
      } else if (sort.key === "contactName") {
        av = a.contactName;
        bv = b.contactName;
      } else if (sort.key === "lastAttempt") {
        av = a.lastAttempt;
        bv = b.lastAttempt;
      } else {
        av = a.code;
        bv = b.code;
      }
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    };
    return [...arr].sort(cmp);
  }, [rows, search, statusFilter, typeFilter, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pagedPage = Math.min(page, totalPages);
  const paged = filtered.slice((pagedPage - 1) * pageSize, pagedPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, typeFilter, pageSize]);

  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const sortIco = (key: string) =>
    sort.key !== key ? (
      <Icon.ArrowUpDown size={11} className="sort-ico" />
    ) : sort.dir === "asc" ? (
      <Icon.ArrowUp size={11} className="sort-ico" />
    ) : (
      <Icon.ArrowDown size={11} className="sort-ico" />
    );
  const sortedClass = (key: string) => "sortable" + (sort.key === key ? " sorted" : "");

  const isSelectable = (r: ClassifiedRow) => r.valid && r.filterBucket !== "sent";
  // "เลือกทั้งหมด" ต้องนับจากรายการที่กรองไว้ "ทุกหน้า" ไม่ใช่แค่หน้าที่กำลังแสดงอยู่
  // ไม่งั้นเลือก 10 วันได้แค่ 10 รายการต่อครั้งตามขนาดหน้า ทั้งที่จริงมีมากกว่านั้นให้เลือก
  const allSelectableFiltered = useMemo(() => filtered.filter(isSelectable), [filtered]);
  const allFilteredSelected = allSelectableFiltered.length > 0 && allSelectableFiltered.every((r) => selected.has(r.code));
  const toggleAllFiltered = () => {
    const ns = new Set(selected);
    if (allFilteredSelected) allSelectableFiltered.forEach((r) => ns.delete(r.code));
    else allSelectableFiltered.forEach((r) => ns.add(r.code));
    setSelected(ns);
  };
  const toggleOne = (code: string) => {
    const ns = new Set(selected);
    if (ns.has(code)) ns.delete(code);
    else ns.add(code);
    setSelected(ns);
  };

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { all: 0, sent: 0, await: 0, error: 0 };
    rows.forEach((r) => {
      if (typeFilter !== "all" && r.contactType !== typeFilter) return;
      c.all++;
      c[r.filterBucket]++;
    });
    return c;
  }, [rows, typeFilter]);

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="toolbar-2">
        <div className="toolbar-row">
          <div className="search">
            <Icon.Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหา เลขที่ใบเสร็จ / contact / ลูกค้า" />
            {search && (
              <button className="btn ghost sm" style={{ padding: "2px 6px" }} onClick={() => setSearch("")}>
                <Icon.Close size={12} />
              </button>
            )}
          </div>
          <div style={{ flex: 1 }}></div>
          <button
            className="btn ghost"
            disabled={selected.size === 0 || busy}
            aria-disabled={selected.size === 0 || busy}
            onClick={onMarkSentSelected}
            title='สำหรับใบที่เช็คใน PEAK UI แล้วว่าออก e-Tax สำเร็จจริง แต่แอปยังไม่ได้ callback ยืนยัน'
          >
            {resending ? (
              <>
                <Icon.Refresh size={14} className="spin" /> กำลังบันทึก...
              </>
            ) : (
              <>
                <Icon.Check size={14} /> ยืนยันว่าส่งแล้ว {selected.size > 0 ? `(${selected.size})` : ""}
              </>
            )}
          </button>
          <button className="btn primary update-btn" disabled={selected.size === 0 || busy} aria-disabled={selected.size === 0 || busy} onClick={onSend}>
            {sendLoading ? (
              <>
                <Icon.Refresh size={14} className="spin" /> กำลังส่ง...
              </>
            ) : (
              <>
                <Icon.Send size={14} /> ส่ง e-Tax {selected.size > 0 ? `(${selected.size})` : ""}
              </>
            )}
          </button>
        </div>
        <div className="toolbar-row">
          <div className="filter-group" role="tablist">
            {["all", "sent", "await", "error"].map((s) => (
              <button key={s} className={"pill" + (statusFilter === s ? " active" : "")} onClick={() => setStatusFilter(s)}>
                {STATUS_LABEL[s]}
                <span className="badge num">{statusCounts[s] ?? 0}</span>
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }}></div>
          <div className="filter-group">
            {["all", "juristic", "ordinary"].map((s) => (
              <button key={s} className={"pill" + (typeFilter === s ? " active" : "")} onClick={() => setTypeFilter(s)}>
                {s === "all" ? "ทุกประเภท" : s === "juristic" ? "นิติบุคคล" : "บุคคลธรรมดา"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="tx">
          <thead>
            <tr>
              <th style={{ width: 38 }}>
                <button
                  className={"check" + (allFilteredSelected ? " on" : "")}
                  onClick={toggleAllFiltered}
                  disabled={allSelectableFiltered.length === 0}
                  aria-label="select all"
                  title={`เลือกทั้งหมด ${allSelectableFiltered.length} รายการ (ทุกหน้า)`}
                >
                  {allFilteredSelected && <Icon.Check size={11} />}
                </button>
              </th>
              <th className={sortedClass("code")} onClick={() => toggleSort("code")}>
                เลขที่ใบเสร็จ {sortIco("code")}
              </th>
              <th className={sortedClass("issuedDate")} onClick={() => toggleSort("issuedDate")}>
                วันที่ {sortIco("issuedDate")}
              </th>
              <th>Contact</th>
              <th className={sortedClass("contactName")} onClick={() => toggleSort("contactName")}>
                ลูกค้า {sortIco("contactName")}
              </th>
              <th>ประเภท</th>
              <th className={sortedClass("priority")} onClick={() => toggleSort("priority")}>
                สถานะ {sortIco("priority")}
              </th>
              <th className={sortedClass("amount")} onClick={() => toggleSort("amount")} style={{ textAlign: "right" }}>
                ยอดสุทธิ {sortIco("amount")}
              </th>
              <th>หมายเหตุ</th>
              <th className={sortedClass("lastAttempt")} onClick={() => toggleSort("lastAttempt")}>
                ส่งล่าสุด {sortIco("lastAttempt")}
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={10}>
                  <div className="empty">
                    <Icon.Inbox size={36} stroke={1.4} />
                    <div style={{ fontWeight: 500, color: "var(--text-2)" }}>ไม่พบรายการตรงกับเงื่อนไข</div>
                  </div>
                </td>
              </tr>
            ) : (
              paged.map((r) => {
                const sel = selected.has(r.code);
                const selectable = isSelectable(r);
                return (
                  <tr
                    key={r.code}
                    className={(sel ? "selected " : "") + (r.filterBucket === "error" ? "failed-row" : "")}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest(".check")) return;
                      onOpenDetail(r);
                    }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className={"check" + (sel ? " on" : "")}
                        disabled={!selectable}
                        onClick={() => selectable && toggleOne(r.code)}
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
                        <span className="receipt">{r.code}</span>
                      )}
                    </td>
                    <td className="when">{r.issuedDate || "-"}</td>
                    <td>
                      <span className="contact">{r.contactCode || "-"}</span>
                    </td>
                    <td>
                      <div className="customer">{r.contactName || "-"}</div>
                    </td>
                    <td>
                      <span className={"type-chip " + r.contactType}>
                        {r.contactType === "juristic" ? "นิติบุคคล" : r.contactType === "ordinary" ? "บุคคลธรรมดา" : "ไม่ทราบ"}
                      </span>
                    </td>
                    <td>
                      <span className={"status " + DISPLAY_CLASS[r.display]}>{DISPLAY_LABEL[r.display]}</span>
                      {r.pdfUrl && (
                        <a
                          className="view-link"
                          style={{ marginLeft: 8 }}
                          href={r.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          PDF
                        </a>
                      )}
                    </td>
                    <td className="amt">{fmtAmount(r.netAmount)}</td>
                    <td>
                      <span className={"note" + (r.filterBucket === "error" ? " err" : "")}>{r.noteText || "-"}</span>
                    </td>
                    <td className="when">{r.lastAttempt || "-"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <div>
          {selected.size > 0 ? (
            <>
              เลือก{" "}
              <b className="num" style={{ color: "var(--text)" }}>
                {selected.size}
              </b>{" "}
              / {filtered.length} รายการ
            </>
          ) : (
            <>
              แสดง{" "}
              <b className="num" style={{ color: "var(--text)" }}>
                {filtered.length === 0 ? 0 : (pagedPage - 1) * pageSize + 1}–{Math.min(filtered.length, pagedPage * pageSize)}
              </b>{" "}
              จาก {filtered.length}
            </>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-3)" }}>
          <span>แสดง</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)" }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={filtered.length || 1}>ทั้งหมด</option>
          </select>
          <span>รายการ/หน้า</span>
        </div>
        <div className="pager">
          <button className="pg" onClick={() => setPage(1)} disabled={pagedPage <= 1}>
            «
          </button>
          <button className="pg" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pagedPage <= 1}>
            <Icon.ChevronLeft size={12} />
          </button>
          {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
            const start = Math.max(1, Math.min(pagedPage - 2, totalPages - 4));
            const n = start + i;
            if (n > totalPages) return null;
            return (
              <button key={n} className={"pg" + (n === pagedPage ? " active" : "")} onClick={() => setPage(n)}>
                {n}
              </button>
            );
          })}
          <button className="pg" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={pagedPage >= totalPages}>
            <Icon.ChevronRight size={12} />
          </button>
          <button className="pg" onClick={() => setPage(totalPages)} disabled={pagedPage >= totalPages}>
            »
          </button>
        </div>
      </div>
    </div>
  );
}
