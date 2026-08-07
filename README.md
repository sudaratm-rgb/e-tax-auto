# PEAK e-Tax Auto Sender

Web App ส่งใบกำกับภาษีอิเล็กทรอนิกส์ (e-Tax) อัตโนมัติผ่าน PEAK Open API

## Flow การทำงาน
1. เลือกช่วงวันที่ → ดึงใบเสร็จทุกหน้า `GET /Receipts/list?dateStart=&dateEnd=` (วน pagination จนครบ)
2. ดึง contact ของแต่ละใบจาก `contactCode`/`contactId` → `GET /Contacts?code=` มาตรวจสอบความครบถ้วน
   (ดึงแบบ **ขนาน** และ cache contact ที่ซ้ำ เพราะ contact API ของ PEAK ช้า ~5 วินาที/ครั้ง)
3. ติ๊กเลือกใบที่ต้องการ (default ติ๊กใบที่ผ่าน **และยังไม่เคยส่ง**) → กดส่ง → `POST /Receipts/etaxinvoice` ทีละใบ

## การกันส่งซ้ำ + ประวัติการส่ง (`send_log.py`)
- ทุกการส่งถูกบันทึกลง **`sent_log.jsonl`** (เวลา, code, ผล, resCode/resDesc)
- ก่อนส่ง ระบบ **ข้ามใบที่เคยส่งสำเร็จแล้ว** อัตโนมัติ (รายงานเป็น "ข้าม") — บังคับส่งซ้ำได้ด้วย `force: true`
- หน้าเว็บ: ใบที่เคยส่งแสดงป้าย "ส่งแล้ว" + ปิดติ๊กเลือก, ปุ่ม "ดูประวัติการส่ง"
- ⚠️ ใช้ log ฝั่งเราเป็นตัวตัดสิน เพราะ `taxStatus` ฝั่ง PEAK ไม่อัปเดตทันที (INET ออกใบแบบ async)

### เช็คสถานะ "ส่งแล้วหรือยัง" ผ่าน API (UI กับ API ใช้ log เดียวกัน)
- `GET /api/sent-codes` → รายการ code ที่ส่งสำเร็จแล้วทั้งหมด
- `GET /api/sent-status?codes=A,B,C` → เช็คหลายใบ คืน map + กลุ่ม sent/notSent
- `GET /api/sent-log?limit=200` → ประวัติการส่งทั้งหมด
- `POST /api/fetch` → แต่ละแถวมี `alreadySent` + `docStatus` (Approve/Draft) ติดมาให้
- `GET /api/approved-receipts?dateStart=&dateEnd=` → เฉพาะใบที่สถานะ Approve (ดูหัวข้อ "สถานะเอกสาร")
- `GET /api/etax-status?codes=A,B,C` → สถานะออกใบจริง pending/issued/failed (ดูหัวข้อ callback)
- `POST /api/etax-callback` → endpoint รับผลออกใบจริงจาก INET · `GET` เดียวกัน = ดูผลย้อนหลัง

> ⚠️ ข้อจำกัด: log รู้เฉพาะใบที่ส่งผ่าน "แอปนี้" — ใบที่กดส่ง e-Tax เองผ่าน **PEAK UI**
> จะไม่อยู่ใน log และ **ตรวจจับอัตโนมัติไม่ได้** เพราะ PEAK API ไม่เปิดเผยสถานะ e-Tax:
> - `taxStatus` = 0 เท่ากันหมดทั้งใบที่ส่งแล้ว/ยังไม่ส่ง (ยืนยันด้วย API จริง)
> - ไม่มี endpoint ประวัติ/สถานะ e-tax ในเอกสาร PEAK
>
> แนวทาง: (1) ส่งผ่านแอปนี้ช่องทางเดียวให้ log ครบ  (2) เมื่อ deploy มี public URL
> ให้ใช้ callback `url` ตอนส่ง เพื่อรับผลออกใบจริงจาก INET กลับมาบันทึก (ดูหัวข้อถัดไป)

