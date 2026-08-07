import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getPeakClient, PeakAPIError } from "@/lib/peakClient";
import { buildRow, fetchContacts, mapWithConcurrency } from "@/lib/receipts";
import { setCachedReceiptJournal } from "@/lib/receiptDetailCache";
import * as sendLog from "@/lib/sendLog";
import type { Receipt } from "@/lib/peakClient";

/**
 * รับไฟล์รายงานที่ export จากหน้าเว็บ PEAK เอง (.xlsx) มา parse — ใช้เป็นแหล่งความจริงสำรอง
 * สำหรับดูสถานะส่ง e-Tax (Sent/Await) เพราะ PEAK Open API ไม่มี endpoint ให้เช็คสถานะนี้
 * โดยตรงเลย (ตรวจสอบมาหลายทางแล้วในเซสชันนี้ — ไม่มีจริง ๆ)
 *
 * ทำ 2 อย่าง:
 *   1) แถวที่ "ยังไม่ส่ง" (Await) — ตรวจสอบข้อมูล contact + journal เหมือนตารางหลักทุก
 *      ประการ (ใช้ buildRow ตัวเดียวกันเป๊ะ) ก่อนคืนให้ฝั่ง client ตัดสินใจว่าติ๊กส่งได้ไหม
 *      กันไม่ให้ส่งใบที่ข้อมูลไม่ครบ/ผิด (เช่น เลขผู้เสียภาษีผิดรูปแบบ) ผ่านทางลัดนี้ไปได้
 *   2) แถวที่ "ส่งแล้ว" (Sent) ตามรายงาน — เทียบกับ sent_log ของเราเอง หาใบที่เรายังไม่มี
 *      ประวัติว่าส่งแล้ว (เช่น ส่งผ่าน PEAK UI โดยตรง) คืนรายชื่อไว้ให้ sync/บันทึกลง DB ได้
 *
 * รองรับ 2 รูปแบบรายงานที่ PEAK มี ซึ่งหัวคอลัมน์คนละภาษากัน (อังกฤษ/ไทย) แม้ตำแหน่งคอลัมน์
 * จะตรงกันพอดี แต่กันไว้ด้วยชื่อ ไม่ใช้ index ตายตัว เผื่อ PEAK สลับลำดับคอลัมน์ทีหลัง:
 *   - "Tax Invoice Report" (sale_taxInvoice_report_export...) หัวคอลัมน์อังกฤษ
 *   - "Receipt Report" / รายงานใบเสร็จรับเงิน (receipt_report_export...) หัวคอลัมน์ไทย
 *
 * หา header row แบบไดนามิก (หา column ที่ตรงกับชื่อที่รู้จัก) แทนที่จะ fix แถวตายตัว เผื่อ
 * PEAK เปลี่ยนรูปแบบไฟล์ทีหลัง (มี metadata หลายแถวก่อนถึง header จริง)
 */

const COLUMN_ALIASES = {
  docNo: ["Document No.", "เลขที่เอกสาร"],
  issueDate: ["Issue Date", "วันที่ออก"],
  status: ["Status", "สถานะ"],
  customerName: ["Customer Name", "ชื่อลูกค้า"],
  taxId: ["Tax ID", "เลขที่ 13 หลัก"],
  grandTotal: ["Grand Total", "ทั้งหมด"],
  statusEDoc: ["Status e-Doc", "สถานะเอกสารอิเล็กทรอนิกส์"],
} as const;

const AWAIT_VALUES = new Set(["Await", "ยังไม่ส่ง"]);
const SENT_VALUES = new Set(["Sent", "ส่งแล้ว"]);

// เอาเฉพาะเอกสารที่ "จ่ายแล้ว/สมบูรณ์แล้ว" เท่านั้น (ตัด Draft/Voided ออก) — สแกนไฟล์จริงกว่า
// 50 ไฟล์ (ก.ย. 2025 - ส.ค. 2026) เจอค่าที่ใช้จริงทั้งหมด: "Paid"/"รับชำระแล้ว" (Receipt
// Report ปนกันทั้งอังกฤษ/ไทยตามภาษาที่ export ตอนนั้น) และ "Issued" (Tax Invoice Report,
// พบแต่แบบอังกฤษ) ส่วน "Draft"/"ร่าง" และ "Voided" ตั้งใจไม่ใส่ไว้ในนี้ (ยังไม่พร้อมส่ง/
// ถูกยกเลิกแล้ว) — ใช้วิธี allow-list (ไม่ใช่ block-list) ตั้งใจ เพื่อให้ค่าที่ไม่รู้จักใน
// อนาคต (เผื่อ PEAK เพิ่ม status ใหม่) ถูกกันไว้ก่อนโดย default แทนที่จะหลุดผ่านไปโดยไม่ตั้งใจ
const READY_STATUS_VALUES = new Set(["Paid", "รับชำระแล้ว", "Issued"]);

