import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const MenuIcon = () => <Icon><path d="M4 6h16M4 12h16M4 18h16" /></Icon>;
export const LandscapeIcon = () => <Icon><rect x="3" y="6" width="18" height="12" rx="1.5" /></Icon>;
export const PortraitIcon = () => <Icon><rect x="6" y="3" width="12" height="18" rx="1.5" /></Icon>;
export const PreviousIcon = () => <Icon><path d="M15 5l-7 7 7 7" /></Icon>;
export const NextIcon = () => <Icon><path d="M9 5l7 7-7 7" /></Icon>;
export const PlayIcon = () => <Icon><path d="M7 4l13 8-13 8z" /></Icon>;
export const PauseIcon = () => <Icon><path d="M8 5v14M16 5v14" /></Icon>;
export const TimerIcon = () => <Icon><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></Icon>;
export const SmallerIcon = () => <Icon><path d="M4 19l5-13h1l5 13M6 14h7M17 9h5" /></Icon>;
export const LargerIcon = () => <Icon><path d="M3 19l5-13h1l5 13M5 14h7M16 9h6M19 6v6" /></Icon>;