## PostgreSQL audit trail (`lib/db.ts`, `db/schema.sql`) — ไม่บังคับ
เก็บประวัติแบบ query ได้สะดวกกว่าไฟล์ `.jsonl` ผ่าน DBeaver หรือ client อื่น ๆ — เขียน
**คู่ขนาน** กับ `.jsonl` เดิม (ไม่ได้แทนที่) แอปยังอ่านจาก `.jsonl` เหมือนเดิมทุกจุด

- ตั้งค่า `DATABASE_URL` ใน `.env` (`postgres://user:password@host:port/dbname`) — ถ้าไม่ตั้ง
  แอปทำงานปกติเหมือนเดิม แค่ไม่มี audit trail ใน DB (log warning เฉย ๆ ไม่ throw)
- ตารางถูกสร้างอัตโนมัติ (`CREATE TABLE IF NOT EXISTS` จาก `db/schema.sql`) ตอนเขียนครั้งแรก
  หรือจะรัน `db/schema.sql` เองผ่าน DBeaver ล่วงหน้าก็ได้
- **`receipt_checks`** — บันทึกทุกแถวทุกครั้งที่ `/api/fetch` ประมวลผลเสร็จ (append-only ไม่
  update ทับ) เก็บ `valid`/`reason`/`already_sent` ของแต่ละใบ ณ เวลาที่ตรวจ — คำถาม
  "ใบนี้เคยมีสถานะอะไรบ้าง เปลี่ยนตอนไหน" ที่ PEAK เองตอบไม่ได้และ `.jsonl` ก็ไม่มีข้อมูลนี้
  เช่น `SELECT * FROM receipt_checks WHERE code = 'RE26072241' ORDER BY checked_at DESC`
- **`send_log`** / **`etax_callbacks`** — mirror ของ `sent_log.jsonl` / `etax_callback.jsonl`
- เขียนแบบ fire-and-forget ไม่บล็อกการตอบกลับของ `/api/fetch`/`/api/send-etax`/`/api/etax-callback`
  และไม่ทำให้ request ล้มเหลวถ้าต่อ DB ไม่ได้ (`safeDbWrite` ใน `lib/db.ts`)

**ประวัติเก่าก่อนตั้งค่า DB**: แอปเขียนคู่ขนานเฉพาะรายการใหม่ตั้งแต่ตั้งค่า `DATABASE_URL`
เท่านั้น ประวัติเก่าใน `sent_log.jsonl`/`etax_callback.jsonl` ต้อง backfill เองครั้งเดียว:
```bash
npm run db:backfill    # หรือ node scripts/backfill-db.js
```
สคริปต์นี้ทดสอบการเชื่อมต่อ + สร้างตาราง + ย้ายประวัติเก่าเข้า `send_log`/`etax_callbacks`
(รันซ้ำจะ insert ซ้ำ — ตั้งใจให้รันครั้งเดียว) — `receipt_checks` backfill ไม่ได้เพราะ
`.jsonl` เดิมไม่เคยเก็บข้อมูลแบบนี้มาก่อน จะเริ่มมีตั้งแต่ `/api/fetch` ครั้งแรกหลังตั้งค่า

## ผลออกใบจริงแบบ async + callback (สำคัญ — `resCode 200 ≠ ออกใบสำเร็จ`) ✅
การส่ง e-Tax เป็น **asynchronous**: `POST /Receipts/etaxinvoice` ตอบ `resCode 200` = PEAK
**"รับคำขอ"** เท่านั้น การออกใบจริงผ่าน INET เกิดทีหลัง และ**อาจล้มเหลว**โดยที่ PEAK API
ไม่เปิดเผยผล → ต้องรับผลผ่าน **callback URL** เท่านั้น (ทดสอบกับ API จริงแล้ว)

**กลไก callback (ยืนยันกับ API จริง):**
- ส่ง field `url` ไปกับคำขอ (ตั้ง `ETAX_CALLBACK_URL` ใน `.env` หรือ field `callbackUrl` ต่อคำขอ)
- ระบบส่ง `keyReference = code` ทุกครั้ง → **PEAK ยิงค่านี้กลับมาใน HTTP header `Key-Reference`**
  (ไม่ใช่ใน body!) จึงผูกผล callback กับใบได้
