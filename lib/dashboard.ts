// ยูทิลิตี้ฝั่ง client สำหรับแดชบอร์ด (ไม่พึ่ง server-only code)
import type { Row } from "@/lib/receipts";

export type { Row };

export type FilterBucket = "sent" | "await" | "error";
export type DisplayStatus = "sent" | "submitted" | "queued" | "error";

export interface EtaxStatusEntry {
  status: "issued" | "failed" | "pending" | "unknown";
  resCode: string;
  message: string;
  timestamp: string;
  pdfUrl?: string;
}

export interface Classified {
  filterBucket: FilterBucket;
  display: DisplayStatus;
}

/**
 * จัดกลุ่มแถวเป็น 3 สถานะจริง: sent (ส่งสำเร็จ — รวม "submitted" ที่ PEAK รับคำขอแล้ว
 * resCode 200 ทันทีตอนส่ง กับ "sent" ที่ INET ยืนยันออกใบจริงแล้วทาง callback) / await
 * (ผ่านตรวจ ยังไม่เคยส่ง) / error (ไม่ผ่านตรวจสอบ contact หรือส่ง/ออกใบล้มเหลว)
 *
 * เดิม "รอ callback" (es.status==="pending") นับเป็น await/แสดง Pending (เหลือง) แต่ผู้ใช้
 * แจ้งว่ารอ callback จาก INET ช้ามาก อยากรู้ทันทีว่าส่งออกไปแล้ว — จึงนับเป็น sent bucket
 * (ขึ้น badge "Sent" ทันทีที่ PEAK ตอบรับ) แต่ยัง distinct ด้วย display="submitted" (สี
 * ต่างจาก "sent" ที่ยืนยันแล้วจริง) ไว้เผื่อ INET ปฏิเสธทีหลัง จะได้กลับไปเป็น error ได้
 * (ไม่ได้ล็อกเป็น sent ถาวรจนกว่าจะมี callback จริง — แค่ presentation ไม่ใช่ข้อมูลจริงเปลี่ยน)
 *
 * สำคัญ: ต้องเช็ค es.status==="issued" (ยืนยันออกใบสำเร็จแล้วจริง จาก callback หรือกดยืนยัน
 * มือ) "ก่อน" เช็ค row.valid เสมอ — row.valid สะท้อนผลตรวจสอบข้อมูล ณ ตอนดึงครั้งนี้เท่านั้น
 * ถ้าใบไหนเคยออกสำเร็จไปแล้วจริง แต่ข้อมูล ณ ตอนนี้ดันตรวจแล้วไม่ผ่าน (เช่น journal ถูกแก้/
 * ลบทีหลัง หรือ contact ถูกแก้ไขข้อมูลหลังจากส่งไปแล้ว) ก็ต้องยังโชว์ "Sent" อยู่ดี เพราะสิ่ง
 * ที่เกิดขึ้นจริงคือออกใบไปแล้ว ไม่ควรถูกข้อมูลปัจจุบันมาทำให้กลายเป็น Error ย้อนหลัง
 */
export function classifyRow(row: Row, es: EtaxStatusEntry | undefined): Classified {
  const st = es?.status;
  if (st === "issued") return { filterBucket: "sent", display: "sent" };
  if (!row.valid) return { filterBucket: "error", display: "error" };
  if (st === "pending") return { filterBucket: "sent", display: "submitted" };
  if (st === "failed") return { filterBucket: "error", display: "error" };
  return { filterBucket: "await", display: "queued" };
}

export const fmtAmount = (n: unknown) =>
  typeof n === "number"
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function parseYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const TH_MON_SHORT = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];
const TH_DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"];

export function thaiLong(d: Date): string {
  return `วัน${TH_DOW[d.getDay()]}ที่ ${d.getDate()} ${TH_MON_SHORT[d.getMonth()]} ${d.getFullYear() + 543}`;
}
export function thaiShort(d: Date): string {
  return `${d.getDate()} ${TH_MON_SHORT[d.getMonth()]} ${(d.getFullYear() + 543).toString().slice(-2)}`;
}
