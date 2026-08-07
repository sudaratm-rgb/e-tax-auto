/**
 * PEAK Open API client
 *
 * ทุก request ต้องแนบ 4 headers:
 *   - Time-Stamp      : เวลาปัจจุบันรูปแบบ yyyyMMddHHmmss (UTC)
 *   - Time-Signature  : HMAC-SHA1(message=Time-Stamp, key=connectId) -> hex
 *   - User-Token      : token จาก PEAK
 *   - Client-Token    : token จาก PEAK
 */
import { createHmac } from "crypto";
import { settings } from "./config";

export class PeakAPIError extends Error {
  resCode: string;
  constructor(message: string, resCode: string = "") {
    super(message);
    this.name = "PeakAPIError";
    this.resCode = resCode;
  }
}

// resCode ที่ "ลองใหม่ได้" (ชั่วคราว เช่น throttle / token ติดจังหวะ)
const RETRYABLE_RES_CODES = new Set(["600"]);
const MAX_RETRIES = 4; // จำนวนครั้งที่ลองซ้ำ
const RETRY_BASE_DELAY = 2.0; // หน่วงเริ่มต้น (วินาที) แล้วเพิ่มเป็นเท่าตัว: 2,4,8,16

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sign(): Record<string, string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14); // yyyyMMddHHmmss (UTC)
  const signature = createHmac("sha1", settings.connectId).update(timestamp).digest("hex");
  return {
    "Time-Stamp": timestamp,
    "Time-Signature": signature,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(payload: any, context: string): any {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new PeakAPIError(`${context}: รูปแบบ response ไม่ถูกต้อง`);
  }

  let inner = payload;
  for (const value of Object.values(payload)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      ("resCode" in (value as object) || "receipts" in (value as object) || "contacts" in (value as object))
    ) {
      inner = value;
      break;
    }
  }

  const resCode = String(inner.resCode ?? "");
  if (resCode && resCode !== "200") {
    throw new PeakAPIError(
      `${context}: PEAK ตอบกลับ resCode=${resCode} resDesc=${inner.resDesc}`,
      resCode
    );
  }
  return inner;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Receipt = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Contact = Record<string, any>;

export class PeakClient {
  private clientToken: string;
  private refreshPromise: Promise<string> | null = null;

  constructor() {
    this.clientToken = settings.clientToken;
  }