- PEAK/INET ยิงผลกลับมาที่ `POST /api/etax-callback` — body เช่น
  `{"resCode":"303","resDesc":"Send E-Tax Invoice Incomplete","resError":{"eTaxErrorType":19,"message":"..."}}`
- ผล callback **บันทึกทับสถานะ** (`phase=callback`): `resCode 200` = ออกใบสำเร็จ, อื่น ๆ = ล้มเหลว
  ใบที่ INET ตีกลับจะ **ไม่ถูกนับว่าส่งแล้ว** (`sent_codes` ใช้ entry ล่าสุดต่อ code) → ส่งซ้ำได้หลังแก้ข้อมูล

**สถานะต่อใบ — `GET /api/etax-status?codes=A,B,C`:**
| status | ความหมาย |
|---|---|
| `pending` | รับคำขอแล้ว (resCode 200) รอ INET ยิงผลกลับ |
| `issued` | callback resCode 200 = ออกใบสำเร็จจริง |
| `failed` | callback ≠ 200 (เช่น 303) หรือส่งล้มเหลวตั้งแต่ยิง |

**หน้าเว็บ:** หลังกดส่ง จะขึ้น "กำลังรอผลออกใบจริงจาก INET..." แล้ว **poll `/api/etax-status`**
(ทุก 3 วิ ~45 วิ) เพื่อแจ้ง **"ออกใบสำเร็จ X / ส่งไม่ผ่าน Y"** ต่อใบพร้อมเหตุผล — ถ้า INET
ยังไม่ตอบภายใน 45 วิ (`app/page.tsx`) จะมี **background poll แยกอีกชุด (ทุก 20 วิ ไม่มี
กำหนดเวลาหมดอายุ)** คอยเช็คซ้ำให้อัตโนมัติต่อ ตราบใดที่ยังมีแถว "Pending" อยู่ในตาราง —
ไม่ต้องกดรีเฟรชเองรอผล (แต่ไม่มีทางเร่งเวลาที่ INET ใช้ประมวลผลจริงได้ ระบบแค่รอผลจาก
INET ให้อัตโนมัติเท่านั้น)

**eTaxErrorType ที่เจอจริง:** `7` = Contact email invalid length · `19` = Contact tax number invalid data

> ⚠️ callback ต้องวิ่งกลับมาถึงแอปได้ → ต้อง deploy ให้มี **public URL** แล้วตั้ง `ETAX_CALLBACK_URL`
> ชี้มาที่ `/api/etax-callback`. บน localhost callback ไปไม่ถึง (หน้าเว็บจะค้าง pending จนหมดเวลา)
> — ทดสอบดู payload จริงได้ด้วย **webhook.site** (ใช้ "endpoint URL" ไม่ใช่ลิงก์หน้า view)

## สถานะเอกสาร (Approve เท่านั้น) + เลขที่ใบเสร็จ "ใช้ซ้ำ" ได้ (ทดสอบกับ API จริง ✅)
`/api/fetch` **ดึงเฉพาะใบเสร็จที่อนุมัติแล้ว (Approve) ตั้งแต่ต้นทาง** โดยส่ง `status=3`
ให้ `GET /Receipts/list` โดยตรง (ไม่ดึง Draft/Void มาแสดงเลย) — ทุกแถวที่แอปแสดงจึงเป็น
Approve เสมอ ไม่ต้องมี badge แยก Draft/Approve อีกต่อไป
(ดู `fetchApprovedCodes`/`LIST_STATUS_APPROVE` ใน `lib/receipts.ts`)
และมี endpoint `GET /api/approved-receipts?dateStart=&dateEnd=` แยกต่างหาก (ไม่มีตรวจ
contact) สำหรับกรณีอยากได้แค่รายการ Approve ดิบ ๆ

