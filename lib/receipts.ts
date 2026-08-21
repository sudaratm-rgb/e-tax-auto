import { settings } from "./config";
import { getCachedContactsBatch, setCachedContact } from "./contactCache";
import { safeDbWrite } from "./db";
import { PeakAPIError, PeakClient, type Contact, type Receipt } from "./peakClient";
import { validateContact } from "./validators";

// ค่า status param ของ /Receipts/list (ทดสอบกับ API จริง — ไม่ใช่ฟิลด์ status รายใบ
// ซึ่งคืน "Draft" ผิดสำหรับเลขที่ถูกใช้ซ้ำ). enum เต็ม: 1=Draft, 3=Approve, 4=Void
// แอปนี้ดึงเฉพาะ Approve(3) เท่านั้น — ไม่ดึง Draft/Void มาแสดงเลย
export const LIST_STATUS_APPROVE = 3;

function contactKey(receipt: Receipt): string {
  return receipt.contactId || receipt.contactCode || "";
}

/**
 * จำกัดจำนวนงานที่รันพร้อมกัน (เทียบเท่า ThreadPoolExecutor(max_workers=))
 * label (ถ้าใส่): log ความคืบหน้าลง console ทุก ๆ ~5% ของงาน — ช่วยแยกแยะระหว่าง "กำลังทำงาน
 * อยู่แต่ช้าเพราะข้อมูลเยอะ" กับ "ค้างจริง" ตอน debug ช่วงวันที่กว้างที่ใช้เวลานาน
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
  label?: string
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const total = items.length;
  let next = 0;
  let done = 0;
  const start = Date.now();
  const logEvery = Math.max(1, Math.ceil(total / 20));
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
      done++;
      if (label && (done % logEvery === 0 || done === total)) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[${label}] ${done}/${total} เสร็จแล้ว (${elapsed}s, concurrency=${workers})`);
      }
    }
  }
  if (label) console.log(`[${label}] เริ่ม ${total} รายการ (concurrency=${workers})`);
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker));
  return results;
}

/**
 * ขั้นที่ 2: ดึง contact ของใบเสร็จทั้งหมดแบบขนาน
 * ดึงเฉพาะ contact ที่ไม่ซ้ำ (1 วันมีได้ร้อยใบแต่ลูกค้าซ้ำกันมาก) และเช็ค cache ข้ามคำขอ
 * ก่อนเสมอ (ลูกค้าเดิมซ้ำกันข้ามวันที่ต่าง ๆ ด้วย ดู lib/contactCache.ts) — ยิง API จริง
 * เฉพาะ contact ที่ยังไม่เคย cache หรือ cache หมดอายุแล้วเท่านั้น
 * คืน map: contactKey -> contact (หรือ {__error__: ...} ถ้าดึงไม่ได้)
 */
export async function fetchContacts(
  client: PeakClient,
  receipts: Receipt[],
  workers: number = settings.CONTACT_FETCH_WORKERS,
  // true = ข้าม cache ทั้งหมด ถือว่าทุก contact ต้องดึงสดใหม่ (แต่ยังเขียนทับ cache ด้วยผล
  // ล่าสุดตามปกติ) ใช้ตอนผู้ใช้กด "รีเฟรช" เองหลังแก้ไขข้อมูล contact ใน PEAK มา
  forceRefresh: boolean = false
): Promise<Map<string, Contact | { __error__: string }>> {
  const unique = new Map<string, { code: string; id: string }>();
  for (const r of receipts) {
    const key = contactKey(r);
    if (key && !unique.has(key)) {
      unique.set(key, { code: r.contactCode ?? "", id: r.contactId ?? "" });
    }
  }

  console.log(`[contact] ${unique.size} contact ไม่ซ้ำจาก ${receipts.length} ใบเสร็จ — เริ่มเช็ค cache (batch)`);
  const cache = new Map<string, Contact | { __error__: string }>();
  let cachedMap = new Map<string, Contact>();
  if (!forceRefresh) {
    cachedMap = await getCachedContactsBatch([...unique.keys()]);
  }
  const toFetch: [string, { code: string; id: string }][] = [];
  for (const [key, ref] of unique.entries()) {
    const cached = cachedMap.get(key);
    if (cached !== undefined) {
      cache.set(key, cached);
    } else {
      toFetch.push([key, ref]);
    }
  }
  console.log(`[contact] cache hit ${cache.size}/${unique.size} — ต้องยิง PEAK จริง ${toFetch.length} ราย`);

  const fetched = await mapWithConcurrency(
    toFetch,
    workers,
    async ([key, ref]) => {
      try {
        const contact = (await client.getContact(ref.code, ref.id)) ?? {};
        setCachedContact(key, contact);
        return [key, contact] as const;
      } catch (exc) {
        const message = exc instanceof PeakAPIError ? exc.message : String(exc);
        return [key, { __error__: message }] as const; // ไม่ cache ผล error
      }
    },
    "contact"
  );
  for (const [key, contact] of fetched) cache.set(key, contact);
  return cache;
}

