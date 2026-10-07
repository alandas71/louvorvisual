import type { Metadata } from 'next';
import { AppShell } from '@/features/shell/AppShell';

export const metadata: Metadata = { title: 'Aplicativo' };

// Documento estático: nenhum dado de usuário ou sessão entra neste HTML.
export default function AppShellPage() {
  return <AppShell />;
}