ตัวตัดสินสถานะใช้ **list `status` param** ไม่ใช่ฟิลด์ `status` รายใบ:
| list `status` | ความหมาย |
|---|---|
| 1 | Draft (ร่าง) |
| 3 | Approve (อนุมัติแล้ว) — ค่าที่แอปนี้ใช้ดึงเสมอ |
| 4 | Void (ยกเลิก) |

- ⚠️ **ฟิลด์ `status` รายใบ (`GET /Receipts?code=`) เชื่อถือไม่ได้** — คืน `"Draft"` ผิด
  สำหรับเลขที่ถูกใช้ซ้ำ จึงห้ามใช้ค่านี้ตัดสินสถานะ แม้แต่ตอนตรวจซ้ำใน `POST /api/send-etax`
  ก็ต้องเรียก `fetchApprovedCodes` (list status param) ไม่ใช่อ่าน `receipt.status` ตรง ๆ
- ⚠️ **เลขที่ใบเสร็จ "ใช้ซ้ำ" ได้**: หลัง void ใบเก่า PEAK ออกใบใหม่ด้วย `code` เดิมแต่ `id` ใหม่
  → `GET /Receipts?code=` คืนได้ **หลายเอกสาร** (ตัว void เก่า + ตัว live ใหม่)
  `PeakClient.getReceipt()` จึงเลือกตัว **non-void (live)** ก่อนเสมอ (ไม่ใช่ `[0]`)

## ความเร็วในการดึงข้อมูล (`lib/contactCache.ts`) — ทดสอบกับ API จริงแล้ว ✅
`GET /Contacts?code=` (ตรวจ contact ต่อใบ) เป็นคอขวดหลักของ `/api/fetch` (~5s/call) — ลอง
วิธี "ดึง contact ทั้งบัญชีแบบ list/page ล่วงหน้า" (`GET /Contacts?page=&limit=` ไม่ระบุ code)
ดูแล้ว **ไม่ช่วย**: ดึง 1 หน้า (100 รายการ) ใช้เวลา ~14 วินาที พอ ๆ กับดึงทีละใบ ไม่คุ้มที่จะ
sync ทั้งบัญชี (3,627 contact ในบัญชีทดสอบ)

สิ่งที่ช่วยจริงคือ **cache contact ข้ามคำขอ** (`lib/contactCache.ts`, TTL 15 นาที, persist
ผ่าน `globalThis` เหมือน `getPeakClient()`) เพราะลูกค้าเดิมซ้ำกันมากทั้งในวันเดียวกันและ
ข้ามวันที่ต่างกัน — `fetchContacts()` เช็ค cache ก่อนเสมอ ยิง API จริงเฉพาะ contact ที่ยังไม่
เคย cache หรือ cache หมดอายุ ไม่ cache ผล error (กันค้างสถานะผิดพลาดไว้นานเกินไป)

ผลทดสอบจริง: ดึงวันเดียวกันซ้ำ (contact ทุกตัวมาจาก cache หมด) จาก **29.2s เหลือ 0.7s**
(~40x) — ดึงวันอื่นที่มีลูกค้าซ้ำบางส่วนก็เร็วขึ้นตามสัดส่วนที่ตรงกัน (cache miss เฉพาะ
ลูกค้าใหม่จริง ๆ เท่านั้น)

## Resilience
- `PeakClient` (`lib/peakClient.ts`) มี **auto-retry + exponential backoff** (2,4,8,16s) เมื่อเจอ
  resCode 600 (token ติด throttle) — POST ปิด network-retry เพื่อกัน double-send
- ปรับ `CONTACT_FETCH_WORKERS` ให้ต่ำลงได้ถ้าเจอ resCode 600 บ่อย (ค่าเริ่มต้น 12 — คุม
  ความขนานของการตรวจ contact)
