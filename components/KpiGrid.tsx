export interface KpiCounts {
  juristicSent: number;
  juristicAwait: number;
  juristicError: number;
  ordinarySent: number;
  ordinaryAwait: number;
  ordinaryError: number;
}

interface Props {
  counts: KpiCounts;
  statusFilter: string;
  typeFilter: string;
  onPick: (type: string, status: string) => void;
}

export function KpiGrid({ counts, statusFilter, typeFilter, onPick }: Props) {
  const cards = [
    { k: "js", label: "นิติบุคคล — ส่งสำเร็จ", value: counts.juristicSent, tone: "success", type: "juristic", status: "sent", sub: null as number | null },
    { k: "je", label: "นิติบุคคล — ผิดพลาด", value: counts.juristicError, tone: "danger", type: "juristic", status: "error", sub: counts.juristicAwait },
    { k: "os", label: "บุคคลธรรมดา — ส่งสำเร็จ", value: counts.ordinarySent, tone: "success", type: "ordinary", status: "sent", sub: null as number | null },
    { k: "oe", label: "บุคคลธรรมดา — ผิดพลาด", value: counts.ordinaryError, tone: "danger", type: "ordinary", status: "error", sub: counts.ordinaryAwait },
  ];

  return (
    <div className="kpi-grid">
      {cards.map((c) => {
        const isActive = statusFilter === c.status && typeFilter === c.type;
        return (
          <div
            key={c.k}
            className={"kpi clickable" + (isActive ? " active" : "")}
            onClick={() => onPick(c.type, c.status)}
            role="button"
            tabIndex={0}
          >
            <div className="k">{c.label}</div>
            <div className={"v num " + c.tone}>{c.value.toLocaleString()}</div>
            {c.sub != null && c.sub > 0 && (
              <div className="sub-await">
                + <b className="num">{c.sub}</b> รอส่ง (await)
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