  // ---------- จัดการ Client-Token (หมดอายุได้ -> mint ใหม่) ----------
  async refreshClientToken(staleToken?: string): Promise<string> {
    if (staleToken !== undefined && this.clientToken !== staleToken) {
      return this.clientToken; // request อื่น refresh ให้แล้ว
    }
    // กัน thundering herd: ถ้ามีการ refresh ค้างอยู่แล้ว ใช้ผลอันเดียวกัน
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this._doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async _doRefresh(): Promise<string> {
    const body = {
      peakClientToken: {
        connectId: settings.connectId,
        connectKey: settings.connectKey,
      },
    };
    const resp = await fetch(`${settings.BASE_URL}/ClientToken`, {
      method: "POST",
      headers: sign(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new PeakAPIError(`POST /ClientToken ล้มเหลว (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    }
    const data = unwrap(await resp.json(), "POST /ClientToken");
    const token = data.token;
    if (!token) {
      throw new PeakAPIError("ขอ Client-Token ไม่สำเร็จ (ไม่พบ token ใน response)");
    }
    this.clientToken = token;
    return token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (!this.clientToken) {
      await this.refreshClientToken("");
    }
    return {
      ...sign(),
      "User-Token": settings.userToken,
      "Client-Token": this.clientToken,
    };
  }

  /**
   * ยิง request พร้อม auto-retry แบบ exponential backoff
   * - resCode 600 (Invalid Client Token) -> refresh Client-Token แล้วลองใหม่ทันที
   * - network error: ลองใหม่เฉพาะเมื่อ retryNetwork=true (ปิดไว้สำหรับ POST กัน double-send)
   * - error อื่น (เช่น 400/validation) ไม่ลองซ้ำ
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    method: string,
    path: string,
    options: { params?: Record<string, string | number>; json?: any; retryNetwork?: boolean } = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const retryNetwork = options.retryNetwork ?? true;
    let lastExc: PeakAPIError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers = await this.authHeaders();
      const tokUsed = headers["Client-Token"];
      let url = `${settings.BASE_URL}${path}`;
      if (options.params) {
        const qs = new URLSearchParams(
          Object.entries(options.params).map(([k, v]) => [k, String(v)])
        ).toString();
        if (qs) url += `?${qs}`;
      }

      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
        });
        if (!resp.ok) {
          lastExc = new PeakAPIError(
            `${method} ${path} ล้มเหลว (${resp.status}): ${(await resp.text()).slice(0, 300)}`
          );
        } else {
          return unwrap(await resp.json(), `${method} ${path}`);
        }
      } catch (exc) {
        if (exc instanceof PeakAPIError) {
          lastExc = exc;
          if (!RETRYABLE_RES_CODES.has(exc.resCode)) {
            throw exc; // error ถาวร ไม่ต้องลองซ้ำ
          }
        } else {
          lastExc = new PeakAPIError(`${method} ${path} ล้มเหลว: ${exc}`, "network");
        }
      }

      const retryable =
        RETRYABLE_RES_CODES.has(lastExc.resCode) || (retryNetwork && lastExc.resCode === "network");
      if (!retryable || attempt === MAX_RETRIES) {
        break;
      }

      // resCode 600 = Client-Token หมดอายุ/ไม่ถูกต้อง -> ขอใหม่ก่อนลองรอบหน้า
      if (lastExc.resCode === "600") {
        try {
          await this.refreshClientToken(tokUsed);
        } catch {
          // ignore แล้วลองใหม่ตามรอบ retry อยู่ดี
        }
      }
      await sleep(RETRY_BASE_DELAY * 2 ** attempt * 1000); // 2,4,8,16 วินาที
    }

    throw lastExc;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get(path: string, params: Record<string, string | number>): Promise<any> {
    return this.request("GET", path, { params });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private post(path: string, body: any): Promise<any> {
    return this.request("POST", path, { json: body, retryNetwork: false });
  }

  // ---------- ขั้นที่ 1: ดึงใบเสร็จตามช่วงวันที่ ----------
  async listReceipts(
    dateStart: string,
    dateEnd: string,
    status?: number,
    limit: number = 100,
    page: number = 1
  ): Promise<Receipt[]> {
    const { rows } = await this.listReceiptsPage(dateStart, dateEnd, status, limit, page);
    return rows;
  }

  /** เหมือน listReceipts แต่คืน totalReceipt ที่ PEAK แนบมาด้วย (ใช้คำนวณจำนวนหน้าล่วงหน้า) */
  private async listReceiptsPage(
    dateStart: string,
    dateEnd: string,
    status: number | undefined,
    limit: number,
    page: number
  ): Promise<{ rows: Receipt[]; total: number }> {
    const params: Record<string, string | number> = { dateStart, dateEnd, limit, page };
    if (status !== undefined) params.status = status;
    const data = await this.get("/Receipts/list", params);
    return { rows: data.receipts ?? [], total: Number(data.totalReceipt ?? 0) };
  }

  /**
   * ดึงใบเสร็จ "ทุกหน้า" ในช่วงวันที่ — ดึงหน้าแรกก่อนเพื่อรู้ totalReceipt (PEAK แนบมาให้ใน
   * response ทุกครั้งอยู่แล้ว) แล้วยิงหน้าที่เหลือ "พร้อมกัน" แทนการวนทีละหน้า เพราะช่วงวันที่
   * กว้าง (เช่น 10 วัน) อาจมีหลายสิบหน้า วนทีละหน้าจะช้ามาก (หน้าละ ~1-2s ต่อ round-trip)
   * จำกัด concurrency ไว้กันยิงถี่เกินจนโดน rate-limit/token ชนกัน (resCode 600)
   */
  async listAllReceipts(
    dateStart: string,
    dateEnd: string,
    status?: number,
    pageSize: number = 100,
    maxPages: number = 100
  ): Promise<Receipt[]> {
    const first = await this.listReceiptsPage(dateStart, dateEnd, status, pageSize, 1);
    if (first.rows.length < pageSize || first.total <= pageSize) {
      return first.rows;
    }

    const totalPages = Math.min(maxPages, Math.ceil(first.total / pageSize));
    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);

    const PAGE_CONCURRENCY = 6;
    const restRows: Receipt[][] = new Array(remainingPages.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= remainingPages.length) return;
        const { rows } = await this.listReceiptsPage(dateStart, dateEnd, status, pageSize, remainingPages[i]);
        restRows[i] = rows;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, remainingPages.length) }, worker));

    return [first.rows, ...restRows].flat();
  }

  /**
   * GET /Receipts?code=RE... — รายละเอียดใบเสร็จเต็ม (มีฟิลด์ที่ /Receipts/list ไม่มี
   * เช่น netAmount/paymentAmount/remainAmount/paidPayments ใช้เช็คสถานะชำระเงิน)
   *
   * เลขที่ใบเสร็จ "ใช้ซ้ำ" ได้ (ออกใบใหม่ด้วยเลขเดิมหลัง void ตัวเก่า) PEAK จึงคืนได้
   * หลายเอกสารต่อ 1 code — เลือกตัว "live" (isVoid ไม่จริง) ก่อนเสมอ ไม่ใช่ตัวแรก [0]
   */
  async getReceipt(code: string): Promise<Receipt | null> {
    const data = await this.get("/Receipts", { code });
    const receipts: Receipt[] = data.receipts ?? [];
    if (!receipts.length) return null;
    const live = receipts.filter((r) => !r.isVoid);
    return (live.length ? live : receipts)[0];
  }

  // ---------- ขั้นที่ 3: ดึงข้อมูล contact มาตรวจสอบ ----------
  async getContact(code?: string, contactId?: string): Promise<Contact | null> {
    const params: Record<string, string> = {};
    if (contactId) {
      params.id = contactId;
    } else if (code) {
      params.code = code;
    } else {
      throw new PeakAPIError("getContact ต้องระบุ code หรือ id อย่างใดอย่างหนึ่ง");
    }
    const data = await this.get("/Contacts", params);
    const contacts = data.contacts ?? [];
    return contacts.length ? contacts[0] : null;
  }

  /**
   * ส่ง e-tax invoice
   * callbackUrl: ถ้าระบุ จะส่งฟิลด์ `url` ไปกับคำขอ — PEAK/INET จะยิง 'ผลออกใบจริง'
   * (แบบ async) กลับมาที่ URL นี้ (resCode 200 ที่ตอบทันทีแปลว่า 'รับคำขอแล้ว' เท่านั้น)
   */
  async sendEtaxInvoice(opts: {
    code: string;
    receiverEmails?: string[];
    contactName?: string;
    message?: string;
    keyReference?: string;
    callbackUrl?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peakReceipts: Record<string, any> = {
      code: opts.code,
      isUpdateDocument: settings.ETAX_IS_UPDATE_DOCUMENT,
      etaxConnectType: settings.ETAX_CONNECT_TYPE,
    };
    if (opts.keyReference) peakReceipts.keyReference = opts.keyReference;
    if (opts.callbackUrl) peakReceipts.url = opts.callbackUrl;
    if (opts.receiverEmails && opts.receiverEmails.length) {
      peakReceipts.email = {
        message: opts.message ?? "",
        contactName: opts.contactName ?? "",
        receiverEmail: opts.receiverEmails,
      };
    }
    return this.post("/Receipts/etaxinvoice", { peakReceipts });
  }
}

// PEAK อนุญาต Client-Token ที่ใช้งานได้จริงครั้งละ 1 ตัวต่อ connectId เท่านั้น — ถ้าแต่ละ
// request มินต์ token ของตัวเอง (new PeakClient() ต่อ request) คำขอที่ยิงพร้อมกันจะแย่ง
// invalidate token ของกันเอง ทำให้เจอ resCode 600 เป็นพัก ๆ แม้จะมี retry แล้วก็ตาม
// ใช้ client เดียวใช้ร่วมกันทั้ง process (persist ข้าม request ผ่าน globalThis กัน
// Next.js dev-mode module reload ทำให้ token หาย) เพื่อให้มี token ที่ valid อยู่ตัวเดียวเสมอ
const globalForPeak = globalThis as unknown as { __peakClient?: PeakClient };

export function getPeakClient(): PeakClient {
  if (!globalForPeak.__peakClient) {
    globalForPeak.__peakClient = new PeakClient();
  }
  return globalForPeak.__peakClient;
}
