/**
 * cache "มี journal (บันทึกรับชำระ) แล้วหรือยัง" ต่อใบเสร็จ 2 ชั้นเหมือน contactCache.ts
 * (memory + Postgres) — ต่างจาก contact ตรงที่ใบเสร็จแต่ละใบไม่ซ้ำกันเลย (dedup ไม่ได้ในการ
 * ดึงครั้งเดียว) แต่ยัง cache ไว้ช่วยตอน fetch ช่วงวันที่เดิมซ้ำ (รีเฟรชบ่อย ๆ) ได้
 *
 * TTL ไม่เท่ากันตามผลลัพธ์ (asymmetric) เพราะ journal มีแต่จะ "ถูกเพิ่ม" ไม่ค่อยถูกลบทีหลัง:
 *   - hasJournal=true  -> cache ได้นาน (24 ชม.) แทบไม่มีทางเปลี่ยนกลับเป็น false อีก
 *   - hasJournal=false -> cache สั้น (5 นาที) เพราะพรุ่งนี้/อีกไม่กี่นาทีอาจมีการบันทึก
 *     รับชำระเข้ามาใหม่ ต้องเช็คซ้ำถี่กว่าเพื่อให้เห็นผลเร็วหลังบันทึกรับชำระจริง
 * ผลคือใบที่เคยเช็คแล้วว่ามี journal จะไม่ต้องยิง PEAK ซ้ำอีกเลยในทางปฏิบัติ ลดภาระตอนดึง
 * ช่วงวันที่เดิมซ้ำ (ซึ่งเกิดบ่อยมาก) ได้เยอะ โดยไม่กระทบความไวในการเห็นใบที่เพิ่งจ่ายเงิน
 */
import { getDb, safeDbWrite } from "./db";

const TTL_MS_HAS_JOURNAL = 24 * 60 * 60 * 1000; // 24 ชม.
const TTL_MS_NO_JOURNAL = 5 * 60 * 1000; // 5 นาที

interface CacheEntry {
  hasJournal: boolean;
  fetchedAt: number;
}

const globalForCache = globalThis as unknown as { __receiptJournalCache?: Map<string, CacheEntry> };

function getMemCache(): Map<string, CacheEntry> {
  if (!globalForCache.__receiptJournalCache) {
    globalForCache.__receiptJournalCache = new Map();
  }
  return globalForCache.__receiptJournalCache;
}

function isFresh(fetchedAt: number, hasJournal: boolean): boolean {
  const ttl = hasJournal ? TTL_MS_HAS_JOURNAL : TTL_MS_NO_JOURNAL;
  return Date.now() - fetchedAt <= ttl;
}

export async function getCachedReceiptJournal(code: string): Promise<boolean | undefined> {
  const mem = getMemCache().get(code);
  if (mem && isFresh(mem.fetchedAt, mem.hasJournal)) return mem.hasJournal;

  if (!process.env.DATABASE_URL) return undefined;
  try {
    const db = await getDb();
    const res = await db.query<{ has_journal: boolean; fetched_at: Date }>(
      "SELECT has_journal, fetched_at FROM receipt_journal_cache WHERE code = $1",
      [code]
    );
    const row = res.rows[0];
    if (!row || !isFresh(row.fetched_at.getTime(), row.has_journal)) return undefined;
    getMemCache().set(code, { hasJournal: row.has_journal, fetchedAt: row.fetched_at.getTime() });
    return row.has_journal;
  } catch {
    return undefined;
  }
}

export function setCachedReceiptJournal(code: string, hasJournal: boolean): void {
  getMemCache().set(code, { hasJournal, fetchedAt: Date.now() });

  void safeDbWrite((db) =>
    db
      .query(
        `INSERT INTO receipt_journal_cache (code, has_journal, fetched_at) VALUES ($1, $2, now())
         ON CONFLICT (code) DO UPDATE SET has_journal = EXCLUDED.has_journal, fetched_at = EXCLUDED.fetched_at`,
        [code, hasJournal]
      )
      .then(() => undefined)
  );
}
