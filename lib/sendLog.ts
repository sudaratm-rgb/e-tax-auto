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
import type { ContactType } from "./receipts";

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
  // ชื่อ/ประเภทลูกค้า ณ ตอนบันทึก — client แนบมาให้ตอนกดส่ง/ยืนยันด้วยมือ (จากข้อมูลที่ตาราง
  // หลักดึงมาแล้วในรอบนั้น หรือจากไฟล์ Excel ตอน sync) เก็บไว้เพราะใบที่ส่งสำเร็จแล้วตอนนี้
  // ไม่ถูกดึง contact ซ้ำอีก (ดู lib/receipts.ts) ไม่งั้นข้อมูลนี้จะหายไปเลย
  contactName?: string;
  contactType?: ContactType;
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
 * extra.contactName/contactType: client แนบมาให้เท่านั้น (ตอนกดส่งจริงหรือยืนยันด้วยมือ) —
 * เก็บไว้เผื่อดูย้อนหลัง เพราะใบที่ส่งสำเร็จแล้วตอนนี้ไม่ถูกดึง contact ซ้ำอีก (ดู lib/receipts.ts)
 */
export async function record(
  code: string,
  success: boolean,
  resCode: string = "",
  resDesc: string = "",
  phase: "accepted" | "callback" = "accepted",
  extra?: { documents?: SentDocuments; contactName?: string; contactType?: ContactType }
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO send_log (code, success, res_code, res_desc, phase, pdf_url, pdf_a3_url, xml_url, contact_name, contact_type, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      code,
      success,
      String(resCode),
      resDesc,
      phase,
      extra?.documents?.pdfUrl ?? null,
      extra?.documents?.pdfA3Url ?? null,
      extra?.documents?.xmlUrl ?? null,
      extra?.contactName || null,
      extra?.contactType || null,
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
  contact_name: string | null;
  contact_type: ContactType | null;
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
    ...(r.contact_name ? { contactName: r.contact_name } : {}),
    ...(r.contact_type ? { contactType: r.contact_type } : {}),
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

/**
 * map code -> {name, type} ของใบที่ 'ออกใบสำเร็จ' ที่มีข้อมูลนี้บันทึกไว้เท่านั้น — client แนบ
 * มาให้ตอนกดส่งจริง (จากข้อมูลที่ตารางหลักดึงมาแล้ว) หรือตอนยืนยันด้วยมือ (จากไฟล์ Excel ตอน
 * sync) ใช้เป็น fallback แสดงในตารางหลัก ให้ใบที่ตอนนี้ข้ามการดึง contact ไปแล้ว (ดู buildRow
 * ใน lib/receipts.ts) ยังพอมีชื่อ/ประเภทให้เห็นได้บ้าง แทนที่จะว่างเปล่า/"ไม่ทราบ" เสมอ
 *
 * ⚠️ กรอง WHERE contact_name/contact_type IS NOT NULL ก่อนเลือก 'ล่าสุดต่อ code' — ตั้งใจ
 * ไม่ใช้ entry ล่าสุดเฉยๆ เพราะ entry ที่มาทีหลัง (เช่น callback จาก INET) มักไม่มีข้อมูลนี้
 * แนบมาด้วย ถ้าเลือกแค่ล่าสุดตรง ๆ จะได้ null ทับข้อมูลที่เคยมีจริงจาก entry ก่อนหน้า
 */
export async function sentContactInfo(): Promise<Map<string, { name?: string; type?: ContactType }>> {
  const db = await getDb();
  const res = await db.query<{ code: string; contact_name: string | null; contact_type: ContactType | null }>(
    `SELECT DISTINCT ON (code) code, contact_name, contact_type
     FROM send_log
     WHERE success = true AND res_code = '200' AND (contact_name IS NOT NULL OR contact_type IS NOT NULL)
     ORDER BY code, created_at DESC`
  );
  const out = new Map<string, { name?: string; type?: ContactType }>();
  for (const r of res.rows) {
    out.set(r.code, { name: r.contact_name ?? undefined, type: r.contact_type ?? undefined });
  }
  return out;
}

/**
 * เติมชื่อ/ประเภทลูกค้าให้ entry ล่าสุดของ code ที่ยังไม่เคยมีข้อมูลนี้เลย — ใช้ตอน /api/fetch
 * เจอใบที่ส่งไปแล้วแต่ไม่เคยมีชื่อ/ประเภทบันทึกไว้เลย (เช่น ส่งไปก่อนฟีเจอร์นี้จะมี หรือส่งผ่าน
 * PEAK UI ตรง ๆ ไม่เคย sync) หลังดึง contact มาครั้งแรกเพื่อ backfill (ดู docstring ใน
 * app/api/fetch/route.ts)
 *
 * ⚠️ ใช้ UPDATE ทับ entry ล่าสุดที่มีอยู่แล้ว **ไม่ insert แถวใหม่** ต่างจาก record() — เพราะนี่
 * ไม่ใช่เหตุการณ์ส่ง/callback ใหม่จริง ๆ แค่เติมข้อมูลที่ขาดไปให้ entry เดิม ถ้า insert แถวใหม่
 * (phase=callback, resDesc="Backfill") แถวนั้นจะกลายเป็น entry ล่าสุด แล้วไปทับข้อความสถานะ
 * จริง (เช่น "Success") ที่หน้าเว็บใช้แสดงในคอลัมน์หมายเหตุ ทำให้ผู้ใช้เห็นข้อความผิดเพี้ยน
 */
export async function backfillContactInfo(code: string, name?: string, type?: ContactType): Promise<void> {
  if (!name && !type) return;
  const db = await getDb();
  await db.query(
    `UPDATE send_log SET contact_name = COALESCE(contact_name, $2), contact_type = COALESCE(contact_type, $3)
     WHERE id = (SELECT id FROM send_log WHERE code = $1 ORDER BY created_at DESC LIMIT 1)`,
    [code, name || null, type || null]
  );
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