/**
 * ดึงชุดเลขที่ใบเสร็จที่ 'อนุมัติแล้ว' (list status=3) ในช่วงวันที่ — ใช้ list status param
 * เป็นตัวตัดสิน ไม่ใช้ฟิลด์ status รายใบ (GET /Receipts?code=) ที่เชื่อถือไม่ได้สำหรับเลขที่
 * ใบเสร็จใช้ซ้ำ (คืน "Draft" ผิดทั้งที่อนุมัติแล้วจริง)
 */
export async function fetchApprovedCodes(
  client: PeakClient,
  dateStart: string,
  dateEnd: string
): Promise<Set<string>> {
  const rows = await client.listAllReceipts(dateStart, dateEnd, LIST_STATUS_APPROVE);
  return new Set(rows.map((r) => r.code ?? ""));
}

export type ContactType = "juristic" | "ordinary" | "unknown";

/** จัดกลุ่ม contact.type จริงจาก PEAK เป็น นิติบุคคล (juristic) / บุคคลธรรมดา (ordinary) */
function contactTypeOf(contact: Contact): ContactType {
  const ctype = contact.type;
  if (settings.CONTACT_TYPES_INDIVIDUAL.has(ctype)) return "ordinary";
  if (settings.CONTACT_TYPES_FULL_TAX.has(ctype) || settings.CONTACT_TYPES_FULL_NOTAX.has(ctype)) {
    return "juristic";
  }
  return "unknown";
}

export interface Row {
  code: string;
  issuedDate: string;
  netAmount: unknown;
  contactCode: string;
  contactName: string;
  contactType: ContactType;
  // ฟิลด์ที่อยู่ + เลขผู้เสียภาษีดิบจาก contact — เก็บไว้แสดงในหน้ารายละเอียด เพื่อให้เห็น
  // ตรงตัวว่าฟิลด์ไหนขาด/ผิด แทนที่จะต้องเดาจากข้อความ reason อย่างเดียว
  address: string;
  subDistrict: string;
  district: string;
  province: string;
  postCode: string;
  taxNumber: string;
  // "00000" = สำนักงานใหญ่ (Head Office), รหัสอื่น = สาขา, ว่าง = ไม่มีข้อมูล (เช่น บุคคลธรรมดา)
  branchCode: string;
  // ลิงก์เปิดดูใบเสร็จนี้ในหน้าเว็บ PEAK โดยตรง (PEAK แนบมาให้ในทุกใบเสร็จอยู่แล้ว)
  documentLink: string;
  isTaxInvoice: unknown;
  alreadySent: boolean;
  docStatus: string;
  docStatusLabel: string;
  docStatusCss: string;
  valid: boolean;
  reason: string;
}

/**
 * สร้างแถวผลลัพธ์ 1 ใบจาก contact ที่ดึงมาแล้ว (ไม่เรียก API)
 * receipt ที่ส่งเข้ามาต้องมาจาก fetchApprovedCodes/listAllReceipts(status=Approve) แล้ว
 * เท่านั้น — docStatus จึงเป็น "Approve" เสมอโดยไม่ต้องเช็คซ้ำ
 *
 * ⚠️ ไม่เช็ค journal (บันทึกรับชำระ) — ถอดออกตั้งใจ (ทั้งตารางหลักและ Import Excel Report)
 * เพราะเช็คไม่ได้โดยไม่ยิง GET /Receipts?code= แยกทีละใบเพิ่ม (dedup ไม่ได้เหมือน contact)
 * ซึ่งช้ามากตอนช่วงวันที่กว้าง — /api/send-etax ตอนกดส่งจริงก็ไม่เช็ค journal เช่นกัน ยังตรวจ
 * แค่ Approve ซ้ำเสมอ (คนละเงื่อนไข) เท่ากับว่าไม่มีจุดไหนในระบบเช็คสถานะชำระเงินก่อนส่งอีก
 * ต่อไปแล้ว (remainAmount ก็ไม่น่าเชื่อถือ ถูกถอดไปก่อนหน้านี้แล้วเช่นกัน — ดู README)
 *
 * ⚠️ ใบที่ส่งสำเร็จแล้ว (alreadySent) ข้ามการตรวจ contact ไปเลย ไม่เรียก validateContact —
 * ตัดสินใจ "ส่งได้ไหม" ไปแล้วจริง (ส่งซ้ำไม่ได้อยู่แล้วถ้าไม่ force) contact ในนี้อาจไม่ถูกดึง
 * มาด้วยซ้ำ (ดู /api/fetch ที่ข้ามการดึง contact ให้ใบกลุ่มนี้ไปเลยเพื่อความเร็ว) ถ้าไม่
 * short-circuit ตรงนี้ก่อน จะได้ผล "ไม่ผ่าน" ปลอม ๆ จาก contact ว่างเปล่า ทั้งที่จริง ๆ คือ
 * ไม่ได้ตรวจต่างหาก ไม่ใช่ปัญหาข้อมูลจริง
 */
