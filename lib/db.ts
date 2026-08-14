/**
 * เชื่อมต่อ PostgreSQL — เป็นแหล่งความจริงหลักของ send_log/etax_callbacks (ดู lib/sendLog.ts)
 * เพราะ deploy บน Vercel แล้ว filesystem ของโปรเจกต์ read-only ตอนรันจริง เขียนไฟล์ .jsonl
 * แบบเดิมไม่ได้อีกต่อไป — DATABASE_URL จึงจำเป็นเสมอ ไม่ใช่แค่เสริมแล้ว
 *
 * ตารางอื่น (receipt_checks, contact_cache, receipt_journal_cache) ยังเป็น audit/cache เสริม
 * เหมือนเดิม เขียนผ่าน safeDbWrite() ที่ไม่ throw ถ้าพลาด เพราะไม่ใช่แหล่งความจริงหลัก
 */
import { readFileSync } from "fs";
import path from "path";
import { Pool } from "pg";

const globalForDb = globalThis as unknown as {
  __pgPool?: Pool;
  __pgSchemaReady?: Promise<void>;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * ผู้ให้บริการ Postgres แบบ cloud (Supabase/Neon ฯลฯ) มักส่ง cert chain ที่ root CA ไม่อยู่ใน
 * ชุดที่ Node เชื่อถือ default (self-signed/intermediate) — เจอจริงกับ Supabase pooler:
 * "self-signed certificate in certificate chain" แม้ตั้ง sslmode=require ไว้แล้วก็ตาม เพราะ
 * pg-connection-string เวอร์ชันปัจจุบันเริ่มตีความ require/prefer เป็น verify-full (ตรวจ cert
 * เต็มรูปแบบ) — ต้องบังคับใช้ความหมายเดิมของ libpq (เข้ารหัสอย่างเดียว ไม่ verify cert) ผ่าน
 * uselibpqcompat=true ถึงจะต่อผ่าน
 *
 * ใช้เฉพาะตอนต่อ host ที่ไม่ใช่ local เท่านั้น — Postgres ที่รันบนเครื่องเอง (127.0.0.1) ปกติ
 * ไม่ได้เปิด SSL ไว้ บังคับ sslmode=require ใส่ไปจะพังทันที ("server does not support SSL
 * connections") จึงต้องแยกกรณี local ออกไปเลย ไม่แตะ connection string
 */
function normalizeConnectionString(raw: string): string {
  try {
    const url = new URL(raw);
    if (LOCAL_HOSTS.has(url.hostname)) return raw;
    if (!url.searchParams.has("uselibpqcompat")) url.searchParams.set("uselibpqcompat", "true");
    if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
    return url.toString();
  } catch {
    return raw; // parse ไม่ได้ (รูปแบบแปลก) -> ใช้ค่าดิบไปตามเดิม
  }
}

function getPool(): Pool {
  if (!globalForDb.__pgPool) {
    const rawConnectionString = process.env.DATABASE_URL;
    if (!rawConnectionString) {
      throw new Error("ไม่พบ DATABASE_URL ใน .env — ตั้งค่า connection string ของ PostgreSQL ก่อนใช้งาน");
    }
    const connectionString = normalizeConnectionString(rawConnectionString);
    // default ของ pg คือ max 10 connections — ไม่พอสำหรับ fetchContacts ที่ยิง cache-lookup
    // query พร้อมกันหลักร้อยตัวตอนดึงช่วงวันที่กว้าง (เช่น 10 วันมีได้หลายร้อย contact ไม่ซ้ำ)
    // ทำให้ query ต้องรอคิวรับ connection แทนที่จะยิงพร้อมกันได้จริง
    globalForDb.__pgPool = new Pool({ connectionString, max: 30 });
  }
  return globalForDb.__pgPool;
}

/** สร้างตาราง (ถ้ายังไม่มี) จาก db/schema.sql — รันครั้งเดียวต่อ process แล้ว cache ผลไว้ */
function ensureSchema(): Promise<void> {
  if (!globalForDb.__pgSchemaReady) {
    const sql = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf-8");
    globalForDb.__pgSchemaReady = getPool()
      .query(sql)
      .then(() => undefined);
  }
  return globalForDb.__pgSchemaReady;
}

/** ต่อ DB + รับประกันว่ามีตารางแล้ว ก่อนคืน pool ให้ query ต่อ */
export async function getDb(): Promise<Pool> {
  const pool = getPool();
  await ensureSchema();
  return pool;
}

/**
 * ใช้ห่อการเขียนลง DB ที่เป็น audit/cache เสริมเท่านั้น (receipt_checks, contact_cache,
 * receipt_journal_cache) — ถ้าต่อ DB ไม่ได้หรือ query พลาด จะ log แค่ warning ไม่ throw ต่อ
 * เพราะไม่ใช่แหล่งความจริงหลัก (ต่างจาก send_log/etax_callbacks ใน lib/sendLog.ts ที่ throw
 * ตรง ๆ เพราะเป็นสำเนาเดียวของ "ใบนี้ส่งแล้วหรือยัง")
 */
export async function safeDbWrite(fn: (db: Pool) => Promise<void>): Promise<void> {
  try {
    const db = await getDb();
    await fn(db);
  } catch (exc) {
    console.warn("[db] เขียนลง PostgreSQL ไม่สำเร็จ (ไม่กระทบการทำงานหลัก):", exc);
  }
}
