# PEAK e-Tax Auto Sender

Web App ส่งใบกำกับภาษีอิเล็กทรอนิกส์ (e-Tax) อัตโนมัติผ่าน PEAK Open API — Next.js 15 (App
Router) + TypeScript, deploy อยู่บน **Vercel** (production), PostgreSQL (Supabase) เป็น
แหล่งความจริงหลักของ "ใบไหนส่งแล้ว/ยัง"

## ฟีเจอร์หลัก
1. **ดึงใบเสร็จตามช่วงวันที่** จาก PEAK แล้วตรวจสอบอัตโนมัติว่าพร้อมส่ง e-Tax หรือไม่
   (contact ครบ/ถูกต้อง + มีการบันทึกรับชำระ/journal แล้ว) — ติ๊กเลือกแล้วกดส่งได้ทีละหลายใบ
2. **Import Excel Report** — อัปโหลดรายงานที่ export จากหน้าเว็บ PEAK เอง เพื่อดูสถานะ
   "ส่งแล้ว/ยังไม่ส่ง (Await)" ที่ PEAK API ไม่มี endpoint ให้เช็คโดยตรง แล้วส่ง e-Tax จากแถว
   Await ได้เลยในหน้าเดียวกัน (ดูหัวข้อ "Import Excel Report" ด้านล่าง)
3. **ผลออกใบจริงแบบ async ผ่าน callback** — หลังกดส่ง ระบบรอผลจริงจาก INET (ไม่ใช่แค่ PEAK
   รับคำขอ) แล้วอัปเดตสถานะให้อัตโนมัติทั้งหน้าเว็บและฐานข้อมูล
4. **บันทึกสถานะ "ส่งแล้ว" ด้วยมือ** สำหรับใบที่กดส่งผ่าน PEAK UI โดยตรง หรือ callback หลุดหาย
   (ดูหัวข้อ "บันทึกสถานะด้วยมือ")
5. **ลิงก์เอกสาร PEAK** คลิกที่เลขที่ใบเสร็จในตารางเพื่อเปิดดูใบจริงในเว็บ PEAK ได้ทันที
6. **PostgreSQL audit trail** เก็บประวัติผลตรวจ + ประวัติการส่งทุกครั้ง query ย้อนหลังได้

## Flow การทำงาน
1. เลือกช่วงวันที่ → ดึงใบเสร็จที่ **อนุมัติแล้ว (Approve)** เท่านั้นทุกหน้า
   `GET /Receipts/list?dateStart=&dateEnd=&status=3` (วน pagination จนครบ)
2. ตรวจสอบแต่ละใบแบบขนาน 2 อย่างพร้อมกัน:
   - **contact**: ดึงจาก `contactCode`/`contactId` → `GET /Contacts?code=` (cache ข้ามคำขอ 15 นาที)
   - **journal (บันทึกรับชำระ)**: ดึงใบเสร็จเต็มทีละใบ → `GET /Receipts?code=` เช็ค field
     `journals` (cache ข้ามคำขอ แบบ TTL ไม่เท่ากันตามผล — ดูหัวข้อ "ความเร็วในการดึงข้อมูล")
3. ติ๊กเลือกใบที่ต้องการ (default ติ๊กใบที่ผ่าน **และยังไม่เคยส่ง**) → กดส่ง →
   `POST /Receipts/etaxinvoice` ทีละใบ พร้อมแนบ `callbackUrl`/`keyReference`
4. หลังส่ง หน้าเว็บ poll `/api/etax-status` รอผลออกใบจริงจาก INET แล้วอัปเดตสถานะให้อัตโนมัติ

## การกันส่งซ้ำ + ประวัติการส่ง — PostgreSQL เป็นแหล่งความจริงหลัก (`lib/sendLog.ts`)
> ⚠️ `DATABASE_URL` เป็นค่าที่ **จำเป็นเสมอ** — Postgres คือแหล่งความจริงหลักเพียงที่เดียว
> ของ "ใบนี้ส่งแล้วหรือยัง" ไม่มีไฟล์สำรองอื่นใด (filesystem ของโปรเจกต์บน Vercel
> read-only ตอนรันจริง เขียนไฟล์ไม่ได้)

- ทุกการส่งถูกบันทึกลงตาราง **`send_log`** (เวลา, code, ผล, resCode/resDesc, phase) — เขียน
  แบบ **ต้องสำเร็จจริง** (ถ้า insert พลาดจะ throw ต่อ ไม่กลืน error ทิ้ง เพราะเป็นสำเนาเดียว
  ของ "ใบนี้เคยส่งแล้วหรือยัง" ถ้าเขียนพลาดแล้วเงียบไว้ เสี่ยงส่งซ้ำซ้อนจริง มีผลทางภาษี)