- **`getPeakClient()` ใช้ client เดียว (และ Client-Token เดียว) ร่วมกันทั้ง process** แทนที่จะ
  `new PeakClient()` ต่อ request — PEAK อนุญาต Client-Token ที่ valid ได้ครั้งละ 1 ตัวต่อ
  connectId เท่านั้น ถ้ามินต์ token ใหม่ต่อ request จะเจอ resCode 600 เป็นพัก ๆ เวลามีคำขอ
  พร้อมกันหลายตัว (ยืนยันเจอจริงระหว่างพัฒนา — แก้แล้วด้วย singleton ผ่าน `globalThis`)
- หากเจอ `resCode 600 Invalid Client Token` ต่อเนื่องนาน = token โดน lockout/หมดอายุ
  → ไป regenerate ที่ PEAK Settings > API

> หมายเหตุ: list ส่ง `contactCode`/`contactId` มาให้แล้ว จึงไม่ต้องเรียก `GET /Receipts?code=`
> ซ้ำต่อใบเพื่ออ่าน contact — endpoint นี้ยังถูกเรียกอยู่ใน `POST /api/send-etax` เพื่อเอา
> `issuedDate` มาใช้เช็คสถานะอนุมัติซ้ำ (1 ครั้งต่อใบตอนกดส่งจริง ไม่ใช่ตอนดึงรายการ)

## เงื่อนไขการตรวจ contact (`lib/validators.ts`) — ผิดข้อใดข้อหนึ่ง = ไม่ผ่าน (ไม่ส่ง)
ร่วมทุกกลุ่ม: มีชื่อ (name) + type ต้องรู้จัก + ถ้ามีอีเมลต้องรูปแบบถูก (`"x@y.com Fax"` = ผิด)

แบ่งตาม `type` (enum ทางการ PEAK) เป็น 3 กลุ่ม:
| type | กลุ่ม | ที่อยู่ | taxid |
|---|---|---|---|
| **5** บุคคลธรรมดา | A | อย่างน้อย 1 ฟิลด์ | ไม่ต้อง |
| **2,3** บริษัท/บมจ. | B | ครบ 4 ฟิลด์ (ตำบล+อำเภอ+จังหวัด+ปณ.) | **ต้องมี** |
| **1,4,6,7,8,9,10,11** หจก./ร้านค้า/คณะบุคคล/อื่นๆ/หสน./มูลนิธิ/สมาคม/ร่วมค้า | C | ครบ 4 ฟิลด์ | ไม่ต้อง |

- branchCode ไม่บังคับทุกกลุ่ม · กลุ่ม A รับที่อยู่ free-text (`address`) ด้วย
- กลุ่มแยกปรับได้ใน `.env`: `CONTACT_TYPES_INDIVIDUAL` / `_FULL_TAX` / `_FULL_NOTAX`
- **`REQUIRE_TAXID_13DIGITS = true`** ใน `lib/validators.ts` (เปิดอยู่ ไม่ใช่ optional แล้ว) —
  ถ้า contact มี `taxNumber` (ไม่ว่ากลุ่มไหนจะบังคับต้องมีหรือไม่) ต้องเป็นเลข 13 หลักเท่านั้น
  เจอเคสจริง (`RE26072917`) บุคคลธรรมดาที่ไม่บังคับต้องมี taxNumber แต่มีค่าขยะ `"0"`
  ติดมา ซึ่งส่งจริงจะโดน INET ตีกลับ (`eTaxErrorType 19`) จึงต้องเช็คเสมอไม่ว่ากลุ่มไหน

ค่า `type` ที่พบจริงจากบัญชีทดสอบ: `5` = บุคคลธรรมดา, `2/3/7` = นิติบุคคล
(ปรับเพิ่มได้ใน `.env` หากเจอ type อื่น — ใบที่ type ไม่อยู่ใน mapping จะถูกตีว่า "ไม่ผ่าน")

## เงื่อนไขการตรวจสถานะเอกสาร (Approve) (`lib/receipts.ts`) — ทดสอบกับ API จริงแล้ว ✅
ส่ง e-Tax ได้เฉพาะใบเสร็จที่ **อนุมัติแล้ว (Approve, ไม่ใช่ Draft)** เท่านั้น (ข้อนี้
**ไม่มีเอกสารอย่างเป็นทางการจาก PEAK** ว่าเป็นข้อกำหนดของ `POST /Receipts/etaxinvoice`
— เป็นกติกาธุรกิจของระบบนี้เอง จึงต้องบังคับเอง)

