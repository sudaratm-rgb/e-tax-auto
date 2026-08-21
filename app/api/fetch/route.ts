import { NextRequest, NextResponse } from "next/server";
import { getPeakClient, PeakAPIError } from "@/lib/peakClient";
import { buildRow, fetchContacts, LIST_STATUS_APPROVE, logReceiptChecks } from "@/lib/receipts";
import * as sendLog from "@/lib/sendLog";

// ช่วงวันที่กว้าง (เช่น 10 วัน) วัดจริงแล้วใช้เวลาได้ถึงหลักนาที (contact ที่ไม่เคย cache มา
// ก่อนต้องยิง PEAK ทีละตัว) — ค่า default ของ Vercel serverless function สั้นเกินไป
export const maxDuration = 300;

/**
 * ขั้นที่ 1+2: ดึงใบเสร็จที่อนุมัติแล้ว (Approve) ตามวันที่ แล้วตรวจ contact เฉพาะใบที่
 * "ยังไม่เคยส่ง e-Tax สำเร็จ" เท่านั้น
 *
 * ⚠️ ใบที่ส่งสำเร็จแล้วข้ามการดึง/ตรวจ contact ไปเลย — ตัดสินใจ "ส่งได้ไหม" ไปแล้วจริง
 * (ส่งซ้ำไม่ได้อยู่แล้วถ้าไม่ force) ไม่มีประโยชน์ต้องตรวจซ้ำอีก และช่วงวันที่ที่ดึงซ้ำบ่อย ๆ
 * มักมีใบส่งแล้วเยอะกว่าใบใหม่มาก การข้ามขั้นนี้ลดจำนวน contact ที่ต้องดึง/เช็ค cache ได้เยอะ
 * (ดู buildRow ใน lib/receipts.ts ที่ short-circuit ไม่เรียก validateContact ให้ใบกลุ่มนี้)
 *
 * ⚠️ ยกเว้นใบที่ส่งแล้วแต่ **ไม่เคยมีชื่อ/ประเภทลูกค้าบันทึกไว้เลย** (เช่น ส่งไปก่อนฟีเจอร์นี้
 * จะมี หรือส่งผ่าน PEAK UI ตรง ๆ ไม่เคย sync) — กลุ่มนี้ยังต้องดึง contact ครั้งแรกอยู่ดี (ไม่งั้น
 * ตารางหลักไม่มีทางรู้ชื่อ/ประเภทเลย) แต่ดึงแค่ **ครั้งเดียว** แล้ว backfill ลง send_log ทันที
 * ครั้งต่อไปจะเจอใน sentContactInfo() แล้วไม่ต้องดึงซ้ำอีก — เป็นการ "จ่ายครั้งเดียว" ต่างจาก
 * ใบที่ backfill ไปแล้วซึ่งจะเร็วตลอดไป
 *
 * ⚠️ ไม่เช็ค journal (บันทึกรับชำระ) เลยไม่ว่าจุดไหนในระบบ — ตั้งใจถอดออกหมด (ทั้งตารางหลัก
 * และ Import Excel Report) เพราะเช็คไม่ได้โดยไม่ยิง GET /Receipts?code= แยกทีละใบเพิ่ม (dedup
 * ไม่ได้เหมือน contact) ซึ่งเป็นคอขวดหลักตอนดึงช่วงวันที่กว้าง (นับพันใบ = ต้องยิงนับพันครั้ง)
 * — `/api/send-etax` ตอนกดส่งจริงก็ไม่เคยเช็ค journal เช่นกัน ยังตรวจแค่ Approve ซ้ำเหมือนเดิม
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const dateStart: string = body.dateStart; // YYYYMMDD
  const dateEnd: string = body.dateEnd; // YYYYMMDD
  // true = ข้าม cache contact ทั้งหมด ดึงสดจาก PEAK ใหม่ทุกราย — ใช้ตอนกดปุ่ม "รีเฟรช" เอง
  // เผื่อเพิ่งแก้ไขข้อมูล contact ใน PEAK มา แล้วอยากเห็นผลทันทีโดยไม่ต้องรอ cache หมดอายุ
  // (ปกติ cache อยู่ได้ 15 นาที ดู lib/contactCache.ts) — ไม่มีผลกับใบที่ส่งสำเร็จแล้ว เพราะ
  // ไม่ดึง contact ให้อยู่ดี
  const forceRefresh: boolean = Boolean(body.forceRefresh);

  const client = getPeakClient();
  const startedAt = Date.now();
  console.log(`[fetch] เริ่ม ${dateStart}-${dateEnd} (forceRefresh=${forceRefresh})`);
  let rows;
  try {
    // sent/sentContacts ไม่ขึ้นกับ receipts -> ยิงขนานไปพร้อมกันตั้งแต่ต้น แทนที่จะรอทีละขั้น
    const sentPromise = sendLog.sentCodes();
    // ชื่อ/ประเภทลูกค้าที่เคยบันทึกไว้ตอนกดส่งจริงหรือยืนยันด้วยมือ (ดู lib/sendLog.ts) — ใช้
    // เป็น fallback แสดงให้ใบที่ข้ามการดึง contact ไป แทนที่จะว่างเปล่า/"ไม่ทราบ" เสมอ
    const sentContactsPromise = sendLog.sentContactInfo();

    const receipts = await client.listAllReceipts(dateStart, dateEnd, LIST_STATUS_APPROVE);
    // ทั้งสอง query เป็น query เดียวจาก Postgres มักเสร็จก่อน listAllReceipts อยู่แล้ว (ซึ่งต้อง
    // ยิง PEAK อย่างน้อย 1 round-trip) การ await ตรงนี้จึงแทบไม่เสียเวลาเพิ่ม แลกกับการรู้ว่า
    // ใบไหนส่งแล้วก่อนเริ่มดึง contact เพื่อกรองใบเหล่านั้นออกไปเลย
    const [sent, sentContacts] = await Promise.all([sentPromise, sentContactsPromise]);
    const notSentReceipts = receipts.filter((r) => !sent.has(r.code ?? ""));
    // ใบที่ส่งแล้วแต่ไม่เคยมีชื่อ/ประเภทบันทึกไว้เลย — ต้องดึง contact ครั้งแรกเพื่อ backfill
    // (ดู docstring ด้านบน) รวมเข้ากับ notSentReceipts ยิง fetchContacts ครั้งเดียวกันเลย
    const needsBackfill = receipts.filter((r) => {
      const code = r.code ?? "";
      return sent.has(code) && !sentContacts.has(code);
    });
    const needsBackfillCodes = new Set(needsBackfill.map((r) => r.code ?? ""));
    console.log(
      `[fetch] ได้ใบเสร็จ ${receipts.length} ใบ (ส่งแล้ว ${receipts.length - notSentReceipts.length} ใบ ` +
        `— ในนั้นยังไม่เคยมีชื่อ/ประเภทบันทึกไว้ ${needsBackfill.length} ใบ ต้อง backfill) — ` +
        `เริ่มตรวจ contact ${notSentReceipts.length + needsBackfill.length} ใบ`
    );
    const contactCache = await fetchContacts(client, [...notSentReceipts, ...needsBackfill], undefined, forceRefresh);
    rows = receipts.map((r) => buildRow(r, contactCache, sent, sentContacts));
    console.log(`[fetch] เสร็จสิ้น ${rows.length} แถว (${((Date.now() - startedAt) / 1000).toFixed(1)}s รวม)`);
    // บันทึกลง PostgreSQL แบบ fire-and-forget (audit trail เสริม ไม่บล็อกการตอบกลับ
    // และไม่ทำให้ request พังถ้าต่อ DB ไม่ได้ — ดู safeDbWrite ใน lib/db.ts)
    void logReceiptChecks(rows);
    // backfill ชื่อ/ประเภทให้ใบกลุ่มที่เพิ่งดึง contact มาครั้งแรก (UPDATE entry เดิม ไม่ใช่
    // insert แถวใหม่ — ดู backfillContactInfo) ครั้งต่อไปจะเจอใน sentContactInfo() แล้วไม่ต้อง
    // ดึงซ้ำอีก ไม่บล็อกการตอบกลับ (แค่ audit เสริม)
    if (needsBackfillCodes.size) {
      void Promise.all(
        rows
          .filter((r) => needsBackfillCodes.has(r.code) && (r.contactName || r.contactType !== "unknown"))
          .map((r) => sendLog.backfillContactInfo(r.code, r.contactName || undefined, r.contactType))
      );
    }
  } catch (exc) {
    console.log(`[fetch] ล้มเหลวหลัง ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`, exc);
    if (exc instanceof PeakAPIError) {
      return NextResponse.json({ error: exc.message }, { status: 502 });
    }
    return NextResponse.json({ error: String((exc as Error).message ?? exc) }, { status: 500 });
  }

  return NextResponse.json({
    total: rows.length,
    validCount: rows.filter((r) => r.valid).length,
    alreadySentCount: rows.filter((r) => r.alreadySent).length,
    rows,
  });
}