- ก่อนส่ง ระบบ **ข้ามใบที่เคยส่งสำเร็จแล้ว** อัตโนมัติ (รายงานเป็น "ข้าม") — บังคับส่งซ้ำได้ด้วย `force: true`
- หน้าเว็บ: ใบที่เคยส่งแสดงป้าย "Sent"/"Submitted" + ปิดติ๊กเลือก, ปุ่ม "ดูประวัติการส่ง"
- ⚠️ ใช้ log ฝั่งเราเป็นตัวตัดสิน เพราะ `taxStatus` ฝั่ง PEAK ไม่อัปเดตทันที (INET ออกใบแบบ async)

### เช็คสถานะ "ส่งแล้วหรือยัง" ผ่าน API (UI กับ API ใช้ log เดียวกัน)
- `GET /api/sent-codes` → รายการ code ที่ส่งสำเร็จแล้วทั้งหมด
- `GET /api/sent-status?codes=A,B,C` → เช็คหลายใบ คืน map + กลุ่ม sent/notSent
- `GET /api/sent-log?limit=200` → ประวัติการส่งทั้งหมด
- `POST /api/fetch` → แต่ละแถวมี `alreadySent` + `docStatus` (Approve เสมอ) ติดมาให้
- `GET /api/approved-receipts?dateStart=&dateEnd=` → เฉพาะใบที่สถานะ Approve (ดูหัวข้อ "สถานะเอกสาร")
- `GET /api/etax-status?codes=A,B,C` → สถานะออกใบจริง pending/issued/failed (ดูหัวข้อ callback)
- `POST /api/etax-callback` → endpoint รับผลออกใบจริงจาก INET · `GET` เดียวกัน = ดูผลย้อนหลัง
- `POST /api/mark-sent` → บันทึกสถานะ "ส่งแล้ว" ด้วยมือ (ดูหัวข้อ "บันทึกสถานะด้วยมือ")
- `POST /api/import-report` → parse ไฟล์ Excel ที่ export จาก PEAK (ดูหัวข้อ "Import Excel Report")

> ⚠️ ข้อจำกัด: log รู้เฉพาะใบที่ส่งผ่าน "แอปนี้" — ใบที่กดส่ง e-Tax เองผ่าน **PEAK UI**
> จะไม่อยู่ใน log และ **ตรวจจับอัตโนมัติไม่ได้** เพราะ PEAK API ไม่เปิดเผยสถานะ e-Tax เลย
> (ไม่มี endpoint ประวัติ/สถานะ e-tax ในเอกสาร PEAK, `taxStatus` เท่ากันหมดทั้งส่งแล้ว/ยังไม่ส่ง)
>
> แนวทางแก้ 2 ทาง ที่ระบบนี้ใช้จริงทั้งคู่: (1) callback จาก INET ตอนส่งผ่านแอปนี้เอง
> (ดูหัวข้อถัดไป) (2) **Import Excel Report** — อัปโหลดรายงานที่ PEAK export ให้มาเทียบ/sync
> เข้า log เอง สำหรับใบที่ส่งผ่าน PEAK UI ตรง ๆ (ดูหัวข้อ "Import Excel Report")

## PostgreSQL (`lib/db.ts`, `db/schema.sql`) — จำเป็นเสมอ
ใช้ **Supabase Postgres** บน production (ผ่าน Vercel Storage integration) — ต่อผ่าน connection
pooler (`pgbouncer`, port 6543) ไม่ใช่ direct host (`db.xxx.supabase.co`, IPv6-only ต่อจาก
Vercel ไม่ติด) เชื่อม TLS ด้วย `uselibpqcompat=true&sslmode=require` (บังคับความหมายเดิมของ
libpq คือเข้ารหัสอย่างเดียวไม่ verify cert — Supabase ส่ง cert chain ที่ Node ไม่เชื่อถือ
default, ไม่ใส่ param นี้จะเจอ `self-signed certificate in certificate chain`) —
`normalizeConnectionString()` ใน `lib/db.ts` เติม param พวกนี้ให้อัตโนมัติถ้า connection
string ที่ตั้งไว้ยังไม่มี

ตารางทั้งหมด (สร้างอัตโนมัติจาก `db/schema.sql` ตอนเริ่มทำงานครั้งแรก):

| ตาราง | หน้าที่ | เป็นแหล่งความจริงหลักไหม |
|---|---|---|
| **`send_log`** | ประวัติการส่ง e-Tax ทุกครั้ง (`phase=accepted`/`callback`) — ใช้ตัดสิน "ส่งแล้วหรือยัง" | ✅ ใช่ (เขียนพลาด = throw) |
| **`etax_callbacks`** | payload ดิบทุกครั้งที่ได้ callback จาก PEAK/INET | ✅ ใช่ |
| `receipt_checks` | ประวัติผลตรวจใบเสร็จทุกครั้งที่ `/api/fetch` ประมวลผล (append-only) — ตอบ "ใบนี้เคยมีสถานะอะไรบ้าง เปลี่ยนตอนไหน" | ❌ audit เสริม (`safeDbWrite`, ไม่ throw) |
| `contact_cache` | cache contact ข้าม restart (คู่กับ cache ในแรม) | ❌ cache เสริม |
| `receipt_journal_cache` | cache "มี journal แล้วหรือยัง" ต่อใบเสร็จ ข้าม restart | ❌ cache เสริม |

