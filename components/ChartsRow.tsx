import { DonutChart, StackedBarChart } from "./Charts";

interface TypeCounts {
  sent: number;
  await: number;
  error: number;
}

interface Props {
  sent: number;
  awaitCount: number;
  errorCount: number;
  juristic: TypeCounts;
  ordinary: TypeCounts;
  statusFilter: string;
  typeFilter: string;
  onPick: (type: string, status: string) => void;
  onClear: () => void;
}

export function ChartsRow({ sent, awaitCount, errorCount, juristic, ordinary, statusFilter, typeFilter, onPick, onClear }: Props) {
  const filterActive = statusFilter !== "all" || typeFilter !== "all";
  const total = sent + awaitCount + errorCount;

  const donutSegs = [
    { key: "sent", label: "ส่งสำเร็จ", value: sent, color: "var(--success)" },
    { key: "await", label: "รอส่ง", value: awaitCount, color: "#f59e0b" },
    { key: "error", label: "ผิดพลาด", value: errorCount, color: "var(--danger)" },
  ];
  const donutActive = typeFilter === "all" && statusFilter !== "all" ? statusFilter : null;

  const segKeys = [
    { key: "sent", label: "ส่งสำเร็จ", color: "var(--success)" },
    { key: "await", label: "รอส่ง", color: "#f59e0b" },
    { key: "error", label: "ผิดพลาด", color: "var(--danger)" },
  ];
  const groups = [
    { key: "juristic", label: "นิติบุคคล", segments: juristic as unknown as Record<string, number> },
    { key: "ordinary", label: "บุคคลธรรมดา", segments: ordinary as unknown as Record<string, number> },
  ];
  const barActive = statusFilter !== "all" && typeFilter !== "all" ? { group: typeFilter, seg: statusFilter } : null;

  return (
    <div className="charts-row">
      <div className="chart-card">
        <div className="card-head">
          <div className="card-title">ส่งสำเร็จ / รอส่ง / ผิดพลาด</div>
          {filterActive ? (
            <span className="chart-clear" onClick={onClear}>
              ล้างตัวกรอง
            </span>
          ) : (
            <div className="hint">คลิกเพื่อกรอง</div>
          )}
        </div>
        <div className="chart-body">
          <DonutChart segments={donutSegs} total={total} activeKey={donutActive} onSlice={(key) => onPick("all", key)} />
        </div>
      </div>

      <div className="chart-card">
        <div className="card-head">
          <div className="card-title">แยกตามประเภทลูกค้า</div>
          {filterActive ? (
            <span className="chart-clear" onClick={onClear}>
              ล้างตัวกรอง
            </span>
          ) : (
            <div className="hint">คลิกที่แท่งกราฟเพื่อกรอง</div>
          )}
        </div>
        <div className="chart-body">
          <StackedBarChart groups={groups} segKeys={segKeys} active={barActive} onSegment={(g, sk) => onPick(g, sk)} />
        </div>
      </div>
    </div>
  );
}