`/api/fetch` ดึงเฉพาะ `status=3` (Approve) ตั้งแต่ต้นทาง (ดูหัวข้อ "สถานะเอกสาร" ด้านบน)
จึงรับประกันแล้วว่าทุกแถวเป็น Approve — ไม่ต้องเช็คซ้ำที่ `buildRow`

**`POST /api/send-etax` ตรวจซ้ำเสมอ** ก่อนส่งจริงทุกใบ (ไม่พึ่งพาผลจาก `/api/fetch` ฝั่ง
client เพราะอาจเป็นข้อมูลเก่าหรือถูกเรียกตรงจาก API) — เช็คด้วย **list status param**
(`fetchApprovedCodes` ต่อวันที่ออกใบ, cache ต่อ request กันยิงซ้ำ) **ไม่ใช้ฟิลด์ `status`
ของ `GET /Receipts?code=` ตรง ๆ** เพราะฟิลด์นี้เชื่อถือไม่ได้สำหรับเลขที่ใบเสร็จใช้ซ้ำ
(ดูหัวข้อ "เลขที่ใบเสร็จใช้ซ้ำ" ด้านบน) — คืน `"Draft"` ผิดทั้งที่อนุมัติแล้วจริง

### ~~เช็คสถานะชำระเงิน~~ (ถอดออกแล้ว — `remainAmount` เชื่อถือไม่ได้)
เคยมีการบังคับว่าต้อง **ชำระเงินครบแล้ว** (`remainAmount <= 0` จาก `GET /Receipts?code=`)
ก่อนส่ง e-Tax ได้ — **ถอดออกแล้ว** เพราะเจอ 2 เคสติดกัน (`RE26072241`, `RE26072955`) ที่มี
`paidPayments[]` บันทึกครบเต็มจำนวนตรงวันเดียวกับที่ออกใบ แต่ `remainAmount` ไม่ลดลงเลย
ทำให้บล็อกใบที่จ่ายแล้วจริงผิด ๆ — สรุปว่าฟิลด์นี้ไม่น่าเชื่อถือพอจะใช้เป็นเงื่อนไขบังคับ
ส่ง (อาจเป็นความหน่วงของ PEAK เอง ไม่ใช่ real-time)

ถ้าจะกลับมาใช้อีกในอนาคต ควรพิจารณาเช็ค `paidPayments[]` ประกอบด้วย (มี record + ยอดรวม
ครบ `netAmount` ก็ถือว่าจ่ายแล้ว) แทนที่จะเชื่อ `remainAmount` เพียงอย่างเดียว

## การยืนยันตัวตน (สำคัญ — ทดสอบกับ API จริงแล้ว ✅)
PEAK ต้องการ 4 headers ทุก request — โค้ดเซ็นให้อัตโนมัติใน `lib/peakClient.ts`:
| Header | ค่า |
|---|---|
| `Time-Stamp` | **เวลา UTC** รูปแบบ `yyyyMMddHHmmss` (⚠️ ต้องเป็น UTC ไม่ใช่เวลาเครื่อง มิฉะนั้น resCode 400) |
| `Time-Signature` | `HMAC-SHA1(Time-Stamp, secret=connectId)` แบบ **hex** (ยืนยันตรงกับค่าจริงแล้ว) |
| `User-Token` | token จาก PEAK |
| `Client-Token` | **หมดอายุได้** — ระบบ mint/refresh อัตโนมัติผ่าน `POST /ClientToken` (connectId + connectKey) |

### Client-Token หมดอายุ → refresh อัตโนมัติ
`Client-Token` มีอายุจำกัด เมื่อหมดอายุ PEAK ตอบ `resCode 600 Invalid Client Token`
- `PeakClient` จะ **mint token ใหม่เอง** จาก `PEAK_CONNECT_KEY` (= Password ใน PEAK) ผ่าน
  `POST /api/v1/ClientToken` แล้วลอง request เดิมซ้ำให้อัตโนมัติ (มี lock กัน refresh ซ้ำตอนยิงขนาน)
