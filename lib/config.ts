/** โหลดค่าตั้งค่าทั้งหมดจาก environment (.env / .env.local) */

function required(key: string): string {
  const val = (process.env[key] ?? "").trim();
  if (!val) {
    throw new Error(
      `ไม่พบค่า environment variable: ${key} (คัดลอก .env.example เป็น .env แล้วใส่ค่าให้ครบ)`
    );
  }
  return val;
}

function parseIntSet(raw: string | undefined, fallback: string): Set<number> {
  return new Set(
    (raw ?? fallback)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => parseInt(x, 10))
  );
}

export const settings = {
  BASE_URL: (process.env.PEAK_BASE_URL ?? "https://api.peakaccount.com/api/v1").replace(/\/+$/, ""),

  get connectId(): string {
    return required("PEAK_CONNECT_ID");
  },
  get userToken(): string {
    return required("PEAK_USER_TOKEN");
  },
  // connectKey (= Password จาก PEAK) ใช้ขอ/รีเฟรช Client-Token
  get connectKey(): string {
    return required("PEAK_CONNECT_KEY");
  },
  // Client-Token เริ่มต้น (ถ้ามี) — ปกติจะ mint ใหม่อัตโนมัติจาก connectKey
  get clientToken(): string {
    return (process.env.PEAK_CLIENT_TOKEN ?? "").trim();
  },

  // จำนวน request ดึง contact พร้อมกัน (PEAK contact API ช้า ~5s/call จึงต้องดึงขนาน)
  CONTACT_FETCH_WORKERS: parseInt(process.env.CONTACT_FETCH_WORKERS ?? "12", 10),

  // e-tax defaults
  ETAX_CONNECT_TYPE: parseInt(process.env.ETAX_CONNECT_TYPE ?? "1", 10),
  ETAX_IS_UPDATE_DOCUMENT: parseInt(process.env.ETAX_IS_UPDATE_DOCUMENT ?? "0", 10),

  // callback URL (ต้องเป็น public URL) ให้ PEAK/INET ยิงผลออกใบจริงแบบ async กลับมา
  ETAX_CALLBACK_URL: (process.env.ETAX_CALLBACK_URL ?? "").trim(),

  // contact type mapping (อ้างอิง enum ทางการของ PEAK)
  //   1=ห้างหุ้นส่วนจำกัด 2=บริษัทจำกัด 3=บริษัทมหาชน 4=ร้านค้า 5=บุคคลธรรมดา
  //   6=คณะบุคคล 7=อื่นๆ 8=ห้างหุ้นส่วนสามัญ 9=มูลนิธิ 10=สมาคม 11=กิจการร่วมค้า
  CONTACT_TYPES_INDIVIDUAL: parseIntSet(process.env.CONTACT_TYPES_INDIVIDUAL, "5"),
  CONTACT_TYPES_FULL_TAX: parseIntSet(process.env.CONTACT_TYPES_FULL_TAX, "2,3"),
  CONTACT_TYPES_FULL_NOTAX: parseIntSet(
    process.env.CONTACT_TYPES_FULL_NOTAX,
    "1,4,6,7,8,9,10,11"
  ),
};
