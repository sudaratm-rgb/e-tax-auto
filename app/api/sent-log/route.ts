import { NextRequest, NextResponse } from "next/server";
import * as sendLog from "@/lib/sendLog";

/** ดูประวัติการส่ง (ใหม่สุดอยู่บน) */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get("limit") ?? "200", 10);
  return NextResponse.json({ entries: await sendLog.recent(limit) });
}