## ผลออกใบจริงแบบ async + callback (สำคัญ — `resCode 200 ≠ ออกใบสำเร็จ`) ✅
การส่ง e-Tax เป็น **asynchronous**: `POST /Receipts/etaxinvoice` ตอบ `resCode 200` = PEAK
**"รับคำขอ"** เท่านั้น การออกใบจริงผ่าน INET เกิดทีหลัง และ**อาจล้มเหลว**โดยที่ PEAK API
ไม่เปิดเผยผล → ต้องรับผลผ่าน **callback URL** เท่านั้น (ทดสอบกับ API จริงแล้ว)

**กลไก callback (ยืนยันกับ API จริง):**
- ส่ง field `url` ไปกับคำขอ (ตั้ง `ETAX_CALLBACK_URL` ใน env — บน production ชี้ตรงไปที่โดเมน
  Vercel เลย เช่น `https://<โดเมน>.vercel.app/api/etax-callback`)
- ระบบส่ง `keyReference = code` ทุกครั้ง → **PEAK ยิงค่านี้กลับมาใน HTTP header `Key-Reference`**
  (ไม่ใช่ใน body!) จึงผูกผล callback กับใบได้
- PEAK/INET ยิงผลกลับมาที่ `POST /api/etax-callback` — body เช่น
  `{"resCode":"303","resDesc":"Send E-Tax Invoice Incomplete","resError":{"eTaxErrorType":19,"message":"..."}}`
- ผล callback **บันทึกทับสถานะ** (`phase=callback`): `resCode 200` = ออกใบสำเร็จ (มี field
  `eTaxInvoice` แนบลิงก์ PDF/PDF-A3/XML จริงมาด้วย เก็บไว้ใน `send_log.pdf_url` ฯลฯ), อื่น ๆ
  = ล้มเหลว ใบที่ INET ตีกลับจะ **ไม่ถูกนับว่าส่งแล้ว** (`sent_codes` ใช้ entry ล่าสุดต่อ code)
  → ส่งซ้ำได้หลังแก้ข้อมูล

**สถานะต่อใบ — `GET /api/etax-status?codes=A,B,C`:**
| status | ความหมาย |
|---|---|
| `pending` | รับคำขอแล้ว (resCode 200) รอ INET ยิงผลกลับ |
| `issued` | callback resCode 200 = ออกใบสำเร็จจริง |
| `failed` | callback ≠ 200 (เช่น 303) หรือส่งล้มเหลวตั้งแต่ยิง |

**หน้าเว็บ (`lib/dashboard.ts` → `classifyRow`):** สถานะ "รอ callback" (`pending`) แสดงเป็น
badge **"Submitted"** (นับรวมใน bucket "Sent" ทันทีที่ PEAK ตอบรับ ไม่ต้องรอ INET ยืนยันก่อน
เพราะผู้ใช้ต้องการรู้ทันทีว่าส่งออกไปแล้ว) ต่างจาก **"Sent"** ที่ INET ยืนยันออกใบจริงแล้ว —
ถ้า INET ตีกลับทีหลัง จะเปลี่ยนเป็น Error ได้ (ไม่ได้ล็อกสถานะถาวรตอน submitted) กฎสำคัญ: ใบที่
เคย `status="issued"` แล้ว (callback ยืนยันแล้วจริง) จะแสดง "Sent" เสมอ **แม้ผลตรวจสอบข้อมูล
ปัจจุบัน** (เช่น journal ถูกแก้ทีหลัง) **จะไม่ผ่านก็ตาม** — ป้องกันใบที่ออกสำเร็จไปแล้วจริงถูก
ข้อมูล ณ ตอนนี้ทำให้กลายเป็น "Error" ย้อนหลัง

หลังกดส่ง หน้าเว็บ poll `/api/etax-status` ทุก 3 วิ ~45 วิ เพื่อแจ้ง **"ออกใบสำเร็จ X /
ส่งไม่ผ่าน Y"** ต่อใบพร้อมเหตุผล — ถ้า INET ยังไม่ตอบภายใน 45 วิ จะมี **background poll แยก
อีกชุด (ทุก 20 วิ ไม่มีกำหนดเวลาหมดอายุ)** คอยเช็คซ้ำให้อัตโนมัติต่อ ตราบใดที่ยังมีแถว
"Submitted"/Pending อยู่ในตาราง — ไม่ต้องกดรีเฟรชเองรอผล

