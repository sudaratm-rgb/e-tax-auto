import { NextRequest, NextResponse } from "next/server";
import * as sendLog from "@/lib/sendLog";

/**
 * เช็คสถานะการส่งของหลาย code พร้อมกัน
 * เรียก: GET /api/sent-status?codes=RE26062227,RE26062128
 * คืน: map { code: true/false } + แยกกลุ่ม sent / notSent
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const codes = searchParams.get("codes") ?? "";
  const wanted = codes
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const sent = await sendLog.sentCodes();
  const status: Record<string, boolean> = {};
  for (const c of wanted) status[c] = sent.has(c);

  return NextResponse.json({
    status,
    sent: wanted.filter((c) => status[c]),
    notSent: wanted.filter((c) => !status[c]),
  });
}
