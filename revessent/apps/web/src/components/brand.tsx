import Link from "next/link";

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <defs>
        <linearGradient id="rv-bmg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff7e6" />
          <stop offset="1" stopColor="#f0e2c6" />
        </linearGradient>
      </defs>
      <rect x="1.2" y="1.2" width="25.6" height="25.6" rx="8" fill="url(#rv-bmg)" />
      <rect x="1.2" y="1.2" width="25.6" height="25.6" rx="8" fill="none" stroke="#fff" strokeOpacity=".6" />
      <path d="M7 18.5h2.6l1.9-6 2.6 8 2.2-7 2 5H21" fill="none" stroke="#8a5f33" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 text-[17px] font-bold tracking-[-.02em] text-ink" aria-label="Revessent home">
      <BrandMark />
      revessent<span className="text-accent-ink">.</span>
    </Link>
  );
}