**eTaxErrorType ที่เจอจริง:** `7` = Contact email invalid length · `19` = Contact tax number invalid data

> ⚠️ callback ต้องวิ่งกลับมาถึงแอปได้ → ต้องมี **public URL** แล้วตั้ง `ETAX_CALLBACK_URL`
> ชี้มาที่ `/api/etax-callback`. บน localhost callback ไปไม่ถึง (หน้าเว็บจะค้าง pending จนหมดเวลา)
> — ทดสอบดู payload จริงได้ด้วย **webhook.site** (ใช้ "endpoint URL" ไม่ใช่ลิงก์หน้า view)

## บันทึกสถานะ "ส่งแล้ว" ด้วยมือ — `POST /api/mark-sent` (`app/api/mark-sent/route.ts`)
สำหรับใบที่ยืนยันแล้วว่าออก e-Tax สำเร็จจริง (เช็คใน **PEAK UI** เจอ stamp ส่งแล้ว) แต่แอปนี้
ไม่เคยได้ callback ยืนยัน — เช่น ส่งผ่าน PEAK UI โดยตรง (ไม่ผ่านแอปนี้เลย) หรือ callback หลุด
หายไประหว่างทาง เขียน entry เป็น `phase="callback"` เหมือนผล callback จริงทุกประการ เพื่อให้
แอปแสดงสถานะ "Sent" ที่ยืนยันแล้ว (เขียว) แทนที่จะค้าง "Submitted" ตลอดไป

- รับได้ทั้งใบเดียว (`{"code": "RE..."}`) และหลายใบพร้อมกัน (`{"codes": ["RE...", ...]}`)
- ⚠️ นี่คือการ **override สถานะโดยมนุษย์** ไม่ใช่ผลจาก INET จริง — ต้องเช็คใน PEAK UI ก่อนเสมอ
  ว่าออกใบสำเร็จจริง ไม่ใช่แค่ "กดส่งไปแล้ว"
- หน้าเว็บเรียกปุ่มนี้ทั้งจากตารางหลัก (ทีละใบ/เลือกหลายใบ) และจากปุ่ม "sync" ในหน้า Import
  Excel Report (ดูหัวข้อถัดไป)

## Import Excel Report — `POST /api/import-report` (`app/api/import-report/route.ts`, `components/ImportReportPanel.tsx`)
PEAK Open API **ไม่มี endpoint ให้เช็คสถานะ e-Tax ของใบเสร็จเลย** (ตรวจสอบมาหลายทางแล้ว —
ไม่มีจริง ๆ) ฟีเจอร์นี้จึงใช้รายงาน Excel ที่ export จากหน้าเว็บ PEAK เอง (ที่มีคอลัมน์
"สถานะ e-Doc") เป็นแหล่งความจริงสำรอง

**รองรับ 2 รูปแบบรายงาน** ที่หัวคอลัมน์คนละภาษากัน (หาคอลัมน์ด้วย**ชื่อ** ไม่ใช่ index ตายตัว
เผื่อ PEAK สลับลำดับคอลัมน์ทีหลัง, หา header row แบบไดนามิกด้วย เผื่อมี metadata นำหน้าหลายแถว):
- **Tax Invoice Report** (`sale_taxInvoice_report_export...`) — หัวคอลัมน์อังกฤษ
- **Receipt Report** / รายงานใบเสร็จรับเงิน (`receipt_report_export...`) — หัวคอลัมน์ไทย

**ทำ 2 อย่างจากไฟล์เดียว:**
1. แถวที่สถานะ e-Doc = **"Await"/"ยังไม่ส่ง"** และสถานะเอกสาร = จ่ายแล้ว/สมบูรณ์แล้ว
   (allow-list `READY_STATUS_VALUES = {Paid, รับชำระแล้ว, Issued}` — ตัด Draft/ร่าง/Voided
   ออก โดยตั้งใจใช้ allow-list ไม่ใช่ block-list เพื่อกันค่าสถานะใหม่ที่ไม่รู้จักในอนาคตไว้
   ก่อนโดย default) → ดึงใบเสร็จเต็ม + contact จาก PEAK มาตรวจสอบ **เหมือนตารางหลักทุก
   ประการ** (ใช้ `buildRow` ตัวเดียวกัน: contact ครบ/ถูกต้อง + มี journal แล้ว) ก่อนอนุญาตให้
   ติ๊กส่งได้ — กันไม่ให้ส่งใบที่ข้อมูลไม่ครบผ่านทางลัดนี้ไปได้ (concurrency ต่ำกว่าตารางหลัก:
   6 แทน 12 เพราะ `GET /Receipts?code=` dedup ไม่ได้เหมือน contact, และ **บังคับดึงสดใหม่
   เสมอ ไม่ใช้ cache 15 นาที** เพราะความถูกต้องสำคัญกว่าความเร็วสำหรับการตัดสินใจก่อนส่งจริง)
