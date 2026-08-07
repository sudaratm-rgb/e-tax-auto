import { NextRequest, NextResponse } from "next/server";
import * as sendLog from "@/lib/sendLog";

interface StatusEntry {
  status: "issued" | "failed" | "pending" | "unknown";
  resCode: string;
  message: string;
  timestamp: string;
  pdfUrl?: string;
}

/**
 * สถานะ 'ออกใบจริง' ต่อ code (ใช้หลังกดส่ง เพื่อรอผล async จาก INET)
 * เรียก: GET /api/etax-status?codes=RE26060069,RE26062227
 * คืนต่อ code: status = issued | failed | pending | unknown + resCode/message
 *   - issued  : callback resCode 200 (ออกใบสำเร็จจริง)
 *   - failed  : callback ตอบไม่ใช่ 200 (เช่น 303) หรือส่งล้มเหลวตั้งแต่แรก
 *   - pending : รับคำขอแล้ว (resCode 200) แต่ INET ยังไม่ยิงผลกลับมา
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const codes = searchParams.get("codes") ?? "";
  const wanted = codes
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const snd = await sendLog.latestSendByCode(); // entry ล่าสุดต่อ code (รวมผล callback ที่บันทึกทับ)

  const result: Record<string, StatusEntry> = {};
  for (const code of wanted) {
    const e = snd.get(code);
    if (!e) {
      result[code] = { status: "unknown", resCode: "", message: "ไม่พบประวัติการส่ง", timestamp: "" };
      continue;
    }
    const resCode = String(e.resCode ?? "");
    const ts = e.timestamp ?? "";
    const ok = Boolean(e.success) && resCode === "200";
    if (e.phase === "callback") {
      // ผลจริงจาก INET แน่นอนแล้ว
      result[code] = {
        status: ok ? "issued" : "failed",
        resCode,
        message: e.resDesc ?? "",
        timestamp: ts,
        ...(ok && e.pdfUrl ? { pdfUrl: e.pdfUrl } : {}),
      };
    } else if (ok) {
      // รับคำขอแล้ว (resCode 200) แต่ยังไม่มีผล callback จาก INET
      result[code] = { status: "pending", resCode: "200", message: "รับคำขอแล้ว รอผลออกใบจริงจาก INET", timestamp: ts };
    } else {
      // ส่งล้มเหลวตั้งแต่ตอนยิง (เช่น network/validation)
      result[code] = { status: "failed", resCode, message: e.resDesc ?? "", timestamp: ts };
    }
  }
  return NextResponse.json({ status: result });
}
