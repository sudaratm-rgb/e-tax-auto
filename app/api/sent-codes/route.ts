import { NextResponse } from "next/server";
import * as sendLog from "@/lib/sendLog";

/** คืนรายการ code ทั้งหมดที่เคยส่ง e-Tax สำเร็จแล้ว (resCode 200) */
export async function GET() {
  const codes = [...(await sendLog.sentCodes())].sort();
  return NextResponse.json({ count: codes.length, codes });
}
