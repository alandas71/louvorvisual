import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

/** Ícones de traço da interface. Decorativos: o nome acessível vem sempre do texto ao lado. */
function make(paths: ReactNode) {
  return function Icon({ size = 18, ...props }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
        {paths}
      </svg>
    );
  };
}

export const LibraryIcon = make(<><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>);
export const SetlistIcon = make(<><path d="M8 6h12M8 12h12M8 18h8" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>);
export const ThemesIcon = make(<><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A3.7 3.7 0 0 0 21 10.6C21 6.4 17 3 12 3Z" /><path d="M7.5 11.5h.01M9.5 7.5h.01M14.5 7.5h.01" /></>);
export const TrashIcon = make(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>);
export const OfflineIcon = make(<><path d="M12 3v11M7.5 10.5 12 15l4.5-4.5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>);
export const SyncIcon = make(<><path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" /><path d="M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3L20 15.5" /><path d="M20 20v-4.5h-4.5" /></>);
export const AccountIcon = make(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.300A6.5 6.5 0 0 1 21.5 20" /></>);
export const MoreIcon = make(<><path d="M4 7h16M4 12h16M4 17h16" /></>);
export const PlusIcon = make(<path d="M12 5v14M5 12h14" />);
export const SearchIcon = make(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" /></>);
export const CloseIcon = make(<path d="M6 6l12 12M18 6 6 18" />);
export const CopyIcon = make(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>);
export const CheckIcon = make(<path d="m5 12.5 4.5 4.500L19 7.5" />);
export const AlertIcon = make(<><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4.500M12 17.500h.01" /></>);
export const InfoIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5.500M12 7.500h.01" /></>);
export const WifiOffIcon = make(<><path d="M3 3l18 18M8.5 16.500a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.5-2.600M19 13a10 10 0 0 0-5-2.800M2 9.500a15 15 0 0 1 4.2-2.700M22 9.500a15 15 0 0 0-10.5-4" /><path d="M12 20h.01" /></>);
export const InstallIcon = make(<><rect x="5" y="2.5" width="14" height="19" rx="3" /><path d="M12 7.500v7M9 12l3 3 3-3" /></>);
export const ProjectorIcon = make(<><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>);
export const SparkIcon = make(<path d="M12 3l1.8 5.200L19 10l-5.2 1.800L12 17l-1.8-5.200L5 10l5.2-1.800L12 3ZM19 16l.7 2.300L22 19l-2.3.700L19 22l-.7-2.300L16 19l2.3-.700L19 16Z" />);
export const ChevronRightIcon = make(<path d="m9 5 7 7-7 7" />);
export const ClockIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const ShieldIcon = make(<><path d="M12 3 4.5 6v5.500c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.500V6L12 3Z" /><path d="m9 12 2.2 2.200L15.5 10" /></>);