2. แถวที่สถานะ e-Doc = **"Sent"/"ส่งแล้ว"** — แสดงตรงจากไฟล์เลย **ไม่ยิง PEAK API เพิ่ม**
   (ไฟล์เต็มเดือนมีเป็นพันแถว ไม่คุ้มและไม่จำเป็น) แล้วเทียบกับ `send_log` ของเราเอง หาใบที่
   เรายังไม่มีประวัติว่าส่งแล้ว (เช่น ส่งผ่าน PEAK UI ตรง ๆ) → ปุ่ม **"sync"** เรียก
   `/api/mark-sent` บันทึกให้ตรงกัน (ยืนยันด้วย `confirm()` ก่อนเสมอ)

**กรณีขัดแย้งกัน**: ถ้า log ของเราคิดว่าใบหนึ่ง `alreadySent` แต่รายงาน PEAK บอกว่ายัง
"Await" อยู่ (แปลว่าเราเคยยิงคำขอไปแล้ว PEAK รับ (resCode 200) แต่ไม่เคยได้ callback ยืนยันผล
จริงกลับมา) ระบบเชื่อ **รายงาน PEAK เป็น ground truth** มากกว่า log ตัวเอง และแจ้งผู้ใช้ว่าต้อง
**ส่งซ้ำแบบบังคับ (`force: true`)**

**ตัวกรองในหน้าเว็บ**: all / พร้อมส่ง / ไม่ผ่าน / ส่งแล้ว / รอผล / ส่งไม่สำเร็จ พร้อมนับจำนวน
ต่อกลุ่ม แถว "ส่งแล้ว" ได้ badge เขียว "ส่งสำเร็จ" (ไม่ใช่ error แดง) และไม่มีลิงก์เอกสาร
(เหตุผลด้านบน) ส่วนแถว Await ที่มีข้อมูลครบ คลิกเลขที่เอกสารเปิดดูใน PEAK ได้ทันที

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

## เงื่อนไขการบันทึกรับชำระ (journal) ก่อนส่งได้ (`lib/receipts.ts` → `buildRow`)
นอกจาก contact ต้องผ่านและเอกสารต้อง Approve แล้ว ใบเสร็จต้อง **มีการบันทึกรับชำระ (journal)
แล้วอย่างน้อย 1 รายการ** ถึงจะถือว่าพร้อมส่ง e-Tax — เป็นกติกาธุรกิจของระบบนี้เอง (field
`journals` ไม่มีใน `/Receipts/list` ต้องยิง `GET /Receipts?code=` แยกทีละใบเพิ่ม ดู
`fetchReceiptJournals`) ใบที่ Approve แล้วแต่ยังไม่มี journal จะแสดงเหตุผล
"ยังไม่มีการบันทึกรับชำระ (journal)" และติ๊กส่งไม่ได้

> ⚠️ ระบบ**ไม่**ใช้ `remainAmount` จาก `GET /Receipts?code=` เป็นตัวตัดสินสถานะชำระเงิน —
> ฟิลด์นี้ไม่น่าเชื่อถือ (พบเคสจริงที่ `paidPayments[]` บันทึกครบเต็มจำนวนแล้วแต่
> `remainAmount` ไม่ลดลงตาม) ใช้การมี journal เป็นตัวตัดสินแทน

## ความเร็วในการดึงข้อมูล — contact cache + journal cache (`lib/contactCache.ts`, `lib/receiptDetailCache.ts`) ✅
`GET /Contacts?code=` (ตรวจ contact ต่อใบ) เป็นคอขวดหลักของ `/api/fetch` (~5s/call) — ลอง
วิธี "ดึง contact ทั้งบัญชีแบบ list/page ล่วงหน้า" ดูแล้ว **ไม่ช่วย**: ดึง 1 หน้า (100
รายการ) ใช้เวลา ~14 วินาที พอ ๆ กับดึงทีละใบ ไม่คุ้มที่จะ sync ทั้งบัญชี (3,627 contact ใน
บัญชีทดสอบ)

สิ่งที่ช่วยจริงคือ **cache 2 ชั้น** (ในหน่วยความจำผ่าน `globalThis` + PostgreSQL อยู่ข้าม
restart ได้) สำหรับทั้ง contact และ journal:
- **contact**: TTL 15 นาที เพราะลูกค้าเดิมซ้ำกันมากทั้งในวันเดียวกันและข้ามวันที่ต่างกัน —
  ทดสอบจริง: ดึงวันเดียวกันซ้ำ (contact ทุกตัวมาจาก cache หมด) จาก **29.2s เหลือ 0.7s** (~40x)
