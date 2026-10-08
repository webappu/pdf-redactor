<script lang="ts">
  // 1 ページ分の表示: 描画した画像と、墨消しの範囲の重ね描き（描く・選ぶ・動かす・大きさを変える）
  import { onDestroy } from 'svelte';
  import type { RenderScheduler } from '../lib/renderer';
  import type { Mark, PageSize, Rect } from '../lib/types';
  import { normRect } from '../lib/geom';
  import { visible } from '../lib/visible';

  interface Props {
    index: number;
    size: PageSize;
    zoom: number;
    epoch: number;
    scheduler: RenderScheduler;
    root: HTMLElement | null;
    marks: Mark[];
    selectedId: string | null;
    tool: 'select' | 'rect';
    editable: boolean;
    onCreate: (page: number, rect: Rect) => void;
    onChange: (id: string, rect: Rect) => void;
    onSelect: (id: string | null) => void;
  }

  let { index, size, zoom, epoch, scheduler, root, marks, selectedId, tool, editable, onCreate, onChange, onSelect }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let overlay: HTMLDivElement | undefined = $state();
  let isVisible = $state(false);
  let rendered = { scale: 0, epoch: -1 };
  let loading = $state(true);
  const key = $derived(`page-${index}`);

  const MIN_SIZE = 2; // pt

  $effect(() => {
    const scale = zoom * (window.devicePixelRatio || 1);
    const ep = epoch;
    if (!isVisible) {
      scheduler.cancel(key);
      // 離れたページの画像は捨てる（大きな文書でメモリを使い切らないように）
      if (canvas && rendered.scale !== 0) {
        canvas.width = 0;
        canvas.height = 0;
        rendered = { scale: 0, epoch: -1 };
        loading = true;
      }
      return;
    }
    if (rendered.scale === scale && rendered.epoch === ep) return;
    loading = true;
    scheduler.request({
      key,
      page: index,
      scale,
      priority: 0,
      done: (bmp) => {
        if (!bmp) return;
        if (canvas) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext('2d')?.drawImage(bmp, 0, 0);
          rendered = { scale, epoch: ep };
          loading = false;
        }
        bmp.close();
      },
    });
  });

  onDestroy(() => scheduler.cancel(key));

  // 画面の点 → ページ空間（pt）
  function toPt(ev: PointerEvent): [number, number] {
    const r = overlay!.getBoundingClientRect();
    const x = Math.max(0, Math.min(size.width, (ev.clientX - r.left) / zoom));
    const y = Math.max(0, Math.min(size.height, (ev.clientY - r.top) / zoom));
    return [x, y];
  }

  type Drag =
    | { kind: 'new'; start: [number, number]; cur: [number, number] }
    | { kind: 'move'; id: string; start: [number, number]; orig: Rect }
    | { kind: 'resize'; id: string; handle: string; orig: Rect };
  let drag = $state<Drag | null>(null);

  function clampRect(r: Rect): Rect {
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    let x0 = Math.max(0, Math.min(size.width - w, r[0]));
    let y0 = Math.max(0, Math.min(size.height - h, r[1]));
    return [x0, y0, x0 + w, y0 + h];
  }

  function onPointerDown(ev: PointerEvent) {
    if (!editable || ev.button !== 0) return;
    const target = ev.target as HTMLElement;
    const markEl = target.closest('[data-mark-id]') as HTMLElement | null;
    const p = toPt(ev);
    if (target.dataset.handle && markEl) {
      const id = markEl.dataset.markId!;
      const m = marks.find((x) => x.id === id);
      if (!m) return;
      drag = { kind: 'resize', id, handle: target.dataset.handle, orig: [...m.rect] as Rect };
    } else if (markEl) {
      const id = markEl.dataset.markId!;
      const m = marks.find((x) => x.id === id);
      if (!m) return;
      onSelect(id);
      drag = { kind: 'move', id, start: p, orig: [...m.rect] as Rect };
    } else if (tool === 'rect') {
      onSelect(null);
      drag = { kind: 'new', start: p, cur: p };
    } else {
      onSelect(null);
      return;
    }
    overlay!.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }

  function onPointerMove(ev: PointerEvent) {
    if (!drag) return;
    const p = toPt(ev);
    if (drag.kind === 'new') {
      drag = { ...drag, cur: p };
    } else if (drag.kind === 'move') {
      const dx = p[0] - drag.start[0];
      const dy = p[1] - drag.start[1];
      const o = drag.orig;
      onChange(drag.id, clampRect([o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy]));
    } else {
      const o = drag.orig;
      const r: Rect = [...o] as Rect;
      if (drag.handle.includes('w')) r[0] = p[0];
      if (drag.handle.includes('e')) r[2] = p[0];
      if (drag.handle.includes('n')) r[1] = p[1];
      if (drag.handle.includes('s')) r[3] = p[1];
      const n = normRect(r);
      if (n[2] - n[0] >= MIN_SIZE && n[3] - n[1] >= MIN_SIZE) onChange(drag.id, n);
    }
  }

  function onPointerUp(ev: PointerEvent) {
    if (!drag) return;
    if (drag.kind === 'new') {
      const r = normRect([drag.start[0], drag.start[1], drag.cur[0], drag.cur[1]]);
      if (r[2] - r[0] >= MIN_SIZE && r[3] - r[1] >= MIN_SIZE) onCreate(index, r);
    }
    drag = null;
    try {
      overlay?.releasePointerCapture(ev.pointerId);
    } catch {
      // 既に離れている
    }
  }

  const draft = $derived(drag && drag.kind === 'new' ? normRect([drag.start[0], drag.start[1], drag.cur[0], drag.cur[1]]) : null);

  function css(rgb: [number, number, number], a: number): string {
    return `rgb(${Math.round(rgb[0] * 255)} ${Math.round(rgb[1] * 255)} ${Math.round(rgb[2] * 255)} / ${a})`;
  }
