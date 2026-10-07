/** Marca do aplicativo: a tela de projeção com as linhas da letra. Decorativa. */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false" className={className}>
      <rect width="512" height="512" rx="112" fill="#1a1e29" />
      <rect x="88" y="132" width="336" height="216" rx="28" fill="#12151d" stroke="#f4bd6a" strokeWidth="22" />
      <path d="M164 210h184M144 250h224M184 290h144" stroke="#f1f3f7" strokeWidth="24" strokeLinecap="round" />
      <path d="M196 404h120" stroke="#f4bd6a" strokeWidth="22" strokeLinecap="round" />
    </svg>
  );
}