- จึงไม่ต้องใส่ `PEAK_CLIENT_TOKEN` ใน `.env` ก็ได้ (ปล่อยว่างไว้ ระบบ mint เอง)

PEAK ห่อ response จริงไว้ใน object ชั้นใน (`PeakReceipts` / `PeakContacts`) พร้อม `resCode`/`resDesc`
— `_unwrap()` ใน client จัดการแกะและตรวจ `resCode == "200"` ให้

## ติดตั้งและรัน
```bash
npm install
cp .env.example .env          # ใส่ค่า PEAK_CONNECT_ID / PEAK_USER_TOKEN / PEAK_CLIENT_TOKEN
npm run dev                   # เปิด http://localhost:3000 (production: npm run build && npm start)
```
> 1 วันที่มีใบเสร็จเยอะ (เช่น ~145 ใบ) การดึง+ตรวจใช้เวลาราว 1 นาที (เพราะ contact API ช้า)
> ปรับความเร็วได้ที่ `CONTACT_FETCH_WORKERS` ใน `.env`

## ค่า etaxConnectType (ทดสอบกับ API จริงแล้ว ✅)
| ค่า | ความหมาย | ผลทดสอบ |
|---|---|---|
| **2** | ส่งผ่าน **INET** | resCode 200 Success |
| 1 | (ไม่ใช่ INET) | resCode 500 internal error |

`ETAX_CONNECT_TYPE=2` ตั้งไว้ใน `.env` แล้ว — ถ้ากิจการใช้ช่องทางอื่น (เช่น e-Tax by Email) ค่าจะต่างออกไป
การส่งเป็นแบบ **asynchronous** (resCode 200 = PEAK รับคำขอแล้ว, การออกใบจริงผ่าน INET เกิดภายหลัง)

## ไฟล์ (Next.js / TypeScript)
| ไฟล์ | หน้าที่ |
|---|---|
| `app/page.tsx` | หน้าเว็บ (React client component) |
| `app/api/*/route.ts` | API routes (`/api/fetch`, `/api/send-etax`, `/api/approved-receipts`, `/api/etax-status`, `/api/etax-callback`, `/api/sent-log`, `/api/sent-codes`, `/api/sent-status`) |
| `lib/peakClient.ts` | client เรียก PEAK API + เซ็น HMAC + แกะ response (`sendEtaxInvoice` รองรับ `callbackUrl`/`keyReference`) |
| `lib/receipts.ts` | ดึง contact แบบขนาน + ประกอบแถวผลลัพธ์ (ทุกแถวเป็น Approve อยู่แล้วจาก `/api/fetch`) |
| `lib/validators.ts` | กติกาตรวจ contact |
| `lib/sendLog.ts` | บันทึกผลการส่ง + กันส่งซ้ำ (`sent_log.jsonl`) + ผล callback (`etax_callback.jsonl`) |
| `lib/config.ts` | โหลด env |
| `lib/contactCache.ts` | cache contact ข้ามคำขอ (TTL 15 นาที) ลดจำนวนครั้งที่ต้องยิง `GET /Contacts?code=` |
| `lib/db.ts` | pool เชื่อมต่อ PostgreSQL + สร้างตารางอัตโนมัติ + `safeDbWrite` (ไม่ throw ถ้าต่อ DB ไม่ได้) |
| `db/schema.sql` | schema ของ audit trail (`receipt_checks`/`send_log`/`etax_callbacks`) — รันเองผ่าน DBeaver ได้ |

> พอร์ตมาจาก FastAPI/Python เดิม (`app.py`, `peak_client.py`, `validators.py`, `send_log.py`, `config.py`,
> `templates/index.html`) — ลบไฟล์ Python เดิมแล้วหลังพอร์ตครบ ตรรกะ/พฤติกรรมเหมือนเดิมทุกจุด
