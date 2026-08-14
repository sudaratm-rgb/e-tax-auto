import { NextRequest, NextResponse } from "next/server";
import { getPeakClient, PeakAPIError } from "@/lib/peakClient";
import { buildRow, fetchContacts, fetchReceiptJournals, LIST_STATUS_APPROVE, logReceiptChecks } from "@/lib/receipts";
import * as sendLog from "@/lib/sendLog";

// ช่วงวันที่กว้าง (เช่น 10 วัน) วัดจริงแล้วใช้เวลาได้ถึงหลักนาที (contact/journal ที่ไม่เคย
// cache มาก่อนต้องยิง PEAK ทีละตัว) — ค่า default ของ Vercel serverless function สั้นเกินไป
export const maxDuration = 300;

/** ขั้นที่ 1+2: ดึงใบเสร็จที่อนุมัติแล้ว (Approve) ตามวันที่ แล้วตรวจ contact ทุกใบ */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const dateStart: string = body.dateStart; // YYYYMMDD
  const dateEnd: string = body.dateEnd; // YYYYMMDD
  // true = ข้าม cache contact ทั้งหมด ดึงสดจาก PEAK ใหม่ทุกราย — ใช้ตอนกดปุ่ม "รีเฟรช" เอง
  // เผื่อเพิ่งแก้ไขข้อมูล contact ใน PEAK มา แล้วอยากเห็นผลทันทีโดยไม่ต้องรอ cache หมดอายุ
  // (ปกติ cache อยู่ได้ 15 นาที ดู lib/contactCache.ts)
  const forceRefresh: boolean = Boolean(body.forceRefresh);

  const client = getPeakClient();
  const startedAt = Date.now();
  console.log(`[fetch] เริ่ม ${dateStart}-${dateEnd} (forceRefresh=${forceRefresh})`);
  let rows;
  try {
    // sent ไม่ขึ้นกับ receipts -> ยิงขนานไปพร้อมกันตั้งแต่ต้น แทนที่จะรอทีละขั้น
    const sentPromise = sendLog.sentCodes();

    const receipts = await client.listAllReceipts(dateStart, dateEnd, LIST_STATUS_APPROVE);
    console.log(`[fetch] ได้ใบเสร็จ ${receipts.length} ใบ — เริ่มตรวจ contact/journal`);
    // ยิงพร้อมกัน: ดึง contact (dedup ได้) + เช็ค journal ต่อใบ (dedup ไม่ได้) เป็นคนละงาน
    // ไม่ขึ้นกัน ไม่ต้องรอทีละขั้น
    const [contactCache, journalMap, sent] = await Promise.all([
      fetchContacts(client, receipts, undefined, forceRefresh),
      fetchReceiptJournals(client, receipts, undefined, forceRefresh),
      sentPromise,
    ]);
    rows = receipts.map((r) => buildRow(r, contactCache, sent, journalMap));
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
