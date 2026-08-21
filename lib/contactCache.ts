/**
 * cache contact 2 ชั้น เพื่อลดจำนวนครั้งที่ต้องยิง GET /Contacts?code= (ช้า ~5s/call):
 *   1) ในหน่วยความจำ (เร็วสุด แต่หายเมื่อ dev server restart) — persist ผ่าน globalThis
 *      เหมือน getPeakClient() ในระหว่าง process เดียวกัน
 *   2) PostgreSQL ตาราง contact_cache (ไม่บังคับ ต้องตั้ง DATABASE_URL) — อยู่ข้าม restart
 *      ได้ ช่วยเวลา dev server เพิ่ง restart ให้ไม่ต้องเริ่มนับ 0 ใหม่ทุกครั้ง
 *
 * ไม่ cache ผลที่ error (network/API ล้มเหลว) เพื่อไม่ให้ค้างสถานะผิดพลาดไว้นานเกินจำเป็น
 */
import { getDb, safeDbWrite } from "./db";
import type { Contact } from "./peakClient";

const TTL_MS = 15 * 60 * 1000; // 15 นาที — พอลดจำนวน request ซ้ำได้มาก แต่ไม่ค้างข้อมูลนานเกินไป

interface CacheEntry {
  contact: Contact;
  fetchedAt: number;
}

const globalForCache = globalThis as unknown as { __contactCache?: Map<string, CacheEntry> };

function getMemCache(): Map<string, CacheEntry> {
  if (!globalForCache.__contactCache) {
    globalForCache.__contactCache = new Map();
  }
  return globalForCache.__contactCache;
}

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt <= TTL_MS;
}

/** คืน map ของ contact ที่แคชไว้แบบ batch โดยดึงจากแรมก่อน และยิง DB ด้วย SQL เดียวสำหรับ key ที่ขาด */
export async function getCachedContactsBatch(keys: string[]): Promise<Map<string, Contact>> {
  const result = new Map<string, Contact>();
  if (keys.length === 0) return result;

  const memCache = getMemCache();
  const missingKeys: string[] = [];

  for (const key of keys) {
    const mem = memCache.get(key);
    if (mem && isFresh(mem.fetchedAt)) {
      result.set(key, mem.contact);
    } else {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length === 0 || !process.env.DATABASE_URL) {
    return result;
  }

  try {
    const db = await getDb();
    const res = await db.query<{ key: string; contact: Contact; fetched_at: Date }>(
      "SELECT key, contact, fetched_at FROM contact_cache WHERE key = ANY($1)",
      [missingKeys]
    );
    for (const row of res.rows) {
      if (row.contact && isFresh(row.fetched_at.getTime())) {
        memCache.set(row.key, { contact: row.contact, fetchedAt: row.fetched_at.getTime() });
        result.set(row.key, row.contact);
      }
    }
  } catch (err) {
    console.warn("[contactCache] Batch lookup ล้มเหลว (ไม่บล็อกการทำงานหลัก):", err);
  }

  return result;
}

export function setCachedContact(key: string, contact: Contact): void {
  getMemCache().set(key, { contact, fetchedAt: Date.now() });

  // เขียนคู่ขนานลง DB แบบไม่บล็อก (ไม่ await จาก caller) — ให้ contact ล่าสุดชนะเสมอ
  void safeDbWrite((db) =>
    db
      .query(
        `INSERT INTO contact_cache (key, contact, fetched_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET contact = EXCLUDED.contact, fetched_at = EXCLUDED.fetched_at`,
        [key, JSON.stringify(contact)]
      )
      .then(() => undefined)
  );
}
