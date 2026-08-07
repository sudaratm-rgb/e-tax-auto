"use client";

import { Icon } from "./icons";
import { fmtAmount, type DisplayStatus } from "@/lib/dashboard";
import type { ClassifiedRow } from "./TxTable";

const DISPLAY_LABEL: Record<DisplayStatus, string> = { sent: "Sent", submitted: "Sent", queued: "Await", error: "Error" };
const DISPLAY_CLASS: Record<DisplayStatus, string> = { sent: "success", submitted: "submitted", queued: "pending", error: "failed" };

function branchLabel(branchCode: string): string {
  return branchCode === "00000" ? "สำนักงานใหญ่" : `สาขา ${branchCode}`;
}

interface Props {
  row: ClassifiedRow | null;
  onClose: () => void;
  onResend: (code: string) => void;
  onMarkSent: (code: string) => void;
  resending: boolean;
}

export function DetailPanel({ row, onClose, onResend, onMarkSent, resending }: Props) {
  const selectable = row ? row.valid && row.filterBucket !== "sent" : false;
  // ใบที่แอปยังไม่ยืนยันว่า "ส่งสำเร็จแล้ว" (submitted/queued/error) — เผื่อกรณีเช็คใน PEAK UI
  // เจอว่าจริง ๆ ออกใบไปแล้ว (ส่งผ่าน UI โดยตรง หรือ callback หลุดหาย) จะได้ยืนยันมือได้
  const canMarkSent = row ? row.display !== "sent" : false;

  return (
    <>
      <div className={"scrim" + (row ? " show" : "")} onClick={onClose} />
      <aside className={"side" + (row ? " open" : "")}>
        {row && (
          <>
            <div className="side-head">
              <div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-3)",
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                    fontWeight: 600,
                  }}
                >
                  ใบเสร็จ
                </div>
                <h3 className="mono" style={{ marginTop: 2 }}>
                  {row.code}
                </h3>
              </div>
              <button className="close" onClick={onClose} aria-label="close">
                <Icon.Close size={14} />
              </button>
            </div>
            <div className="side-body">
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <span className={"status " + DISPLAY_CLASS[row.display]}>{DISPLAY_LABEL[row.display]}</span>
                <span className={"type-chip " + row.contactType}>
                  {row.contactType === "juristic" ? "นิติบุคคล" : row.contactType === "ordinary" ? "บุคคลธรรมดา" : "ไม่ทราบ"}
                </span>
              </div>
              <dl className="kv">
                <dt>ลูกค้า</dt>
                <dd>{row.contactName || "-"}</dd>
                <dt>Contact code</dt>
                <dd className="mono">{row.contactCode || "-"}</dd>
                <dt>ที่อยู่</dt>
                <dd>{row.address || "-"}</dd>
                <dt>ตำบล/แขวง</dt>
                <dd>{row.subDistrict || "-"}</dd>
                <dt>อำเภอ/เขต</dt>
                <dd>{row.district || "-"}</dd>
                <dt>จังหวัด</dt>
                <dd>{row.province || "-"}</dd>
                <dt>รหัสไปรษณีย์</dt>
                <dd>{row.postCode || "-"}</dd>
                <dt>เลขผู้เสียภาษี</dt>
                <dd className="mono">{row.taxNumber || "-"}</dd>
                {row.branchCode && (
                  <>
                    <dt>สาขา</dt>
                    <dd>{branchLabel(row.branchCode)}</dd>
                  </>
                )}
                <dt>วันที่ออกใบ</dt>
                <dd>{row.issuedDate || "-"}</dd>
                <dt>ยอดสุทธิ</dt>
                <dd className="num">{fmtAmount(row.netAmount)}</dd>
                <dt>สถานะเอกสาร</dt>
                <dd>{row.docStatusLabel}</dd>
                <dt>ส่งล่าสุด</dt>
                <dd>{row.lastAttempt || "—"}</dd>
                {row.display !== "error" && row.noteText && (
                  <>
                    <dt>หมายเหตุ</dt>
                    <dd>{row.noteText}</dd>
                  </>
                )}
              </dl>

              {row.display === "error" && row.noteText && (
                <div className="error-block">
                  <div className="em">{row.noteText}</div>
                </div>
              )}

              {(selectable || row.pdfUrl || canMarkSent) && (
                <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
                  {selectable && (
                    <button className="btn primary" disabled={resending} onClick={() => onResend(row.code)}>
                      <Icon.Send size={14} /> ส่ง e-Tax ใบนี้
                    </button>
                  )}
                  {row.pdfUrl && (
                    <a className="btn" href={row.pdfUrl} target="_blank" rel="noopener noreferrer">
                      เปิดใบกำกับภาษี (PDF)
                    </a>
                  )}
                  {canMarkSent && (
                    <button className="btn ghost" disabled={resending} onClick={() => onMarkSent(row.code)}>
                      <Icon.Check size={14} /> ยืนยันว่าส่งแล้ว (เช็คใน PEAK UI)
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
