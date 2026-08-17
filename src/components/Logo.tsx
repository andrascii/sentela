import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        width="32"
        height="32"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        className="text-brand-400"
      >
        <defs>
          <linearGradient id="sentela-logo-mark" x1="9" y1="6" x2="31" y2="35" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8ED7FF" />
            <stop offset="0.52" stopColor="#33A1FF" />
            <stop offset="1" stopColor="#1668E1" />
          </linearGradient>
          <linearGradient id="sentela-logo-signal" x1="8" y1="22" x2="32" y2="22" gradientUnits="userSpaceOnUse">
            <stop stopColor="#34D399" />
            <stop offset="0.55" stopColor="#59BFFF" />
            <stop offset="1" stopColor="#34D399" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="38" height="38" rx="11" className="fill-ink-800" stroke="currentColor" strokeOpacity="0.4" />
        <path
          d="M20 6.8 31 11.4v8.7c0 7.2-4.2 12.9-11 16-6.8-3.1-11-8.8-11-16v-8.7L20 6.8Z"
          fill="#0A0F1A"
          stroke="url(#sentela-logo-mark)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path d="M14.4 12.5c-2 2.1-2 5 0 7.1M25.6 12.5c2 2.1 2 5 0 7.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="20" cy="14" r="2.4" fill="#34D399" />
        <path
          d="M8.5 22h5.3l2.1-5.2 4.2 12.2 4.8-17 3.8 10H31.5"
          stroke="url(#sentela-logo-signal)"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-lg font-bold tracking-tight text-white">
        Sent<span className="text-brand-400">ela</span>
      </span>
    </Link>
  );
}
