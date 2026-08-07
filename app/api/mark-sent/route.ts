import { NextRequest, NextResponse } from "next/server";
import * as sendLog from "@/lib/sendLog";

/**
 * ยืนยันด้วยตนเองว่าใบเสร็จออก e-Tax สำเร็จแล้วจริง (เช่น เช็คใน PEAK UI แล้วเจอ stamp
 * ส่งแล้ว แต่แอปนี้ไม่เคยได้ callback ยืนยัน — อาจเพราะส่งผ่าน PEAK UI โดยตรง หรือ callback
 * หลุดหายไปตอน tunnel ล่ม) เขียน entry เป็น phase="callback" เหมือนผล callback จริง เพื่อให้
 * แอปแสดงสถานะ "Sent" ที่ยืนยันแล้ว (เขียว) แทนที่จะค้าง "Submitted" (รอผล) ตลอดไป
 *
 * นี่คือการ override สถานะโดยมนุษย์ ไม่ใช่ผลจาก INET จริง — ต้องเช็คใน PEAK UI ก่อนเสมอ
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  // รองรับทั้งใบเดียว (code) และหลายใบพร้อมกัน (codes) — ใช้ endpoint เดียวกัน
  const codes: string[] = Array.isArray(body.codes) ? body.codes : body.code ? [body.code] : [];
  if (!codes.length) {
    return NextResponse.json({ error: "ต้องระบุ code หรือ codes" }, { status: 400 });
  }
  await Promise.all(
    codes.map((code) =>
      sendLog.record(code, true, "200", "Success", "callback")
    )
  );
  return NextResponse.json({ ok: true, count: codes.length });
}
