import type { Metadata } from 'next';
import { ReceiverScreen } from '@/receiver/ReceiverScreen';

export const metadata: Metadata = { title: 'Receptor' };

// Página do aplicativo do projetor: só o código de pareamento e a saída. Fica
// fora dos shells do service worker porque depende do servidor de qualquer
// forma, e assim o projetor sempre abre a versão publicada.
export default function ReceptorPage() {
  return <ReceiverScreen kiosk />;
}
