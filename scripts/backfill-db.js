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
 * หมายเหตุ: รันซ้ำจะ insert ซ้ำ (ไม่มีการกันซ้ำ) เพราะตารางนี้เป็น append-only log
 * ตั้งใจให้รันครั้งเดียวตอน backfill ประวัติเก่า
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

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log("กำลังต่อ PostgreSQL...");
  await pool.query("SELECT 1"); // ทดสอบการเชื่อมต่อ
  console.log("ต่อสำเร็จ ✓");

  console.log("กำลังสร้างตาราง (ถ้ายังไม่มี) จาก db/schema.sql...");
  const schemaSql = fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf-8");
  await pool.query(schemaSql);
  console.log("ตารางพร้อม ✓");

  // ---------- sent_log.jsonl -> send_log ----------
  const sentEntries = readJsonl(path.join(ROOT, "sent_log.jsonl"));
  console.log(`\nพบ ${sentEntries.length} รายการใน sent_log.jsonl`);
  let sentInserted = 0;
  for (const e of sentEntries) {
    if (!e.code) continue;
    await pool.query(
      `INSERT INTO send_log (code, success, res_code, res_desc, phase, pdf_url, pdf_a3_url, xml_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.code,
        Boolean(e.success),
        e.resCode != null ? String(e.resCode) : null,
        e.resDesc ?? null,
        e.phase ?? "accepted",
        e.pdfUrl ?? null,
        e.pdfA3Url ?? null,
        e.xmlUrl ?? null,
        e.timestampUtc ?? e.timestamp ?? new Date().toISOString(),
      ]
    );
    sentInserted++;
  }
  console.log(`บันทึกลง send_log แล้ว ${sentInserted} แถว`);

  // ---------- etax_callback.jsonl -> etax_callbacks ----------
  const callbackEntries = readJsonl(path.join(ROOT, "etax_callback.jsonl"));
  console.log(`\nพบ ${callbackEntries.length} รายการใน etax_callback.jsonl`);
  let callbackInserted = 0;
  for (const e of callbackEntries) {
    await pool.query(`INSERT INTO etax_callbacks (code, payload, received_at) VALUES ($1, $2, $3)`, [
      e.code || null,
      JSON.stringify(e.payload ?? {}),
      e.receivedAt ?? new Date().toISOString(),
    ]);
    callbackInserted++;
  }
  console.log(`บันทึกลง etax_callbacks แล้ว ${callbackInserted} แถว`);

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
