#!/usr/bin/env node
/**
 * สคริปต์เดี่ยว (ไม่ผ่าน Next.js) สำหรับ:
 *   1) ทดสอบว่าต่อ PostgreSQL ได้จริง + สร้างตารางจาก db/schema.sql
 *   2) ย้ายประวัติเดิมจาก sent_log.jsonl + etax_callback.jsonl เข้า DB ครั้งเดียว
 *      (แอป Next.js เขียนคู่ขนานเฉพาะรายการใหม่ตั้งแต่ตอนติดตั้งฟีเจอร์นี้ — ประวัติเก่า
 *      ก่อนหน้านั้นต้อง backfill เอาเองด้วยสคริปต์นี้)
 *
 * รัน:  node scripts/backfill-db.js
 * ต้องตั้ง DATABASE_URL ใน .env ก่อน (สคริปต์นี้อ่าน .env เองแบบง่าย ๆ ไม่ต้องพึ่ง Next.js)
 *
 * หมายเหตุ: สคริปต์นี้ TRUNCATE send_log/etax_callbacks ก่อนย้ายข้อมูลทุกครั้ง (ย้ายใหม่ทั้งหมด
 * จากไฟล์ .jsonl เสมอ ไม่ใช่เติมต่อ) ปลอดภัยสำหรับ backfill ตอนเริ่มตั้ง DB ใหม่ แต่ห้ามรันซ้ำ
 * หลังแอปเริ่มเขียนข้อมูลจริงลง DB นี้แล้ว เพราะจะลบข้อมูลจริงทิ้งไปด้วย
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const entries = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      console.warn(`  [ข้าม] parse ไม่ได้: ${trimmed.slice(0, 80)}...`);
    }
  }
  return entries;
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    console.error("ไม่พบ DATABASE_URL ใน .env — ตั้งค่าก่อนรันสคริปต์นี้");
    process.exit(1);
  }

  // ผู้ให้บริการ cloud (เช่น Supabase pooler) ส่ง cert chain ที่ Node ไม่เชื่อถือ default —
  // ต้องบังคับความหมายเดิมของ libpq (เข้ารหัสอย่างเดียว ไม่ verify cert) ผ่าน uselibpqcompat
  // ไม่งั้นเจอ "self-signed certificate in certificate chain" ต่อไม่ติดเลย
  const dbUrl = new URL(process.env.DATABASE_URL);
  if (!dbUrl.searchParams.has("uselibpqcompat")) dbUrl.searchParams.set("uselibpqcompat", "true");
  if (!dbUrl.searchParams.has("sslmode")) dbUrl.searchParams.set("sslmode", "require");
  const pool = new Pool({ connectionString: dbUrl.toString() });

  console.log("กำลังต่อ PostgreSQL...");
  await pool.query("SELECT 1"); // ทดสอบการเชื่อมต่อ
  console.log("ต่อสำเร็จ ✓");

  console.log("กำลังสร้างตาราง (ถ้ายังไม่มี) จาก db/schema.sql...");
  const schemaSql = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf-8");
  await pool.query(schemaSql);
  console.log("ตารางพร้อม ✓");

  // แบ่งเป็นชุด (batch) แทนการ insert ทีละแถว — ทีละแถวคือ 1 round-trip เครือข่ายต่อแถว ถ้า DB
  // อยู่ต่างประเทศ (เช่น Supabase us-east-1) หลักพันแถวจะใช้เวลาเป็นสิบนาที ส่วน batch ละ 500
  // แถวลดจำนวน round-trip เหลือหลักสิบครั้งเท่านั้น เร็วขึ้นมาก
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // ล้างของเดิมก่อนเสมอ กันข้อมูลซ้ำจากการรันค้างไว้ก่อนหน้า/รันซ้ำ — ตั้งใจให้ backfill นี้
  // เป็น "ย้ายทั้งหมดใหม่ตั้งแต่ต้น" ไม่ใช่ "เติมต่อจากที่มีอยู่"
  console.log("\nกำลังล้างข้อมูลเดิมใน send_log/etax_callbacks (ถ้ามี) ก่อน backfill ใหม่...");
  await pool.query("TRUNCATE TABLE send_log, etax_callbacks");

  // ---------- sent_log.jsonl -> send_log ----------
  const sentEntries = readJsonl(path.join(ROOT, "sent_log.jsonl")).filter((e) => e.code);
  console.log(`\nพบ ${sentEntries.length} รายการใน sent_log.jsonl`);
  const COLS_SENT = 9;
  let sentInserted = 0;
  for (const batch of chunk(sentEntries, 500)) {
    const values = [];
    const placeholders = batch.map((e, i) => {
      const base = i * COLS_SENT;
      values.push(
        e.code,
        Boolean(e.success),
        e.resCode != null ? String(e.resCode) : null,
        e.resDesc ?? null,
        e.phase ?? "accepted",
        e.pdfUrl ?? null,
        e.pdfA3Url ?? null,
        e.xmlUrl ?? null,
        e.timestampUtc ?? e.timestamp ?? new Date().toISOString()
      );
      return `(${Array.from({ length: COLS_SENT }, (_, j) => `$${base + j + 1}`).join(", ")})`;
    });
    await pool.query(
      `INSERT INTO send_log (code, success, res_code, res_desc, phase, pdf_url, pdf_a3_url, xml_url, created_at)
       VALUES ${placeholders.join(", ")}`,
      values
    );
    sentInserted += batch.length;
    process.stdout.write(`  ${sentInserted}/${sentEntries.length}\r`);
  }
  console.log(`บันทึกลง send_log แล้ว ${sentInserted} แถว          `);

  // ---------- etax_callback.jsonl -> etax_callbacks ----------
  const callbackEntries = readJsonl(path.join(ROOT, "etax_callback.jsonl"));
  console.log(`\nพบ ${callbackEntries.length} รายการใน etax_callback.jsonl`);
  const COLS_CB = 3;
  let callbackInserted = 0;
  for (const batch of chunk(callbackEntries, 500)) {
    const values = [];
    const placeholders = batch.map((e, i) => {
      const base = i * COLS_CB;
      values.push(e.code || null, JSON.stringify(e.payload ?? {}), e.receivedAt ?? new Date().toISOString());
      return `(${Array.from({ length: COLS_CB }, (_, j) => `$${base + j + 1}`).join(", ")})`;
    });
    await pool.query(
      `INSERT INTO etax_callbacks (code, payload, received_at) VALUES ${placeholders.join(", ")}`,
      values
    );
    callbackInserted += batch.length;
    process.stdout.write(`  ${callbackInserted}/${callbackEntries.length}\r`);
  }
  console.log(`บันทึกลง etax_callbacks แล้ว ${callbackInserted} แถว          `);

  console.log(
    `\nหมายเหตุ: ตาราง receipt_checks ไม่มีการ backfill เพราะไฟล์ .jsonl เดิมไม่เคยเก็บ` +
      ` ประวัติผลตรวจใบเสร็จแบบนี้มาก่อน (เป็นฟีเจอร์ใหม่) — receipt_checks จะเริ่มมีข้อมูล` +
      ` ตั้งแต่ /api/fetch ครั้งแรกหลังตั้งค่า DATABASE_URL เท่านั้น`
  );

  await pool.end();
  console.log("\nเสร็จสิ้น ✓");
}

main().catch((err) => {
  console.error("เกิดข้อผิดพลาด:", err);
  process.exit(1);
});
