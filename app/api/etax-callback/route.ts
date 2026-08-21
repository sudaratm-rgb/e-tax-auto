import { NextRequest, NextResponse } from "next/server";
import * as sendLog from "@/lib/sendLog";

/**
 * รับผล 'ออกใบจริง' แบบ async ที่ PEAK/INET ยิงกลับมา (ต้องเป็น public URL)
 * ตั้งค่าให้ส่ง URL นี้ตอนยิง e-tax ผ่าน ETAX_CALLBACK_URL ใน .env หรือ field callbackUrl
 * บันทึกทุก payload ลง etax_callback.jsonl เพื่อดูผลการออกใบจริงย้อนหลัง
 *
 * PEAK ส่ง keyReference กลับมาใน HTTP header 'Key-Reference' (ไม่ใช่ใน body)
 * เราตั้ง keyReference = code ตอนส่ง จึงผูกผล callback กับใบได้จาก header นี้
 */
export async function POST(req: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    payload = await req.text();
  }

  // code ของใบ: PEAK ส่งใน header Key-Reference; ถ้า forward ผ่าน Power Automate
  // อาจใส่มาใน body แทน (keyReference/code) ก็รับได้
  let keyReference = req.headers.get("key-reference") ?? "";
  if (!keyReference && typeof payload === "object" && payload !== null) {
    keyReference = String(payload.keyReference || payload.code || "");
  }
  await sendLog.recordCallback(payload, keyReference);

  // ผลออกใบจริงจาก INET เป็นตัวตัดสินสถานะสุดท้าย: resCode 200 = ออกใบสำเร็จ,
  // อื่น ๆ (เช่น 303 Incomplete) = ล้มเหลว -> บันทึกทับสถานะ "รับคำขอ" ตอนส่ง
  if (
    keyReference &&
    typeof payload === "object" &&
    payload !== null &&
    payload.resCode !== undefined &&
    payload.resCode !== null
  ) {
    const resCode = String(payload.resCode);
    const success = resCode === "200";
    let desc = payload.resDesc ?? "";
    const err = payload.resError ?? {};
    if (err && Object.keys(err).length) {
      desc = `${desc} (eTaxErrorType=${err.eTaxErrorType}: ${err.message})`;
    }
    // ออกใบสำเร็จ (resCode 200) จะมี field `eTaxInvoice` แนบลิงก์เอกสารจริงมาด้วย
    const eTaxInvoice = payload.eTaxInvoice ?? {};
    await sendLog.record(keyReference, success, resCode, desc, "callback", {
      documents: {
        pdfUrl: eTaxInvoice.pdfDocument,
        pdfA3Url: eTaxInvoice.pdfA3Document,
        xmlUrl: eTaxInvoice.xmlDocument,
      },
    });
  }
  return NextResponse.json({ ok: true });
}

/** ดูผล callback (ผลออกใบจริงจาก INET) ที่บันทึกไว้ (ใหม่สุดอยู่บน) */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get("limit") ?? "200", 10);
  return NextResponse.json({ entries: await sendLog.recentCallbacks(limit) });
}
