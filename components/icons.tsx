// ไอคอนแบบ inline SVG (ไม่พึ่ง dependency ภายนอก) — พอร์ตจาก design ต้นฉบับ
// เก็บเฉพาะไอคอนที่ใช้จริงในแดชบอร์ด

interface IconProps {
  size?: number;
  stroke?: number;
  className?: string;
}

function I({ children, size = 16, stroke = 1.8, className = "" }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={`ic ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Calendar: (p: IconProps) => (
    <I {...p}>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M8 3v3M16 3v3" />
    </I>
  ),
  ChevronLeft: (p: IconProps) => (
    <I {...p}>
      <path d="M15 6l-6 6 6 6" />
    </I>
  ),
  ChevronRight: (p: IconProps) => (
    <I {...p}>
      <path d="M9 6l6 6-6 6" />
    </I>
  ),
  Search: (p: IconProps) => (
    <I {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </I>
  ),
  Refresh: (p: IconProps) => (
    <I {...p}>
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
    </I>
  ),
  Send: (p: IconProps) => (
    <I {...p}>
      <path d="M21 3L3 10l7 3 3 7 8-17z" />
      <path d="M10 13l11-10" />
    </I>
  ),
  Alert: (p: IconProps) => (
    <I {...p}>
      <path d="M12 9v4m0 4h.01" />
      <path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
    </I>
  ),
  Check: (p: IconProps) => (
    <I {...p}>
      <path d="M5 12l5 5L20 7" />
    </I>
  ),
  Close: (p: IconProps) => (
    <I {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </I>
  ),
  ArrowUp: (p: IconProps) => (
    <I {...p}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </I>
  ),
  ArrowDown: (p: IconProps) => (
    <I {...p}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </I>
  ),
  ArrowUpDown: (p: IconProps) => (
    <I {...p}>
      <path d="M7 4v16M3 8l4-4 4 4" />
      <path d="M17 20V4M21 16l-4 4-4-4" />
    </I>
  ),
  Inbox: (p: IconProps) => (
    <I {...p}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5 5l-3 7v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7l-3-7H5z" />
    </I>
  ),
  Upload: (p: IconProps) => (
    <I {...p}>
      <path d="M12 16V4M6 10l6-6 6 6" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </I>
  ),
};
