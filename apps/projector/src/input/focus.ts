'use client';

import type { RemoteKey } from '@louvorvisual/contracts';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { InputContext, RepeatPolicy } from './normalizer';
import { pickNearest, pickNext, type Box, type Direction } from './spatial';

/** Evento entregue a um campo de ajuste quando ←/→ muda o valor em vez de mover o foco. */
export const ADJUST_EVENT = 'lv-adjust';

const FOCUSABLE = '[data-focusable]:not([disabled]):not([aria-disabled="true"])';

export type LayerOptions = {
  name: string;
  /** Camadas mais altas ficam por cima: tela 0, controles 1, menu 2+, confirmação 9. */
  level: number;
  repeat: RepeatPolicy;
  /** Tratamento próprio da camada; `true` quando a tecla foi consumida. */
  onKey?: (key: RemoteKey) => boolean;
  onBack?: () => void;
};

type Layer = LayerOptions & {
  id: number;
  root: HTMLElement;
  /** Quem tinha o foco quando a camada abriu; volta a tê-lo quando ela fecha. */
  restore: HTMLElement | null;
  lastBox: Box | null;
  focused: boolean;
  /** Padrões de foco (`data-autofocus`) já vistos com o foco no lugar; um novo indica conteúdo novo na camada. */
  seen: WeakSet<HTMLElement>;
};

/** Marca a raiz de cada camada; uma camada aberta dentro de outra não empresta seus elementos à de baixo. */
const LAYER_ATTRIBUTE = 'data-focus-layer';

const boxOf = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
};

const visible = (element: HTMLElement) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';

/**
 * Contexto de foco do controle remoto (planejamento/21). As telas e seus
 * menus formam uma pilha de camadas; só a do topo recebe teclas, e o foco
 * nunca sai dela. Dentro da camada as setas movem o foco pela posição dos
 * elementos na tela; OK ativa o elemento focado; Voltar fecha a camada. O foco
 * é o foco real do documento — não existe um segundo cursor para divergir.
 */
export class FocusManager {
  private layers: Layer[] = [];
  private nextId = 1;
  private observer: MutationObserver | null = null;

  private top(): Layer | null {
    return this.layers.at(-1) ?? null;
  }

  /** Contexto usado para decidir a repetição de uma tecla mantida. */
  context(): InputContext {
    const layer = this.top();
    return { repeat: layer?.repeat ?? 'none', scope: layer?.id ?? 0 };
  }

  /** Nome da camada que está recebendo as teclas (diagnóstico e testes). */
  activeLayer(): string | null {
    return this.top()?.name ?? null;
  }

  push(root: HTMLElement, options: LayerOptions): number {
    const layer: Layer = { ...options, id: this.nextId++, root, restore: document.activeElement instanceof HTMLElement ? document.activeElement : null, lastBox: null, focused: false, seen: new WeakSet() };
    root.setAttribute(LAYER_ATTRIBUTE, String(layer.id));
    this.layers.push(layer);
    this.layers.sort((a, b) => a.level - b.level || a.id - b.id);
    this.watch();
    this.ensure();
    return layer.id;
  }

