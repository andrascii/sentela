import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        width="28"
        height="28"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        className="text-brand-400"
      >
        <rect x="1" y="1" width="30" height="30" rx="8" className="fill-ink-700" stroke="currentColor" strokeOpacity="0.4" />
        <path
          d="M5 16 H11 L14 9 L18 23 L21 16 H27"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      <span className="text-lg font-bold tracking-tight text-white">
        Sent<span className="text-brand-400">ela</span>
      </span>
    </Link>
  );
}
