-- e-tax-web audit database schema
-- รันไฟล์นี้ผ่าน DBeaver (หรือ psql) เพื่อสร้างตารางล่วงหน้าได้ — แต่ไม่จำเป็นต้องรันเอง
-- เพราะแอปจะสร้างตารางให้อัตโนมัติ (CREATE TABLE IF NOT EXISTS) ตอนเริ่มทำงานครั้งแรกอยู่แล้ว
-- ไฟล์นี้มีไว้เพื่อให้ดู schema ได้ตรง ๆ และรันเองล่วงหน้าได้ถ้าต้องการ

-- ประวัติผลตรวจใบเสร็จทุกครั้งที่ /api/fetch ดึงมา (append-only — ไม่ update ทับ)
-- ใช้ตอบคำถาม "ใบนี้เคยมีสถานะอะไรบ้าง เปลี่ยนตอนไหน" ซึ่ง PEAK เองตอบไม่ได้
CREATE TABLE IF NOT EXISTS receipt_checks (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT NOT NULL,
  issued_date   TEXT,
  net_amount    NUMERIC,
  contact_code  TEXT,
  contact_name  TEXT,
  contact_type  TEXT,          -- juristic | ordinary | unknown
  doc_status    TEXT,          -- Approve เสมอ (แอปดึงเฉพาะ Approve)
  already_sent  BOOLEAN NOT NULL,
  valid         BOOLEAN NOT NULL,
  reason        TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receipt_checks_code ON receipt_checks (code, checked_at DESC);

-- ประวัติการส่ง e-Tax ทุกครั้ง (คู่ขนานกับ sent_log.jsonl)
CREATE TABLE IF NOT EXISTS send_log (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  success     BOOLEAN NOT NULL,
  res_code    TEXT,
  res_desc    TEXT,
  phase       TEXT NOT NULL,   -- accepted | callback
  pdf_url     TEXT,
  pdf_a3_url  TEXT,
  xml_url     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_send_log_code ON send_log (code, created_at DESC);

-- payload ดิบทุกครั้งที่ได้ callback จาก PEAK/INET (คู่ขนานกับ etax_callback.jsonl)
CREATE TABLE IF NOT EXISTS etax_callbacks (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT,           -- keyReference จาก header Key-Reference
  payload      JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_etax_callbacks_code ON etax_callbacks (code, received_at DESC);

-- cache contact แบบ persist ข้าม restart (ต่างจาก receipt_checks/send_log/etax_callbacks
-- ตารางนี้ "update ทับ" ไม่ append — เก็บแค่ค่าล่าสุดต่อ contact 1 รายการ)
-- ใช้คู่กับ cache ในหน่วยความจำ (lib/contactCache.ts) เพื่อลดจำนวนครั้งที่ต้องยิง
-- GET /Contacts?code= (~5s/call) — โดยเฉพาะตอน dev server เพิ่ง restart ที่ cache ในแรม
-- หายหมด แต่ข้อมูลใน DB ยังอยู่
CREATE TABLE IF NOT EXISTS contact_cache (
  key         TEXT PRIMARY KEY,   -- contactId หรือ contactCode
  contact     JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
