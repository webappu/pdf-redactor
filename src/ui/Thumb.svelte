<script lang="ts">
  // サムネイル 1 枚（見えているものだけ描く）
  import { onDestroy } from 'svelte';
  import type { RenderScheduler } from '../lib/renderer';
  import type { PageSize } from '../lib/types';
  import { t } from '../i18n.svelte';
  import { visible } from '../lib/visible';

  interface Props {
    index: number;
    size: PageSize;
    epoch: number;
    scheduler: RenderScheduler;
    root: HTMLElement | null;
    count: number;
    current: boolean;
    onClick: (page: number) => void;
  }

  let { index, size, epoch, scheduler, root, count, current, onClick }: Props = $props();

  const WIDTH = 110;
  let canvas: HTMLCanvasElement | undefined = $state();
  let isVisible = $state(false);
  let renderedEpoch = -1;
  const key = $derived(`thumb-${index}`);
  const scale = $derived(WIDTH / Math.max(1, size.width));

  $effect(() => {
    const ep = epoch;
    const s = scale * (window.devicePixelRatio || 1);
    if (!isVisible) {
      scheduler.cancel(key);
      return;
    }
    if (renderedEpoch === ep) return;
    scheduler.request({
      key,
      page: index,
      scale: s,
      priority: 1,
      done: (bmp) => {
        if (!bmp) return;
        if (canvas) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext('2d')?.drawImage(bmp, 0, 0);
          renderedEpoch = ep;
        }
        bmp.close();
      },
    });
  });

  onDestroy(() => scheduler.cancel(key));
</script>

<button
  class="thumb"
  class:current
  data-testid="thumb"
  onclick={() => onClick(index)}
  use:visible={{ onChange: (v) => (isVisible = v), root, margin: '200px' }}
>
  <canvas bind:this={canvas} style:width="{WIDTH}px" style:height="{size.height * scale}px"></canvas>
  <span class="label">{index + 1}{#if count > 0}<span class="count" title={t('墨消しの範囲の数')}>{count}</span>{/if}</span>
</button>

<style>
  .thumb {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px;
    border: 2px solid transparent;
    background: transparent;
    width: 100%;
  }
  .thumb.current {
    border-color: var(--accent);
    background: var(--accent-weak);
  }
  canvas {
    background: #fff;
    box-shadow: var(--page-shadow);
  }
  .label {
    font-size: 12px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .count {
    background: #111;
    color: #fff;
    border-radius: 8px;
    padding: 0 6px;
    font-size: 11px;
  }
</style>