- **journal**: TTL **ไม่เท่ากันตามผล** (asymmetric) เพราะ journal มีแต่จะ "ถูกเพิ่ม" ไม่ค่อย
  ถูกลบทีหลัง — `hasJournal=true` cache ได้นาน 24 ชม., `hasJournal=false` cache สั้นแค่ 5
  นาที (เผื่อมีการบันทึกรับชำระเข้ามาใหม่เร็ว ๆ นี้ ต้องเช็คซ้ำถี่กว่า)

ทั้งสอง cache **ไม่ cache ผล error** (network/API ล้มเหลว) เพื่อไม่ให้ค้างสถานะผิดพลาดไว้นาน
เกินจำเป็น และ `forceRefresh=true` (ปุ่ม "รีเฟรช" ในหน้าเว็บหลัก, และเสมอใน Import Excel
Report) จะข้าม cache ทั้งหมด ดึงสดใหม่จาก PEAK ทุกราย

## Resilience
- `PeakClient` (`lib/peakClient.ts`) มี **auto-retry + exponential backoff** (2,4,8,16s) เมื่อเจอ
  resCode 600 (token ติด throttle) — POST ปิด network-retry เพื่อกัน double-send
- ปรับ `CONTACT_FETCH_WORKERS` ให้ต่ำลงได้ถ้าเจอ resCode 600 บ่อย (ค่าเริ่มต้น 12 — คุม
  ความขนานของการตรวจ contact)
- **`getPeakClient()` ใช้ client เดียว (และ Client-Token เดียว) ร่วมกันทั้ง process** ผ่าน
  singleton บน `globalThis` แทนที่จะ `new PeakClient()` ต่อ request — PEAK อนุญาต
  Client-Token ที่ valid ได้ครั้งละ 1 ตัวต่อ connectId เท่านั้น มินต์ token ใหม่ต่อ request
  จะเจอ resCode 600 เป็นพัก ๆ เวลามีคำขอพร้อมกันหลายตัว
- หากเจอ `resCode 600 Invalid Client Token` ต่อเนื่องนาน = token โดน lockout/หมดอายุ
  → ไป regenerate ที่ PEAK Settings > API
- ทุก API route ที่อาจใช้เวลานาน (`/api/fetch`, `/api/send-etax`, `/api/import-report`)
  ตั้ง `export const maxDuration = 300;` เพื่อไม่ให้ Vercel ตัด function กลางคัน (ช่วงวันที่
  กว้าง/import ไฟล์ใหญ่วัดจริงแล้วใช้เวลาได้ถึงหลักนาที) — เพดานนี้ยังขึ้นกับแผน Vercel ที่ใช้ด้วย

> หมายเหตุ: list ส่ง `contactCode`/`contactId` มาให้แล้ว จึงไม่ต้องเรียก `GET /Receipts?code=`
> ซ้ำต่อใบเพื่ออ่าน contact — endpoint นี้ถูกเรียกอยู่ 2 จุด: (1) `fetchReceiptJournals`
> เพื่อเช็ค journal ตอนดึงรายการ (2) `POST /api/send-etax` เพื่อเอา `issuedDate` มาใช้เช็ค
> สถานะอนุมัติซ้ำก่อนส่งจริง (1 ครั้งต่อใบตอนกดส่งจริงเท่านั้น)

## เงื่อนไขการตรวจ contact (`lib/validators.ts`) — ผิดข้อใดข้อหนึ่ง = ไม่ผ่าน (ไม่ส่ง)
ร่วมทุกกลุ่ม: มีชื่อ (name) + type ต้องรู้จัก + ถ้ามีอีเมลต้องรูปแบบถูก (`"x@y.com Fax"` = ผิด)

แบ่งตาม `type` (enum ทางการ PEAK) เป็น 3 กลุ่ม:
| type | กลุ่ม | ที่อยู่ | taxid |
|---|---|---|---|
| **5** บุคคลธรรมดา | A | อย่างน้อย 1 ฟิลด์ | ไม่ต้อง |
| **2,3** บริษัท/บมจ. | B | ครบ 4 ฟิลด์ (ตำบล+อำเภอ+จังหวัด+ปณ.) | **ต้องมี** |
| **1,4,6,7,8,9,10,11** หจก./ร้านค้า/คณะบุคคล/อื่นๆ/หสน./มูลนิธิ/สมาคม/ร่วมค้า | C | ครบ 4 ฟิลด์ | ไม่ต้อง |

- branchCode ไม่บังคับทุกกลุ่ม (แต่ถ้ามีจะแสดงในหน้ารายละเอียด — `"00000"` = สำนักงานใหญ่,
  รหัสอื่น = สาขา, ดู `components/DetailPanel.tsx`) · กลุ่ม A รับที่อยู่ free-text (`address`) ด้วย
