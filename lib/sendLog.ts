/**
 * บันทึกผลการส่ง e-Tax ลง PostgreSQL (ตาราง send_log/etax_callbacks) เพื่อ:
 *   - กันการส่งซ้ำ (ใบที่เคยส่งสำเร็จแล้วจะถูกข้าม)
 *   - เก็บประวัติไว้ตรวจย้อนหลัง
 *
 * หมายเหตุ: PEAK ออกใบผ่าน INET แบบ async และ taxStatus ฝั่ง PEAK ไม่อัปเดตทันที
 * จึงใช้ log ฝั่งเราเป็นแหล่งความจริงสำหรับ "ใบนี้เคยส่งสำเร็จแล้วหรือยัง"
 *
 * เดิมเขียนลงไฟล์ .jsonl เป็นแหล่งความจริงหลัก (Postgres เป็นแค่ audit mirror คู่ขนาน) —
 * เปลี่ยนมาใช้ Postgres เป็นแหล่งความจริงหลักแทน เพราะ deploy บน Vercel แล้ว filesystem ของ
 * โปรเจกต์ read-only ตอนรันจริง (เขียนไฟล์ไม่ได้อีกต่อไป) ต่างจาก audit table อื่น (เช่น
 * receipt_checks) การเขียนที่นี่ "ต้องสำเร็จจริง" ถ้า insert พลาดจะ throw ต่อ ไม่กลืน error
 * ทิ้งแบบ safeDbWrite เพราะ Postgres เป็นสำเนาเดียวของ "ใบนี้เคยส่งแล้วหรือยัง" ถ้าเขียนพลาด
 * แล้วเงียบไว้ เสี่ยงส่งซ้ำซ้อนจริง (มีผลทางภาษี)
 */
import { getDb } from "./db";

export interface SentLogEntry {
  timestamp: string;
  timestampUtc: string;
  code: string;
  success: boolean;
  resCode: string;
  resDesc: string;
  phase: "accepted" | "callback";
  // ลิงก์เอกสาร e-Tax จริงจาก field `eTaxInvoice` ใน callback ตอนออกใบสำเร็จ (phase=callback)
  pdfUrl?: string;
  pdfA3Url?: string;
  xmlUrl?: string;
}

export interface SentDocuments {
  pdfUrl?: string;
  pdfA3Url?: string;
  xmlUrl?: string;
}

export interface CallbackLogEntry {
  receivedAt: string;
  code: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

function nowLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

/**
 * บันทึก payload ที่ PEAK/INET ยิงกลับมา (ผลออกใบจริง) ลงตาราง etax_callbacks
 * keyReference = code ของใบ (PEAK ส่งกลับมาใน header Key-Reference) เพื่อผูกกับใบ
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recordCallback(payload: any, keyReference: string = ""): Promise<void> {
  const db = await getDb();
  await db.query("INSERT INTO etax_callbacks (code, payload, received_at) VALUES ($1, $2, now())", [
    keyReference || null,
    JSON.stringify(payload),
  ]);
}

/** รายการผล callback ล่าสุด (ใหม่สุดอยู่บน) */
export async function recentCallbacks(limit: number = 200): Promise<CallbackLogEntry[]> {
  const db = await getDb();
  const res = await db.query<{ code: string | null; payload: unknown; received_at: Date }>(
    "SELECT code, payload, received_at FROM etax_callbacks ORDER BY received_at DESC LIMIT $1",
    [limit]
  );
  return res.rows.map((r) => ({
    receivedAt: nowLocal(r.received_at),
    code: r.code ?? "",
    payload: r.payload,
  }));
}

/**
 * บันทึกผลการส่ง 1 รายการ
 * phase: "accepted" = ตอนกดส่ง (PEAK รับคำขอ resCode 200) ยังไม่รู้ผลออกใบจริง
 *        "callback"  = ผลออกใบจริงจาก INET (success/fail แน่นอนแล้ว)
 */
export async function record(
  code: string,
  success: boolean,
  resCode: string = "",
  resDesc: string = "",
  phase: "accepted" | "callback" = "accepted",
  documents?: SentDocuments
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO send_log (code, success, res_code, res_desc, phase, pdf_url, pdf_a3_url, xml_url, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      code,
      success,
      String(resCode),
      resDesc,
      phase,
      documents?.pdfUrl ?? null,
      documents?.pdfA3Url ?? null,
      documents?.xmlUrl ?? null,
    ]
  );
}

interface SendLogRow {
  code: string;
  success: boolean;
  res_code: string;
  res_desc: string;
  phase: "accepted" | "callback";
  pdf_url: string | null;
  pdf_a3_url: string | null;
  xml_url: string | null;
  created_at: Date;
}

function rowToEntry(r: SendLogRow): SentLogEntry {
  return {
    timestamp: nowLocal(r.created_at),
    timestampUtc: r.created_at.toISOString().replace(/\.\d+Z$/, "Z"),
    code: r.code,
    success: r.success,
    resCode: r.res_code,
    resDesc: r.res_desc,
    phase: r.phase,
    ...(r.pdf_url ? { pdfUrl: r.pdf_url } : {}),
    ...(r.pdf_a3_url ? { pdfA3Url: r.pdf_a3_url } : {}),
    ...(r.xml_url ? { xmlUrl: r.xml_url } : {}),
  };
}

/**
 * เซ็ตของ code ที่ 'ออกใบสำเร็จ' (resCode 200) — ใช้ entry 'ล่าสุดต่อ code' เป็นตัวตัดสิน
 * เพื่อให้ผล callback จาก INET (เช่น 303 fail) override สถานะ "รับคำขอ" ตอนส่งได้
 */
export async function sentCodes(): Promise<Set<string>> {
  const db = await getDb();
  const res = await db.query<{ code: string; success: boolean; res_code: string }>(
    `SELECT DISTINCT ON (code) code, success, res_code
     FROM send_log ORDER BY code, created_at DESC`
  );
  return new Set(res.rows.filter((r) => r.success && r.res_code === "200").map((r) => r.code));
}

/** รายการล่าสุด (ใหม่สุดอยู่บน) สำหรับแสดงประวัติ */
export async function recent(limit: number = 200): Promise<SentLogEntry[]> {
  const db = await getDb();
  const res = await db.query<SendLogRow>("SELECT * FROM send_log ORDER BY created_at DESC LIMIT $1", [limit]);
  return res.rows.map(rowToEntry);
}

/** entry การส่งล่าสุดต่อ code (รวมผลที่ callback บันทึกทับ phase=callback) */
export async function latestSendByCode(): Promise<Map<string, SentLogEntry>> {
  const db = await getDb();
  const res = await db.query<SendLogRow>(
    `SELECT DISTINCT ON (code) *
     FROM send_log ORDER BY code, created_at DESC`
  );
  const out = new Map<string, SentLogEntry>();
  for (const row of res.rows) out.set(row.code, rowToEntry(row));
  return out;
}