</script>

<div
  class="slot"
  data-testid="page"
  data-page={index}
  data-rendered={!loading}
  style:width="{size.width * zoom}px"
  style:height="{size.height * zoom}px"
  use:visible={{ onChange: (v) => (isVisible = v), root, margin: '600px' }}
>
  <canvas bind:this={canvas} style:width="{size.width * zoom}px" style:height="{size.height * zoom}px"></canvas>
  {#if loading}
    <div class="loading muted">{index + 1} ページ</div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay"
    class:drawing={editable && tool === 'rect'}
    bind:this={overlay}
    data-testid="page-overlay"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  >
    {#each marks as m (m.id)}
      <div
        class="mark {m.mode}"
        class:selected={m.id === selectedId}
        data-testid="mark"
        data-mark-id={m.id}
        data-mode={m.mode}
        data-source={m.source}
        style:left="{m.rect[0] * zoom}px"
        style:top="{m.rect[1] * zoom}px"
        style:width="{(m.rect[2] - m.rect[0]) * zoom}px"
        style:height="{(m.rect[3] - m.rect[1]) * zoom}px"
        style:background={m.mode === 'fill' ? css(m.color, 0.55) : undefined}
        style:border-color={m.mode === 'fill' ? css(m.color, 1) : undefined}
      >
        {#if m.id === selectedId && editable}
          {#each ['nw', 'ne', 'sw', 'se'] as h (h)}
            <span class="handle {h}" data-handle={h}></span>
          {/each}
        {/if}
      </div>
    {/each}
    {#if draft}
      <div
        class="mark draft"
        style:left="{draft[0] * zoom}px"
        style:top="{draft[1] * zoom}px"
        style:width="{(draft[2] - draft[0]) * zoom}px"
        style:height="{(draft[3] - draft[1]) * zoom}px"
      ></div>
    {/if}
  </div>
</div>

<style>
  .slot {
    position: relative;
    background: #fff;
    box-shadow: var(--page-shadow);
    margin: 0 auto 16px;
    flex: none;
  }
  canvas {
    display: block;
  }
  .loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #8a93a0;
    pointer-events: none;
  }
  .overlay {
    position: absolute;
    inset: 0;
    touch-action: none;
  }
  .overlay.drawing {
    cursor: crosshair;
  }
  .mark {
    position: absolute;
    border: 1px solid #000;
    cursor: move;
  }
  .mark.blur {
    backdrop-filter: blur(5px);
    background: rgb(120 120 140 / 0.25);
    border: 1px dashed #445;
  }
  .mark.selected {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .mark.draft {
    border: 1px dashed var(--accent);
    background: rgb(37 99 235 / 0.12);
    pointer-events: none;
  }
  .handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: var(--surface);
    border: 1.5px solid var(--accent);
    border-radius: 2px;
  }
  .handle.nw {
    left: -6px;
    top: -6px;
    cursor: nwse-resize;
  }
  .handle.ne {
    right: -6px;
    top: -6px;
    cursor: nesw-resize;
  }
  .handle.sw {
    left: -6px;
    bottom: -6px;
    cursor: nesw-resize;
  }
  .handle.se {
    right: -6px;
    bottom: -6px;
    cursor: nwse-resize;
  }
</style>
