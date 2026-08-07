import { thaiLong, thaiShort } from "@/lib/dashboard";

interface Props {
  from: Date;
  to: Date;
  total: number;
  sent: number;
  awaitCount: number;
  errorCount: number;
}

export function SummaryBanner({ from, to, total, sent, awaitCount, errorCount }: Props) {
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  const isSameDay = days === 1;

  return (
    <div className="banner">
      <div className={"day-chip" + (isSameDay ? "" : " range")}>
        <div className="dow">{isSameDay ? "DATE" : "RANGE"}</div>
        <div className="day-num num">{isSameDay ? from.getDate() : days}</div>
        <div className="mon">{isSameDay ? thaiShort(from) : days === 1 ? "day" : "days"}</div>
      </div>

      <div className="banner-body">
        <div className="banner-eyebrow">{isSameDay ? "ข้อมูลของวันที่เลือก" : "ข้อมูลตั้งแต่ช่วงวันที่เลือก"}</div>
        <h2 className="banner-title">
          {isSameDay ? (
            <>
              ใบเสร็จวันที่ <span className="accent">{thaiLong(from)}</span>
            </>
          ) : (
            <>
              ใบเสร็จตั้งแต่ <span className="accent">{thaiLong(from)}</span> ถึง{" "}
              <span className="accent">{thaiLong(to)}</span>
            </>
          )}
        </h2>
        <div className="banner-rounds">
          <span className="round-pill">
            <span className="dot" style={{ background: "var(--success-soft)", color: "var(--success-ink)" }}>
              ✓
            </span>
            <span>ส่งแล้ว</span>
            <span className="count num">· {sent.toLocaleString()}</span>
          </span>
          <span className="round-pill">
            <span className="dot" style={{ background: "var(--info-soft)", color: "var(--info-ink)" }}>
              ⏳
            </span>
            <span>รอส่ง</span>
            <span className="count num">· {awaitCount.toLocaleString()}</span>
          </span>
          <span className="round-pill">
            <span className="dot" style={{ background: "var(--danger-soft)", color: "var(--danger-ink)" }}>
              !
            </span>
            <span>ผิดพลาด</span>
            <span className="count num">· {errorCount.toLocaleString()}</span>
          </span>
        </div>
      </div>

      <div className="banner-aside">
        <div className="k">ส่งแล้ว · ทั้งหมด</div>
        <div className="v num">
          {sent.toLocaleString()}
          <span style={{ color: "var(--muted)", fontWeight: 500, fontSize: 15 }}> / {total.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
