import { NextRequest, NextResponse } from "next/server";
import { getPeakClient, PeakAPIError } from "@/lib/peakClient";
import { LIST_STATUS_APPROVE } from "@/lib/receipts";

/**
 * ดึงเฉพาะใบเสร็จที่ 'อนุมัติแล้ว' (Approve) ในช่วงวันที่
 * เรียก: GET /api/approved-receipts?dateStart=20260101&dateEnd=20260131
 *
 * หมายเหตุ: ใช้ list status param (status=3) เป็นตัวตัดสินโดยตรง — ไม่ใช้ฟิลด์ status
 * รายใบ (GET /Receipts?code=) ที่เชื่อถือไม่ได้สำหรับเลขที่ใช้ซ้ำ
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dateStart = searchParams.get("dateStart") ?? "";
  const dateEnd = searchParams.get("dateEnd") ?? "";

  const client = getPeakClient();
  let receipts;
  try {
    receipts = await client.listAllReceipts(dateStart, dateEnd, LIST_STATUS_APPROVE);
  } catch (exc) {
    if (exc instanceof PeakAPIError) {
      return NextResponse.json({ error: exc.message }, { status: 502 });
    }
    return NextResponse.json({ error: String((exc as Error).message ?? exc) }, { status: 500 });
  }

  const rows = receipts.map((r) => ({
    code: r.code ?? "",
    issuedDate: r.issuedDate ?? "",
    contactCode: r.contactCode ?? "",
    status: "Approve",
    netAmount: r.netAmount,
  }));

  return NextResponse.json({
    total: rows.length,
    approvedCount: rows.length,
    rows,
  });
}
