/**
 * ตรวจสอบว่า contact ของใบเสร็จมีข้อมูลครบ "และถูกต้อง" สำหรับออก e-Tax หรือไม่
 *
 * แบ่งตามประเภท (type) ตาม enum ทางการของ PEAK เป็น 3 กลุ่ม:
 *
 *   กลุ่ม A — บุคคลธรรมดา (type 5):
 *       - มีที่อยู่ "อย่างน้อย 1 ฟิลด์" จาก [address, subDistrict, district, province, postCode]
 *       - ไม่ต้องมี taxNumber
 *
 *   กลุ่ม B — บริษัท/บมจ. (type 2, 3):
 *       - ที่อยู่ "ครบ" : subDistrict + district + province + postCode
 *       - ต้องมี taxNumber
 *
 *   กลุ่ม C — นิติบุคคลอื่น (type 1,4,6,7,8,9,10,11):
 *       - ที่อยู่ "ครบ" : subDistrict + district + province + postCode
 *       - ไม่ต้องมี taxNumber
 *
 * เงื่อนไขร่วมทุกกลุ่ม:
 *   - มีข้อมูล contact และมีชื่อ (name)
 *   - ถ้ามีอีเมล ต้องเป็นรูปแบบที่ถูกต้อง
 *   - type ที่ไม่อยู่ในกลุ่มใดเลย -> ไม่ผ่าน
 *   - branchCode ไม่บังคับทุกกลุ่ม
 */
import { settings } from "./config";
import type { Contact } from "./peakClient";

const FULL_ADDRESS = ["subDistrict", "district", "province", "postCode"];
const ANY_ADDRESS = ["address", "subDistrict", "district", "province", "postCode"];

// บังคับว่า "ถ้ามี taxNumber ต้องเป็น 13 หลัก" — เจอเคสจริง (RE26072917) ที่บุคคลธรรมดา
// (ไม่บังคับต้องมี taxNumber) มี taxNumber="0" ซึ่งเป็นค่าขยะ ส่งจริงจะถูก INET ตีกลับ
// เช็คนี้ทำงานไม่ว่ากลุ่มไหนจะบังคับมี taxNumber หรือไม่ — แค่ "ถ้ามีค่า ต้องเป็น 13 หลัก"
const REQUIRE_TAXID_13DIGITS = true;

const FIELD_LABELS: Record<string, string> = {
  subDistrict: "ตำบล/แขวง",
  district: "อำเภอ/เขต",
  province: "จังหวัด",
  postCode: "รหัสไปรษณีย์",
  taxNumber: "เลขผู้เสียภาษี",
  address: "ที่อยู่",
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function has(contact: Contact, field: string): boolean {
  const val = contact[field];
  return Boolean(val) && String(val).trim() !== "";
}

function missing(contact: Contact, fields: string[]): string[] {
  return fields.filter((f) => !has(contact, f));
}

function labels(fields: string[]): string {
  return fields.map((f) => FIELD_LABELS[f] ?? f).join(", ");
}

/**
 * ตรวจรูปแบบอีเมล (ฟิลด์เดียวอาจมีหลายอีเมลคั่นด้วย , ; หรือเว้นวรรค)
 * คืน [ถูกต้องทั้งหมดไหม, ข้อความอธิบายส่วนที่ผิด] — อีเมลว่าง = ไม่ถือว่าผิด
 */
export function checkEmail(raw: string | undefined): [boolean, string] {
  const value = (raw ?? "").trim();
  if (!value) return [true, ""];
  const tokens = value.split(/[\s,;]+/).filter(Boolean);
  const bad = tokens.filter((t) => !EMAIL_RE.test(t));
  if (bad.length) {
    return [false, `อีเมลผิดรูปแบบ: ${bad.join(" , ")}`];
  }
  return [true, ""];
}

/** คืนค่า [ผ่านหรือไม่, เหตุผล] — ถ้าไม่ผ่านอาจมีหลายสาเหตุ รวมเป็นข้อความเดียวคั่นด้วย ' | ' */
export function validateContact(contact: Contact | null | undefined): [boolean, string] {
  if (!contact) return [false, "ไม่พบข้อมูล contact"];
  if (!has(contact, "name")) return [false, "ไม่มีชื่อ contact"];

  const ctype = contact.type;
  const problems: string[] = [];
  let kind = "";

  if (settings.CONTACT_TYPES_INDIVIDUAL.has(ctype)) {
    kind = "บุคคลธรรมดา";
    if (!ANY_ADDRESS.some((f) => has(contact, f))) {
      problems.push("ไม่มีที่อยู่ (ต้องมีอย่างน้อย 1 ฟิลด์)");
    }
  } else if (settings.CONTACT_TYPES_FULL_TAX.has(ctype)) {
    kind = "นิติบุคคล";
    const miss = missing(contact, FULL_ADDRESS);
    if (miss.length) problems.push(`ที่อยู่ไม่ครบ ขาด [${labels(miss)}]`);
    if (!has(contact, "taxNumber")) problems.push("ไม่มีเลขผู้เสียภาษี");
  } else if (settings.CONTACT_TYPES_FULL_NOTAX.has(ctype)) {
    kind = "นิติบุคคล";
    const miss = missing(contact, FULL_ADDRESS);
    if (miss.length) problems.push(`ที่อยู่ไม่ครบ ขาด [${labels(miss)}]`);
  } else {
    return [false, `ไม่รู้จักประเภท contact (type=${ctype})`];
  }

  const [okEmail, emailMsg] = checkEmail(contact.email);
  if (!okEmail) problems.push(emailMsg);

  if (REQUIRE_TAXID_13DIGITS && has(contact, "taxNumber")) {
    const tax = String(contact.taxNumber).trim();
    if (!/^\d{13}$/.test(tax)) {
      problems.push(`เลขผู้เสียภาษีไม่ใช่ 13 หลัก: ${tax}`);
    }
  }

  if (problems.length) return [false, problems.join(" | ")];
  return [true, `${kind}: ข้อมูลครบถูกต้อง`];
}
