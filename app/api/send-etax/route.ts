import { NextRequest, NextResponse } from "next/server";
import { settings } from "@/lib/config";
import { getPeakClient, PeakAPIError } from "@/lib/peakClient";
import { fetchApprovedCodes } from "@/lib/receipts";
import * as sendLog from "@/lib/sendLog";

interface SendResult {
  code: string;
  success: boolean;
  skipped?: boolean;
  message: string;
}

/**
 * ขั้นที่ 3: ส่ง e-tax ทีละใบตาม code ที่เลือก
 * - ข้ามใบที่เคยส่งสำเร็จแล้ว (ยกเว้น force=true)
 * - ข้ามใบที่ยังไม่อนุมัติเอกสาร (Draft) — ตรวจซ้ำเสมอที่นี่ ไม่ว่าฝั่ง client จะกรองมาก่อน
 *   หรือไม่ (แหล่งความจริงเดียว)
 * - บันทึกทุกการส่งลงตาราง send_log (Postgres)
 *
 * หมายเหตุ: เดิมเคยเช็คสถานะชำระเงิน (remainAmount) ด้วย แต่ถอดออกแล้ว — remainAmount
 * ของ GET /Receipts?code= ไม่อัปเดตให้ทันแม้มี paidPayments บันทึกครบวันเดียวกับที่จ่ายจริง
 * (เจอ 2 เคสติดกัน: RE26072241, RE26072955) ทำให้บล็อกใบที่จ่ายแล้วผิด ๆ
 */
// อาจเลือกส่งหลายสิบใบพร้อมกัน แต่ละใบมีเช็ค Approve ก่อนเสมอ (ยิง API เพิ่ม) — ค่า default
// ของ Vercel สั้นเกินไปถ้าเลือกจำนวนมาก
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const codes: string[] = body.codes ?? [];
  const force: boolean = body.force ?? false;
  const callbackUrl: string = body.callbackUrl || settings.ETAX_CALLBACK_URL;

  const results: SendResult[] = [];
  const already = force ? new Set<string>() : await sendLog.sentCodes();
  const client = getPeakClient();

  // แคช approvedCodes รายวัน กันยิง /Receipts/list?status=3 ซ้ำเวลามีหลายใบออกวันเดียวกัน
  const approvedCodesByDay = new Map<string, Promise<Set<string>>>();
  const approvedCodesForDay = (day: string): Promise<Set<string>> => {
    let p = approvedCodesByDay.get(day);
    if (!p) {
      p = fetchApprovedCodes(client, day, day);
      approvedCodesByDay.set(day, p);
    }
    return p;
  };

  try {
    for (const code of codes) {
      if (already.has(code)) {
        results.push({ code, success: false, skipped: true, message: "ข้าม: เคยส่งสำเร็จแล้ว" });
        continue;
      }
      try {
        // ตรวจซ้ำที่นี่เสมอก่อนส่งจริง: อนุมัติแล้วหรือยัง — ไม่พึ่งพาผลตรวจจาก /api/fetch
        // ฝั่ง client เพราะอาจเป็นข้อมูลเก่าหรือถูกเรียกตรงจาก API
        //
        // หมายเหตุ: ฟิลด์ status ใน GET /Receipts?code= เชื่อถือไม่ได้สำหรับเลขที่ใช้ซ้ำ
        // (คืน "Draft" ผิดทั้งที่อนุมัติแล้วจริง) จึงต้องใช้ list status param แทนเสมอ
        // ไม่ใช้ receipt.status ตรง ๆ
        const receipt = await client.getReceipt(code);
        const issuedDate = receipt?.issuedDate;
        const approvedSet = issuedDate ? await approvedCodesForDay(issuedDate) : new Set<string>();
        if (!issuedDate || !approvedSet.has(code)) {
          results.push({ code, success: false, skipped: true, message: "ข้าม: เอกสารยังไม่อนุมัติ (Draft)" });
          continue;
        }
      } catch (exc) {
        if (!(exc instanceof PeakAPIError)) throw exc;
        results.push({ code, success: false, message: `ตรวจสถานะเอกสารไม่สำเร็จ: ${exc.message}` });
        continue;
      }
      try {
        // keyReference = code -> PEAK ยิงกลับมาใน header Key-Reference ของ callback
        // ทำให้ผูกผลออกใบจริง (async) กับใบได้ (body ไม่มี code)
        const resp = await client.sendEtaxInvoice({ code, callbackUrl, keyReference: code });
        const resCode = String(resp.resCode ?? "200");
        const resDesc = resp.resDesc ?? "ส่งสำเร็จ";
        await sendLog.record(code, true, resCode, resDesc);
        results.push({ code, success: true, message: resDesc });
      } catch (exc) {
        if (!(exc instanceof PeakAPIError)) throw exc; // config ไม่ครบ -> 500 ทั้ง request
        await sendLog.record(code, false, "", exc.message);
        results.push({ code, success: false, message: exc.message });
      }
    }
  } catch (exc) {
    return NextResponse.json({ error: String((exc as Error).message ?? exc) }, { status: 500 });
  }

  return NextResponse.json({
    sent: results.filter((r) => r.success).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.success && !r.skipped).length,
    results,
  });
}