- กลุ่มแยกปรับได้ใน env: `CONTACT_TYPES_INDIVIDUAL` / `_FULL_TAX` / `_FULL_NOTAX`
- **`REQUIRE_TAXID_13DIGITS = true`** ใน `lib/validators.ts` (เปิดอยู่ ไม่ใช่ optional แล้ว) —
  ถ้า contact มี `taxNumber` (ไม่ว่ากลุ่มไหนจะบังคับต้องมีหรือไม่) ต้องเป็นเลข 13 หลักเท่านั้น
  เจอเคสจริง (`RE26072917`) บุคคลธรรมดาที่ไม่บังคับต้องมี taxNumber แต่มีค่าขยะ `"0"`
  ติดมา ซึ่งส่งจริงจะโดน INET ตีกลับ (`eTaxErrorType 19`) จึงต้องเช็คเสมอไม่ว่ากลุ่มไหน

ค่า `type` ที่พบจริงจากบัญชีทดสอบ: `5` = บุคคลธรรมดา, `2/3/7` = นิติบุคคล
(ปรับเพิ่มได้ใน env หากเจอ type อื่น — ใบที่ type ไม่อยู่ใน mapping จะถูกตีว่า "ไม่ผ่าน")

**`POST /api/send-etax` ตรวจซ้ำเสมอ** ก่อนส่งจริงทุกใบ (ไม่พึ่งพาผลจาก `/api/fetch` ฝั่ง
client เพราะอาจเป็นข้อมูลเก่าหรือถูกเรียกตรงจาก API) — เช็คด้วย **list status param**
(`fetchApprovedCodes` ต่อวันที่ออกใบ, cache ต่อ request กันยิงซ้ำ) **ไม่ใช้ฟิลด์ `status`
ของ `GET /Receipts?code=` ตรง ๆ** เพราะฟิลด์นี้เชื่อถือไม่ได้สำหรับเลขที่ใบเสร็จใช้ซ้ำ

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
- จึงไม่ต้องใส่ `PEAK_CLIENT_TOKEN` ใน env ก็ได้ (ปล่อยว่างไว้ ระบบ mint เอง)

PEAK ห่อ response จริงไว้ใน object ชั้นใน (`PeakReceipts` / `PeakContacts`) พร้อม `resCode`/`resDesc`
— `_unwrap()` ใน client จัดการแกะและตรวจ `resCode == "200"` ให้

## Deploy — Vercel + Supabase Postgres
โปรเจกต์นี้ deploy อยู่บน **Vercel** (auto-deploy ทุกครั้งที่ push ขึ้น branch `main` บน
GitHub) ไม่มี ngrok/cloudflared tunnel หรือ Power Automate relay อีกต่อไปแล้ว —
PEAK/INET ยิง callback **ตรง** มาที่โดเมน Vercel เลย (ดูหัวข้อ callback ด้านบน)

**Environment variables ที่ต้องตั้งใน Vercel** (Project Settings → Environment Variables,
แยกกันระหว่าง Production/Preview — ตั้งแยกจาก `.env` local ซึ่งไม่มีผลกับแอปที่ deploy แล้ว):
- `PEAK_CONNECT_ID`, `PEAK_USER_TOKEN`, `PEAK_CONNECT_KEY` (และ `PEAK_CLIENT_TOKEN` ถ้ามี — ปกติปล่อยว่าง)
- `DATABASE_URL` — connection string ของ Supabase **pooler** (port 6543, ไม่ใช่ direct host
  port 5432 ซึ่ง IPv6-only ต่อจาก Vercel ไม่ติด `ENOTFOUND`/`ETIMEDOUT`)
- `ETAX_CALLBACK_URL` — `https://<โดเมน>.vercel.app/api/etax-callback`
- `ETAX_CONNECT_TYPE`, `ETAX_IS_UPDATE_DOCUMENT`, `CONTACT_FETCH_WORKERS`,
  `CONTACT_TYPES_INDIVIDUAL`/`_FULL_TAX`/`_FULL_NOTAX` ถ้าปรับต่างจาก default

**ตั้งฐานข้อมูลครั้งแรก**: รัน `db/schema.sql` ผ่าน Supabase SQL editor หรือ DBeaver หรือ
ปล่อยให้แอปสร้างเองอัตโนมัติตอน request แรกก็ได้

