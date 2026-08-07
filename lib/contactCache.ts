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

/** คืน contact ที่ cache ไว้ ถ้ายังไม่หมดอายุ (เช็คแรมก่อน แล้วค่อย DB) — undefined = cache miss */
export async function getCachedContact(key: string): Promise<Contact | undefined> {
  const mem = getMemCache().get(key);
  if (mem && isFresh(mem.fetchedAt)) return mem.contact;

  if (!process.env.DATABASE_URL) return undefined;
  try {
    const db = await getDb();
    const res = await db.query<{ contact: Contact; fetched_at: Date }>(
      "SELECT contact, fetched_at FROM contact_cache WHERE key = $1",
      [key]
    );
    const row = res.rows[0];
    if (!row || !isFresh(row.fetched_at.getTime())) return undefined;
    getMemCache().set(key, { contact: row.contact, fetchedAt: row.fetched_at.getTime() }); // อุ่นแรมไว้ด้วย
    return row.contact;
  } catch {
    return undefined; // DB ใช้ไม่ได้ตอนนี้ -> ถือเป็น cache miss ไปเลย ไม่บล็อกการทำงานหลัก
  }
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
