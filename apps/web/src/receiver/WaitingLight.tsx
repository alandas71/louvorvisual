'use client';
import { useEffect, useRef } from 'react';

type Ray = { angle: number; width: number; sway: number; swaySpeed: number; pulseSpeed: number; phase: number };
type Mote = { x: number; y: number; size: number; rise: number; drift: number; phase: number };

/** Sequência fixa: a mesma luz em toda abertura, sem depender de sorteio. */
function sequence(seed: number) {
  let value = seed;
  return () => { value = (value * 1664525 + 1013904223) % 4294967296; return value / 4294967296; };
}

const next = sequence(7);
const RAYS: Ray[] = Array.from({ length: 9 }, (_, index) => ({
  angle: -0.78 + (index / 8) * 1.56 + (next() - 0.5) * 0.08,
  width: 0.035 + next() * 0.06,
  sway: 0.025 + next() * 0.04,
  swaySpeed: 0.07 + next() * 0.11,
  pulseSpeed: 0.12 + next() * 0.2,
  phase: next() * Math.PI * 2,
}));
const MOTES: Mote[] = Array.from({ length: 44 }, () => ({ x: next(), y: next(), size: 0.004 + next() * 0.011, rise: 0.008 + next() * 0.02, drift: 0.01 + next() * 0.03, phase: next() * Math.PI * 2 }));

/** Altura interna do desenho: baixa de propósito, a ampliação suaviza a luz e poupa o processador do projetor. */
const HEIGHT = 360;
const FRAME_MS = 1000 / 30;

function sprite(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d');
  if (context) {
    const glow = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    glow.addColorStop(0, 'rgba(255,244,214,1)');
    glow.addColorStop(0.35, 'rgba(255,226,160,0.45)');
    glow.addColorStop(1, 'rgba(255,214,140,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, 32, 32);
  }
  return canvas;
}

/**
 * Espera da saída: feixes de luz que descem do alto e partículas que sobem
 * devagar, sem texto nem símbolo. Desenhada em canvas, e não em CSS, porque é o
 * conteúdo projetado: "remover animações" no sistema do projetor não deve
 * congelá-la.
 */
export function WaitingLight({ strength = 1 }: { strength?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const mote = sprite();
    let width = 0; let frame = 0; let drawnAt = 0;
    const resize = () => {
      const ratio = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      width = Math.max(1, Math.round(HEIGHT * (Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9)));
      canvas.width = width; canvas.height = HEIGHT;
    };
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - drawnAt < FRAME_MS) return;
      drawnAt = now;
      const time = now / 1000;
      const breath = 0.78 + 0.22 * Math.sin(time * 0.45);
      const originX = width / 2; const originY = -HEIGHT * 0.28; const reach = HEIGHT * 1.75;

      context.globalCompositeOperation = 'source-over'; context.globalAlpha = 1;
      const night = context.createLinearGradient(0, 0, 0, HEIGHT);
      night.addColorStop(0, '#1b1509'); night.addColorStop(0.45, '#0b0c14'); night.addColorStop(1, '#040509');
      context.fillStyle = night; context.fillRect(0, 0, width, HEIGHT);

      context.globalCompositeOperation = 'lighter';
      const source = context.createRadialGradient(originX, originY, 0, originX, originY, HEIGHT * 1.15);
      source.addColorStop(0, `rgba(255,238,196,${0.62 * breath * strength})`);
      source.addColorStop(0.4, `rgba(244,196,116,${0.2 * breath * strength})`);
      source.addColorStop(1, 'rgba(244,189,106,0)');
      context.fillStyle = source; context.fillRect(0, 0, width, HEIGHT);

      for (const ray of RAYS) {
        const angle = Math.PI / 2 + ray.angle + Math.sin(time * ray.swaySpeed + ray.phase) * ray.sway;
        const power = (0.45 + 0.55 * Math.sin(time * ray.pulseSpeed + ray.phase * 1.7)) * strength;
        if (power <= 0.02) continue;
        const beam = context.createLinearGradient(originX, originY, originX + Math.cos(angle) * reach, originY + Math.sin(angle) * reach);
        beam.addColorStop(0, `rgba(255,236,186,${0.055 * power})`);
        beam.addColorStop(0.55, `rgba(250,208,132,${0.025 * power})`);
        beam.addColorStop(1, 'rgba(244,189,106,0)');
        context.fillStyle = beam;
        // Feixes sobrepostos, do mais largo ao mais estreito: a borda esmaece sem filtro de desfoque.
        for (const scale of [1, 0.82, 0.65, 0.48, 0.32, 0.18]) {
          const half = ray.width * scale;
          context.beginPath();
          context.moveTo(originX, originY);
          context.lineTo(originX + Math.cos(angle - half) * reach, originY + Math.sin(angle - half) * reach);
          context.lineTo(originX + Math.cos(angle + half) * reach, originY + Math.sin(angle + half) * reach);
          context.closePath(); context.fill();
        }
      }

      const ground = context.createRadialGradient(originX, HEIGHT * 1.12, 0, originX, HEIGHT * 1.12, width * 0.55);
      ground.addColorStop(0, `rgba(255,222,160,${0.16 * breath * strength})`);
      ground.addColorStop(1, 'rgba(255,214,140,0)');
      context.fillStyle = ground; context.fillRect(0, 0, width, HEIGHT);

      for (const item of MOTES) {
        const y = 1 - ((item.y + time * item.rise) % 1);
        const x = item.x + Math.sin(time * 0.3 + item.phase) * item.drift;
        const size = item.size * HEIGHT * 2;
        // Some perto das bordas de cima e de baixo, e cintila no caminho.
        context.globalAlpha = Math.max(0, Math.sin(y * Math.PI)) * (0.35 + 0.3 * Math.sin(time * 1.3 + item.phase)) * strength;
        context.drawImage(mote, x * width - size / 2, y * HEIGHT - size / 2, size, size);
      }

      context.globalCompositeOperation = 'source-over'; context.globalAlpha = 1;
      const edge = context.createRadialGradient(originX, HEIGHT * 0.45, HEIGHT * 0.35, originX, HEIGHT * 0.45, Math.max(width, HEIGHT) * 0.75);
      edge.addColorStop(0, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,0.6)');
      context.fillStyle = edge; context.fillRect(0, 0, width, HEIGHT);
    };
    resize();
    window.addEventListener('resize', resize);
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); };
  }, [strength]);
  return <canvas ref={ref} aria-hidden="true" data-testid="receiver-waiting" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'block', background: '#05060a' }} />;
}