function findColumnIndex(header: string[], aliases: readonly string[]): number {
  for (const name of aliases) {
    const idx = header.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

// ไฟล์รายงานเต็มเดือนวัดจริงแล้วใช้เวลาหลักนาที (ต้องยิง GET /Receipts?code= แยกทีละใบที่
// "ยังไม่ส่ง" ทุกใบ ไม่ dedup ได้เหมือน contact) — ค่า default ของ Vercel สั้นเกินไป
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "ไม่พบไฟล์" }, { status: 400 });
  }

  let json: unknown[][];
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];
  } catch {
    return NextResponse.json({ error: "อ่านไฟล์ไม่สำเร็จ — ต้องเป็นไฟล์ .xlsx ที่ export จาก PEAK เท่านั้น" }, { status: 400 });
  }

  const statusEDocAliases = COLUMN_ALIASES.statusEDoc;
  const headerRowIdx = json.findIndex(
    (row) => Array.isArray(row) && statusEDocAliases.some((name) => row.includes(name))
  );
  if (headerRowIdx === -1) {
    return NextResponse.json(
      {
        error:
          "ไม่พบรูปแบบไฟล์รายงานที่รู้จัก (หาคอลัมน์สถานะ e-Doc ไม่เจอ) — ต้องเป็นไฟล์ Tax Invoice Report หรือ Receipt Report ที่ export จาก PEAK",
      },
      { status: 400 }
    );
  }
  const header = json[headerRowIdx] as string[];
  const idx = {
    docNo: findColumnIndex(header, COLUMN_ALIASES.docNo),
    issueDate: findColumnIndex(header, COLUMN_ALIASES.issueDate),
    status: findColumnIndex(header, COLUMN_ALIASES.status),
    customerName: findColumnIndex(header, COLUMN_ALIASES.customerName),
    taxId: findColumnIndex(header, COLUMN_ALIASES.taxId),
    grandTotal: findColumnIndex(header, COLUMN_ALIASES.grandTotal),
    statusEDoc: findColumnIndex(header, COLUMN_ALIASES.statusEDoc),
  };
  if (idx.docNo === -1) {
    return NextResponse.json(
      { error: "ไม่พบคอลัมน์เลขที่เอกสารในไฟล์นี้ — รูปแบบไฟล์อาจไม่ตรงที่รองรับ" },
      { status: 400 }
    );
  }

  interface RawRow {
    code: string;
    issueDate: string;
    status: string;
    customerName: string;
    taxId: string;
    grandTotal: unknown;
    statusEDoc: string;
  }
  const awaitRaw: RawRow[] = [];
  // แถวที่ไฟล์บอกว่า "ส่งแล้ว" — เก็บข้อมูลดิบจากไฟล์ไว้แสดงผลด้วยเลย (ไม่ต้องยิง PEAK เพิ่ม
  // เพราะไม่ต้องตรวจสอบ contact/journal อีกแล้ว ส่งสำเร็จไปแล้วจริง) ไฟล์เต็มเดือนมีเป็นพัน
  // แถว ถ้ายิง API เพิ่มทุกแถวจะช้าเกินไปมาก และไม่จำเป็นด้วย
  const sentRaw: RawRow[] = [];
  for (let i = headerRowIdx + 1; i < json.length; i++) {
    const r = json[i];
    if (!Array.isArray(r) || !r.length || !r[idx.docNo]) continue;
    const code = String(r[idx.docNo] ?? "");
    const statusEDoc = String(r[idx.statusEDoc] ?? "").trim();
    const rawRow: RawRow = {
      code,
      issueDate: String(r[idx.issueDate] ?? ""),
      status: String(r[idx.status] ?? "").trim(),
      customerName: String(r[idx.customerName] ?? ""),
      taxId: String(r[idx.taxId] ?? ""),
      grandTotal: r[idx.grandTotal],
      statusEDoc,
    };
    if (SENT_VALUES.has(statusEDoc)) {
      sentRaw.push(rawRow);
      continue;
    }
    if (!AWAIT_VALUES.has(statusEDoc)) continue;
    if (!READY_STATUS_VALUES.has(rawRow.status)) continue; // ตัด Draft/อื่น ๆ ออก เอาแค่จ่ายแล้ว/สมบูรณ์แล้ว
    awaitRaw.push(rawRow);
  }
  const sentCodesInFile = sentRaw.map((r) => r.code);

  // ตรวจสอบข้อมูล contact + journal ของแถว "ยังไม่ส่ง" ทุกใบ เหมือนตารางหลักทุกประการ
  // (ใช้ buildRow ตัวเดียวกัน) ก่อนอนุญาตให้ติ๊กส่งได้ — ไฟล์ Excel มีแค่ชื่อลูกค้า/เลขภาษี
  // ดิบ ไม่พอตรวจสอบเอง ต้องดึงใบเสร็จเต็ม + contact จาก PEAK จริงมาเช็ค
  // concurrency ต่ำกว่าปกติ (6 แทน 12) เพราะยิง /Receipts?code= ทีละใบไม่ dedup ได้เลย
  // (ต่างจาก contact) — ยิงถี่เกินไปเสี่ยงชน Client-Token ของ PEAK เอง (resCode 600)
  const client = getPeakClient();
  const receiptResults = await mapWithConcurrency(awaitRaw, 6, async (row) => {
    try {
      const receipt = await client.getReceipt(row.code);
      return { receipt, error: null as string | null };
    } catch (exc) {
      const message = exc instanceof PeakAPIError ? exc.message : String(exc);
      return { receipt: null as Receipt | null, error: message };
    }
  });
  const validReceipts = receiptResults.map((r) => r.receipt).filter((r): r is Receipt => r !== null);
  // forceRefresh=true เสมอ — ฟีเจอร์นี้ใช้ตัดสิน "ส่งได้ไหม" ก่อนส่งจริง ความถูกต้องสำคัญ
  // กว่าความเร็ว ถ้าใช้ cache 15 นาทีเหมือนตารางหลัก จะเจอปัญหาว่าเพิ่งแก้ไขข้อมูล contact
  // ใน PEAK มา (เช่น แก้เลขผู้เสียภาษี) แต่ import ซ้ำยังเห็นข้อมูลเก่าอยู่ ไม่ได้ผลจริง
  const contactCache = await fetchContacts(client, validReceipts, undefined, true);
  const journalMap = new Map<string, boolean | { __error__: string }>();
  for (let i = 0; i < awaitRaw.length; i++) {
    const { receipt, error } = receiptResults[i];
    if (!receipt) {
      journalMap.set(awaitRaw[i].code, { __error__: error ?? "ไม่พบใบเสร็จนี้ใน PEAK" });
      continue;
    }
    const hasJournal = Array.isArray(receipt.journals) && receipt.journals.length > 0;
    setCachedReceiptJournal(awaitRaw[i].code, hasJournal);
    journalMap.set(awaitRaw[i].code, hasJournal);
  }
  const sent = await sendLog.sentCodes();

  const awaitRows = awaitRaw.map((row, i) => {
    const { receipt, error } = receiptResults[i];
    if (!receipt) {
      return {
        ...row,
        documentLink: "",
        alreadySent: false,
        valid: false,
        checkReason: error ? `ตรวจสอบใบเสร็จไม่สำเร็จ: ${error}` : "ไม่พบใบเสร็จนี้ใน PEAK (อาจถูกลบ/void ไปแล้ว)",
      };
    }
    const documentLink = receipt.documentLink ?? "";
    const built = buildRow(receipt, contactCache, sent, journalMap);
    // ใบนี้มาจากรายงาน PEAK ที่ยืนยันแล้วว่า "ยังไม่ส่ง" (Await) แต่ log ของเราเองดัน
    // คิดว่าเคยส่งสำเร็จแล้ว (alreadySent) — เป็นไปได้แค่กรณีเดียว: เคยยิงคำขอไปแล้ว PEAK
    // ตอบรับ (resCode 200) แต่ไม่เคยได้ callback ยืนยันผลจริงกลับมา (เช่น ตอน tunnel ล่ม)
    // เชื่อรายงาน PEAK (ground truth) มากกว่า log ตัวเอง — ต้องส่งซ้ำแบบ force เพื่อข้าม
    // เช็ค "เคยส่งแล้ว" ของเราเอง ไม่งั้น /api/send-etax จะข้ามใบนี้ไปเฉย ๆ
    if (built.alreadySent) {
      return {
        ...row,
        documentLink,
        alreadySent: false,
        valid: true,
        checkReason: "ระบบเราคิดว่าเคยส่งสำเร็จแล้ว แต่รายงาน PEAK ยืนยันว่ายังไม่ส่งจริง (อาจไม่เคยได้รับ callback ยืนยันผล) — ต้องส่งซ้ำแบบบังคับ",
      };
    }
    return { ...row, documentLink, alreadySent: false, valid: built.valid, checkReason: built.reason };
  });

  // แถวที่ไฟล์บอกว่า "ส่งแล้ว" — ไม่ต้องตรวจสอบ/ยิง PEAK เพิ่ม แสดงข้อมูลดิบจากไฟล์ไปเลย
  // (documentLink ว่างไว้ ไม่คุ้มยิง API เพิ่มอีกเป็นพันครั้งแค่เพื่อลิงก์ใบที่ส่งไปแล้ว)
  const sentRows = sentRaw.map((row) => ({
    ...row,
    documentLink: "",
    alreadySent: true,
    valid: false,
    checkReason: "ส่งสำเร็จแล้ว (ตามรายงาน PEAK)",
  }));

  const rows = [...awaitRows, ...sentRows];

  // เทียบใบที่รายงานบอกว่า "ส่งแล้ว" กับ log ของเราเอง — ใบไหนเรายังไม่มีประวัติว่าส่งสำเร็จ
  // (เช่น ส่งผ่าน PEAK UI ตรง ๆ ไม่ผ่านแอปนี้) ให้ไว้ sync/บันทึกทับสถานะได้
  const needsReconcile = [...new Set(sentCodesInFile)].filter((code) => !sent.has(code));

  const totalDataRows = json.length - headerRowIdx - 1;
  return NextResponse.json({
    total: totalDataRows,
    awaitCount: awaitRows.length,
    rows,
    sentInFileCount: sentCodesInFile.length,
    needsReconcile,
  });
}