export function buildRow(
  receipt: Receipt,
  contactCache: Map<string, Contact | { __error__: string }>,
  sent: Set<string>
): Row {
  const code = receipt.code ?? "";
  const alreadySent = sent.has(code);
  const contact = contactCache.get(contactKey(receipt)) ?? {};
  const row: Row = {
    code,
    issuedDate: receipt.issuedDate ?? "",
    netAmount: receipt.netAmount,
    contactCode: (contact as Contact).code ?? receipt.contactCode ?? "",
    contactName: (contact as Contact).name ?? "",
    contactType: "__error__" in contact ? "unknown" : contactTypeOf(contact as Contact),
    address: (contact as Contact).address ?? "",
    subDistrict: (contact as Contact).subDistrict ?? "",
    district: (contact as Contact).district ?? "",
    province: (contact as Contact).province ?? "",
    postCode: (contact as Contact).postCode ?? "",
    taxNumber: (contact as Contact).taxNumber ?? "",
    branchCode: (contact as Contact).branchCode ?? "",
    documentLink: receipt.documentLink ?? "",
    isTaxInvoice: receipt.isTaxInvoice,
    alreadySent,
    docStatus: "Approve",
    docStatusLabel: "Approve",
    docStatusCss: "approve",
    valid: false,
    reason: "",
  };

  if (alreadySent) {
    row.valid = true;
    row.reason = "เคยส่ง e-Tax สำเร็จแล้ว";
    return row;
  }

  const problems: string[] = [];
  let okReason = "";

  if ("__error__" in contact) {
    problems.push(`ตรวจ contact ไม่สำเร็จ: ${(contact as { __error__: string }).__error__}`);
  } else {
    const [contactValid, contactReason] = validateContact(contact as Contact);
    if (!contactValid) problems.push(contactReason);
    else okReason = contactReason;
  }

  row.valid = problems.length === 0;
  row.reason = problems.length ? problems.join(" | ") : okReason;
  return row;
}

/**
 * บันทึกผลตรวจใบเสร็จทุกแถวลง PostgreSQL (ตาราง receipt_checks) แบบ append-only — เป็น
 * audit trail เสริม ไม่ใช่แหล่งความจริงหลัก (ดู safeDbWrite ใน lib/db.ts) เรียกหลังจาก
 * /api/fetch ประมวลผล rows เสร็จทุกครั้ง เพื่อเก็บประวัติว่าใบไหนเคยมีสถานะอะไรตอนไหนบ้าง
 * — คำถามที่ PEAK เองตอบไม่ได้ และ .jsonl เดิมก็ไม่มีข้อมูลแบบนี้
 */
export async function logReceiptChecks(rows: Row[]): Promise<void> {
  if (!rows.length) return;
  await safeDbWrite(async (db) => {
    const cols = 10;
    const values: unknown[] = [];
    const placeholders = rows.map((r, i) => {
      const base = i * cols;
      values.push(
        r.code,
        r.issuedDate,
        typeof r.netAmount === "number" ? r.netAmount : null,
        r.contactCode,
        r.contactName,
        r.contactType,
        r.docStatus,
        r.alreadySent,
        r.valid,
        r.reason
      );
      const ph = Array.from({ length: cols }, (_, j) => `$${base + j + 1}`).join(", ");
      return `(${ph})`;
    });
    await db.query(
      `INSERT INTO receipt_checks
        (code, issued_date, net_amount, contact_code, contact_name, contact_type, doc_status, already_sent, valid, reason)
       VALUES ${placeholders.join(", ")}`,
      values
    );
  });
}
