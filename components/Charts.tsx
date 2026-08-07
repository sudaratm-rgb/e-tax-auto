"use client";

import { useState } from "react";

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  total: number;
  activeKey?: string | null;
  onSlice?: (key: string) => void;
  centerLabel?: string;
}

export function DonutChart({ segments, total, activeKey, onSlice, centerLabel = "Total" }: DonutChartProps) {
  const size = 220;
  const stroke = 30;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const sum = segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 0;
  const [hover, setHover] = useState<string | null>(null);

  const mainPct = segments.length ? Math.round((segments[0].value / sum) * 100) : 0;

  return (
    <div className="chart-donut">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        {segments.map((seg) => {
          const frac = seg.value / sum;
          const len = frac * C;
          const dash = `${len} ${C - len}`;
          const dashoffset = -offset;
          offset += len;
          const isActive = activeKey === seg.key;
          const dim = (activeKey && !isActive) || (hover && hover !== seg.key && !isActive);
          return (
            <circle
              key={seg.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={isActive ? stroke + 6 : stroke}
              strokeDasharray={dash}
              strokeDashoffset={dashoffset}
              style={{
                transform: "rotate(-90deg)",
                transformOrigin: "center",
                cursor: onSlice ? "pointer" : "default",
                opacity: dim ? 0.35 : 1,
                transition: "opacity .15s, stroke-width .15s",
              }}
              onClick={() => onSlice?.(seg.key)}
              onMouseEnter={() => setHover(seg.key)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        <text x="50%" y="44%" textAnchor="middle" className="donut-center-label">
          {centerLabel}
        </text>
        <text x="50%" y="57%" textAnchor="middle" className="donut-center-value">
          {total.toLocaleString()}
        </text>
        <text x="50%" y="68%" textAnchor="middle" className="donut-center-pct">
          {mainPct}%
        </text>
      </svg>
      <div className="chart-legend">
        {segments.map((seg) => (
          <button
            key={seg.key}
            className={"legend-item" + (activeKey === seg.key ? " active" : "")}
            onClick={() => onSlice?.(seg.key)}
          >
            <span className="dot" style={{ background: seg.color }}></span>
            {seg.label}
            <span className="num" style={{ color: "var(--text-3)", marginLeft: 4 }}>
              {seg.value.toLocaleString()}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export interface BarSegKey {
  key: string;
  label: string;
  color: string;
}

export interface BarGroup {
  key: string;
  label: string;
  segments: Record<string, number>;
}

interface StackedBarChartProps {
  groups: BarGroup[];
  segKeys: BarSegKey[];
  onSegment?: (groupKey: string, segKey: string) => void;
  active?: { group: string; seg: string } | null;
}

export function StackedBarChart({ groups, segKeys, onSegment, active }: StackedBarChartProps) {
  const maxVal = Math.max(1, ...groups.map((g) => segKeys.reduce((s, sk) => s + (g.segments[sk.key] || 0), 0)));
  const ticks = 5;
  const top = Math.ceil(maxVal / ticks) * ticks || ticks;
  const H = 200;
  const padBottom = 28;
  const plotH = H - 10 - padBottom;

  return (
    <div className="chart-bar">
      <div className="bar-plot" style={{ height: H }}>
        <div className="bar-grid">
          {Array.from({ length: ticks + 1 }, (_, i) => {
            const v = Math.round(top - (top / ticks) * i);
            return (
              <div className="grid-line" key={i}>
                <span className="grid-label num">{v}</span>
              </div>
            );
          })}
        </div>
        <div className="bar-cols">
          {groups.map((g) => {
            const totalG = segKeys.reduce((s, sk) => s + (g.segments[sk.key] || 0), 0);
            return (
              <div className="bar-col" key={g.key}>
                <div className="bar-stack" style={{ height: plotH }}>
                  {segKeys.map((sk) => {
                    const val = g.segments[sk.key] || 0;
                    if (!val) return null;
                    const h = (val / top) * plotH;
                    const isActive = active && active.group === g.key && active.seg === sk.key;
                    const dim = active && !isActive;
                    return (
                      <div
                        key={sk.key}
                        className="bar-seg"
                        title={`${g.label} · ${sk.label}: ${val}`}
                        style={{
                          height: h,
                          background: sk.color,
                          cursor: onSegment ? "pointer" : "default",
                          opacity: dim ? 0.4 : 1,
                        }}
                        onClick={() => onSegment?.(g.key, sk.key)}
                      >
                        {h > 22 && <span className="bar-val num">{val}</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="bar-label">
                  {g.label}
                  <span className="num" style={{ color: "var(--text-3)" }}>
                    {" "}
                    · {totalG}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="chart-legend center">
        {segKeys.map((sk) => (
          <span key={sk.key} className="legend-item static">
            <span className="dot" style={{ background: sk.color }}></span>
            {sk.label}
          </span>
        ))}
      </div>
    </div>
  );
}