  pop(id: number): void {
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index < 0) return;
    const [layer] = this.layers.splice(index, 1) as [Layer];
    // A raiz ainda está no documento neste instante; o que há nela já não é alvo de ninguém.
    layer.root.setAttribute(LAYER_ATTRIBUTE, 'closed');
    const top = this.top();
    if (!top) {
      this.observer?.disconnect();
      this.observer = null;
      return;
    }
    // Fechar um submenu devolve o foco ao item que o abriu, se ele ainda existir.
    const { restore } = layer;
    if (restore && restore.isConnected && this.owns(top, restore)) this.focus(top, restore);
    else this.ensure();
  }

  private watch(): void {
    if (this.observer || typeof MutationObserver === 'undefined') return;
    // Botão condicional que some, lista que chega do host: o foco é conferido a cada mudança.
    this.observer = new MutationObserver(() => this.ensure());
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'hidden', 'data-autofocus'] });
  }

  /** O elemento é um alvo de foco visível desta camada (e não de uma camada aberta dentro dela). */
  private owns(layer: Layer, element: HTMLElement): boolean {
    return element.closest(`[${LAYER_ATTRIBUTE}]`) === layer.root && element.matches(FOCUSABLE) && visible(element);
  }

  private candidates(layer: Layer): HTMLElement[] {
    return [...layer.root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => this.owns(layer, element));
  }

  private focus(layer: Layer, element: HTMLElement): void {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    layer.lastBox = boxOf(element);
    layer.focused = true;
  }

  /** Garante que o foco está em um elemento visível da camada do topo. */
  ensure(): void {
    const layer = this.top();
    if (!layer || !layer.root.isConnected) return;
    const active = document.activeElement;
    const candidates = this.candidates(layer);
    const defaults = candidates.filter((element) => element.dataset.autofocus !== undefined);
    if (active instanceof HTMLElement && this.owns(layer, active)) {
      layer.lastBox = boxOf(active);
      layer.focused = true;
      for (const element of defaults) layer.seen.add(element);
      return;
    }
    if (candidates.length === 0) return;
    // O foco se perdeu (o elemento sumiu) ou a camada acabou de abrir. Um padrão
    // que ainda não tinha aparecido indica conteúdo novo e recebe o foco; sem
    // ele, vale o vizinho mais próximo de onde o foco estava.
    const fresh = defaults.find((element) => !layer.seen.has(element));
    const nearest = layer.focused && layer.lastBox ? pickNearest(layer.lastBox, candidates.map((element) => ({ element, box: boxOf(element) })))?.element : undefined;
    const target = fresh ?? nearest ?? defaults[0] ?? candidates[0];
    if (!target) return;
    this.focus(layer, target);
    for (const element of defaults) layer.seen.add(element);
  }

  private move(layer: Layer, direction: Direction): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.owns(layer, active)) {
      this.ensure();
      return;
    }
    const others = this.candidates(layer)
      .filter((element) => element !== active)
      .map((element) => ({ element, box: boxOf(element) }));
    const next = pickNext(boxOf(active), others, direction);
    if (next) this.focus(layer, next.element);
  }

  /** Entrega um comando já normalizado à camada do topo. */
  handle(key: RemoteKey): void {
    const layer = this.top();
    if (!layer) return;
    this.ensure();
    if (layer.onKey?.(key)) return;
    const active = document.activeElement instanceof HTMLElement && this.owns(layer, document.activeElement) ? document.activeElement : null;
    switch (key) {
      case 'left':
      case 'right':
        // Campo de ajuste: as setas laterais mudam o valor indicado.
        if (active?.dataset.adjust !== undefined) {
          active.dispatchEvent(new CustomEvent(ADJUST_EVENT, { detail: key === 'right' ? 1 : -1 }));
          return;
        }
        this.move(layer, key);
        return;
      case 'up':
      case 'down':
        this.move(layer, key);
        return;
      case 'ok':
        active?.click();
        return;
      case 'back':
        layer.onBack?.();
        return;
      default:
        // Menu e play/pause só valem onde a camada os trata.
        return;
    }
  }
}

export const focusManager = new FocusManager();

/**
 * Registra o elemento como camada de foco enquanto estiver montado. As
 * funções são lidas na hora da tecla, então podem mudar a cada renderização.
 */
export function useFocusLayer<T extends HTMLElement = HTMLDivElement>(options: LayerOptions): RefObject<T | null> {
  const ref = useRef<T>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const { name, level, repeat } = options;
  useLayoutEffect(() => {
    if (!ref.current) return;
    const id = focusManager.push(ref.current, {
      name,
      level,
      repeat,
      onKey: (key) => latest.current.onKey?.(key) ?? false,
      onBack: () => latest.current.onBack?.(),
    });
    return () => focusManager.pop(id);
  }, [name, level, repeat]);
  return ref;
}

/** Liga ←/→ de um campo de ajuste focado à função que muda o valor. */
export function useAdjust<T extends HTMLElement>(onStep: (direction: 1 | -1) => void): RefObject<T | null> {
  const ref = useRef<T>(null);
  const latest = useRef(onStep);
  useEffect(() => {
    latest.current = onStep;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: Event) => latest.current((event as CustomEvent<1 | -1>).detail);
    element.addEventListener(ADJUST_EVENT, listener);
    return () => element.removeEventListener(ADJUST_EVENT, listener);
  }, []);
  return ref;
}
