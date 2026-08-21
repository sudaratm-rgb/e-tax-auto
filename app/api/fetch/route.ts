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
 * ⚠️ ตารางหลักนี้ไม่เช็ค journal (บันทึกรับชำระ) — ตั้งใจถอดออกเพราะเช็คไม่ได้โดยไม่ยิง
 * GET /Receipts?code= แยกทีละใบเพิ่ม (dedup ไม่ได้เหมือน contact) ซึ่งเป็นคอขวดหลักตอนดึง
 * ช่วงวันที่กว้าง (นับพันใบ = ต้องยิงนับพันครั้ง) journal check ยังใช้อยู่ที่ Import Excel
 * Report (`/api/import-report`) ซึ่งดึงใบเสร็จเต็มอยู่แล้วเพื่อจุดประสงค์อื่น เลยเช็คได้ "ฟรี"
 * ไม่มี API เพิ่ม — ส่วน `/api/send-etax` ตอนกดส่งจริงยังตรวจ Approve ซ้ำเหมือนเดิม (คนละ
 * เงื่อนไขกับ journal)
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
    // sent ไม่ขึ้นกับ receipts -> ยิงขนานไปพร้อมกันตั้งแต่ต้น แทนที่จะรอทีละขั้น
    const sentPromise = sendLog.sentCodes();

    const receipts = await client.listAllReceipts(dateStart, dateEnd, LIST_STATUS_APPROVE);
    // sentPromise เป็น query เดียวจาก Postgres มักเสร็จก่อน listAllReceipts อยู่แล้ว (ซึ่งต้อง
    // ยิง PEAK อย่างน้อย 1 round-trip) การ await ตรงนี้จึงแทบไม่เสียเวลาเพิ่ม แลกกับการรู้ว่า
    // ใบไหนส่งแล้วก่อนเริ่มดึง contact เพื่อกรองใบเหล่านั้นออกไปเลย
    const sent = await sentPromise;
    const notSentReceipts = receipts.filter((r) => !sent.has(r.code ?? ""));
    console.log(
      `[fetch] ได้ใบเสร็จ ${receipts.length} ใบ (ส่งแล้ว ${receipts.length - notSentReceipts.length} ใบ ข้ามการตรวจ contact) — เริ่มตรวจ contact ${notSentReceipts.length} ใบ`
    );
    const contactCache = await fetchContacts(client, notSentReceipts, undefined, forceRefresh);
    rows = receipts.map((r) => buildRow(r, contactCache, sent));
    console.log(`[fetch] เสร็จสิ้น ${rows.length} แถว (${((Date.now() - startedAt) / 1000).toFixed(1)}s รวม)`);
    // บันทึกลง PostgreSQL แบบ fire-and-forget (audit trail เสริม ไม่บล็อกการตอบกลับ
    // และไม่ทำให้ request พังถ้าต่อ DB ไม่ได้ — ดู safeDbWrite ใน lib/db.ts)
    void logReceiptChecks(rows);
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
