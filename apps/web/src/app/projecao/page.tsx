import type { Metadata } from 'next';
import { ProjectionShell } from '@/features/projecao/ProjectionShell';

export const metadata: Metadata = { title: 'Projeção' };

export default function ProjecaoPage() {
  return <ProjectionShell />;
}