## ติดตั้งและรันเครื่อง local (dev)
```bash
npm install
cp .env.example .env          # ใส่ค่า PEAK_CONNECT_ID / PEAK_USER_TOKEN / PEAK_CONNECT_KEY / DATABASE_URL
npm run dev                   # เปิด http://localhost:3000 (production: npm run build && npm start)
```
> ⚠️ `DATABASE_URL` **จำเป็นเสมอ** (ดูหัวข้อ PostgreSQL ด้านบน) — ไม่ตั้งแอปจะพังตอนบันทึก/
> เช็คสถานะการส่ง เพราะ Postgres คือแหล่งความจริงหลัก
>
> callback จาก PEAK/INET **ไปไม่ถึง localhost** (ไม่มี public URL) — ทดสอบส่งจริงบนเครื่อง
> local จะค้าง "Submitted" รอผลจนหมดเวลา แนะนำทดสอบ flow ครบวงจรบน Vercel deployment แทน
>
> 1 วันที่มีใบเสร็จเยอะ (เช่น ~145 ใบ) การดึง+ตรวจใช้เวลาราว 1 นาที (เพราะ contact/journal
> API ช้า) ปรับความเร็วได้ที่ `CONTACT_FETCH_WORKERS`

## ค่า etaxConnectType (ทดสอบกับ API จริงแล้ว ✅)
| ค่า | ความหมาย | ผลทดสอบ |
|---|---|---|
| **2** | ส่งผ่าน **INET** | resCode 200 Success |
| 1 | (ไม่ใช่ INET) | resCode 500 internal error |

`ETAX_CONNECT_TYPE=2` ตั้งไว้แล้ว — ถ้ากิจการใช้ช่องทางอื่น (เช่น e-Tax by Email) ค่าจะต่างออกไป
การส่งเป็นแบบ **asynchronous** (resCode 200 = PEAK รับคำขอแล้ว, การออกใบจริงผ่าน INET เกิดภายหลัง)

## ไฟล์ (Next.js / TypeScript)
| ไฟล์ | หน้าที่ |
|---|---|
| `app/page.tsx` | หน้าเว็บหลัก (React client component) — ตารางใบเสร็จ, ติ๊กเลือก/ส่ง, poll สถานะ |
| `app/api/fetch/route.ts` | ดึงใบเสร็จ (Approve) + ตรวจ contact/journal ทั้งช่วงวันที่ |
| `app/api/send-etax/route.ts` | ส่ง e-Tax ทีละใบตาม code ที่เลือก พร้อมตรวจ Approve ซ้ำ |
| `app/api/etax-callback/route.ts` | รับผลออกใบจริง async จาก PEAK/INET (`POST`) + ดูประวัติ (`GET`) |
| `app/api/etax-status/route.ts` | สถานะออกใบจริงต่อ code (pending/issued/failed) สำหรับ poll |
| `app/api/import-report/route.ts` | parse ไฟล์ Excel รายงานจาก PEAK + ตรวจสอบแถว Await |
| `app/api/mark-sent/route.ts` | บันทึกสถานะ "ส่งแล้ว" ด้วยมือ (override) |
| `app/api/approved-receipts/route.ts` | รายการใบเสร็จ Approve ดิบ (ไม่ตรวจ contact) |
| `app/api/sent-log`, `sent-codes`, `sent-status/route.ts` | อ่านประวัติการส่งจาก `send_log` |
| `lib/peakClient.ts` | client เรียก PEAK API + เซ็น HMAC + แกะ response + mint Client-Token อัตโนมัติ |
| `lib/receipts.ts` | ดึง/cache contact + journal แบบขนาน, ประกอบแถวผลลัพธ์ (`buildRow`), `fetchApprovedCodes` |
| `lib/validators.ts` | กติกาตรวจ contact ตาม type |
| `lib/sendLog.ts` | บันทึกผลการส่ง + กันส่งซ้ำ + ผล callback — **Postgres ล้วน** (`send_log`/`etax_callbacks`) |
| `lib/dashboard.ts` | utility ฝั่ง client: จัดกลุ่มสถานะแถว (`classifyRow`), format วันที่/จำนวนเงิน |
| `lib/config.ts` | โหลด env |
| `lib/contactCache.ts` | cache contact 2 ชั้น (memory + Postgres) TTL 15 นาที |
| `lib/receiptDetailCache.ts` | cache "มี journal แล้วหรือยัง" 2 ชั้น TTL ไม่เท่ากันตามผล |
| `lib/db.ts` | pool เชื่อมต่อ PostgreSQL + normalize connection string (SSL) + สร้างตารางอัตโนมัติ + `safeDbWrite` |
| `db/schema.sql` | schema ทั้งหมด (`send_log`/`etax_callbacks`/`receipt_checks`/`contact_cache`/`receipt_journal_cache`) |
| `components/ImportReportPanel.tsx` | UI หน้าต่าง Import Excel Report (อัปโหลด/ตัวกรอง/ส่ง/sync) |
| `components/DetailPanel.tsx` | แผงรายละเอียดใบเสร็จ (ที่อยู่, สาขา/สำนักงานใหญ่, เหตุผลไม่ผ่าน) |
| `components/Topbar.tsx` | แถบด้านบน (เลือกช่วงวันที่, ปุ่มรีเฟรช, เปิด Import Report) |
