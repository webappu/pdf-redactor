<script lang="ts">
  // 精密墨消しアプリの画面。PDF を開き、墨消しの範囲を指定して適用し、事後検査の結果とともに保存・本体へ戻す
  import { onMount, tick } from 'svelte';
  import { LICENSE_NAME, SOURCE_URL } from './config';
  import { lang, setLang, t, tm } from './i18n.svelte';
  import { PdfWorker } from './lib/client';
  import { readHandoffId, receiveHandoff, returnName, returnToEditor } from './lib/handoff';
  import { rectsIntersect } from './lib/geom';
  import { RenderScheduler } from './lib/renderer';
  import type { Msg } from './lib/msg';
  import type { ApplyChoice, ApplyResult, DocInfo, Mark, MarkMode, RGB, Rect } from './lib/types';
  import PageSlot from './ui/PageSlot.svelte';
  import Thumb from './ui/Thumb.svelte';

  const worker = new PdfWorker();
  const scheduler = new RenderScheduler(worker);
  const isolated = typeof crossOriginIsolated === 'boolean' && crossOriginIsolated;
  const PAGE_GAP = 16;
  const PAD = 24;

  type Phase = 'empty' | 'opening' | 'password' | 'edit' | 'applying' | 'result';
  let phase = $state<Phase>('empty');
  // 画面に出す文は、文を作る関数で持つ（言語を切り替えたとき、出ている文も今の言語で出し直すため）
  type Text = (() => string) | null;
  let status = $state<Text>(null);
  let error = $state<Text>(null);
  let fileName = $state('');
  let info = $state<DocInfo | null>(null);
  let epoch = $state(0);
  let marks = $state<Mark[]>([]);
  let selectedId = $state<string | null>(null);
  let tool = $state<'select' | 'rect'>('rect');
  let newMode = $state<MarkMode>('fill');
  let newColor = $state('#000000');
  let zoom = $state(1);
  let currentPage = $state(0);
  let scroller: HTMLDivElement | undefined = $state();
  let thumbsEl: HTMLElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let dragOver = $state(false);

  let passwordInput = $state('');
  let passwordError = $state<Text>(null);

  let searchText = $state('');
  let ignoreCase = $state(true);
  let searchMsg = $state<Text>(null);

  let confirmOpen = $state(false);
  // 文書の情報・しおり・添付・スクリプトも消す（推奨。既定で入れる）
  let stripDocument = $state(true);
  let choice = $state<ApplyChoice>({ lineArtTouchedPages: [], rasterPages: [] });
  let result = $state.raw<ApplyResult | null>(null);
  let choiceDialog = $state<{ pixelPages: number[]; otherPages: number[]; selection: Record<number, 'raster' | 'touched'> } | null>(null);
  let view = $state<'source' | 'result'>('source');

  let handoffId = $state<string | null>(null);
  // 本体からの受け取りを待っている間だけ持つ、待つのをやめる関数
  let stopHandoff: (() => void) | null = null;
  let handoffWaiting = $state(false);
  let returnState = $state<'idle' | 'sending' | 'done' | 'closed'>('idle');

  let seq = 0;
  const newId = () => `d${Date.now().toString(36)}${(++seq).toString(36)}`;

  const marksByPage = $derived.by(() => {
    const m = new Map<number, Mark[]>();
    for (const x of marks) {
      const list = m.get(x.page) ?? [];
      list.push(x);
      m.set(x.page, list);
    }
    return m;
  });
  const selected = $derived(marks.find((m) => m.id === selectedId) ?? null);
  const markPages = $derived(new Set(marks.map((m) => m.page)).size);
  const editable = $derived(phase === 'edit');

  // 各ページの上端（スクロールの位置の計算用）
  const tops = $derived.by(() => {
    const out: number[] = [];
    let y = PAD;
    for (const p of info?.pages ?? []) {
      out.push(y);
      y += p.height * zoom + PAGE_GAP;
    }
    return out;
  });

  function hexToRgb(hex: string): RGB {
    const v = parseInt(hex.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  function rgbToHex(c: RGB): string {
    return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }

  function fail(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // ワーカーの誤りは日本語の文言（鍵）で届く。辞書にあれば今の言語にする（MuPDF の英語の誤りなどはそのまま）
    error = () => t(message);
  }

  async function openFile(blob: Blob, name: string) {
    error = null;
    status = () => t('開いています…');
    phase = 'opening';
    fileName = name;
    marks = [];
    selectedId = null;
    result = null;
    choice = { lineArtTouchedPages: [], rasterPages: [] };
    returnState = 'idle';
    view = 'source';
    info = null;
    scheduler.reset();
    try {
      const r = await worker.open(blob);
      if (r.needsPassword) {
        phase = 'password';
        status = null;
        passwordInput = '';
        passwordError = null;
        return;
      }
      await afterOpen();
    } catch (e) {
      phase = 'empty';
      status = null;
      fail(e);
    }
  }

  async function submitPassword(ev: Event) {
    ev.preventDefault();
    try {
      const r = await worker.auth(passwordInput);
      if (!r.ok) {
        passwordError = () => t('パスワードが違います');
        return;
      }
      passwordInput = '';
      await afterOpen();
    } catch (e) {
      fail(e);
    }
  }

  function cancelPassword() {
    passwordInput = '';
    phase = 'empty';
    worker.close();
  }

  async function afterOpen() {
    phase = 'opening';
    const r = await worker.load();
    info = r.info;
    marks = r.marks;
    epoch++;
    phase = 'edit';
    const candidates = r.marks.length;
    status = candidates ? () => t('墨消しの候補を {n} 件読み込みました', { n: candidates }) : null;
    await tick();
    fitWidth();
  }

  // 引き継ぎを待つのをやめる（後から PDF が届いても開かず、received も返さない）
  function cancelHandoff(clearStatus: boolean) {
    if (!handoffWaiting) return;
    stopHandoff?.();
    stopHandoff = null;
    handoffWaiting = false;
    handoffId = null;
    if (clearStatus) {
      phase = 'empty';
      status = null;
    }
  }

  function onFileChange(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) {
      cancelHandoff(false);
      handoffId = null;
      openFile(f, f.name);
    }
    (ev.target as HTMLInputElement).value = '';
  }

  function onDrop(ev: DragEvent) {
    ev.preventDefault();
    dragOver = false;
    const f = ev.dataTransfer?.files?.[0];
    if (f && phase !== 'applying') {
      cancelHandoff(false);
      handoffId = null;
      openFile(f, f.name);
    }
  }

  // ---- 表示 ----
  function fitWidth() {
    if (!scroller || !info) return;
    const maxW = Math.max(...info.pages.map((p) => p.width));
    zoom = Math.max(0.25, Math.min(3, (scroller.clientWidth - PAD * 2) / maxW));
  }

  async function setZoom(z: number) {
    const page = currentPage;
    zoom = Math.max(0.25, Math.min(4, z));
    await tick();
    scrollToPage(page);
  }

  function scrollToPage(i: number) {
    if (!scroller || tops[i] === undefined) return;
    scroller.scrollTop = tops[i] - PAD / 2;
    currentPage = i;
  }

  function onScroll() {
    if (!scroller) return;
    const y = scroller.scrollTop + scroller.clientHeight / 3;
    let p = 0;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= y) p = i;
    currentPage = p;
  }

  // ---- 範囲 ----
  function createMark(page: number, rect: Rect) {
    const m: Mark = { id: newId(), page, rect, mode: newMode, color: hexToRgb(newColor), source: 'draw' };
    marks.push(m);
    selectedId = m.id;
  }

  function changeMark(id: string, rect: Rect) {
    const m = marks.find((x) => x.id === id);
    if (m) m.rect = rect;
  }

  function deleteMark(id: string) {
    marks = marks.filter((m) => m.id !== id);
    if (selectedId === id) selectedId = null;
  }

  function clearMarks() {
    marks = [];
    selectedId = null;
  }

  function setSelectedMode(mode: MarkMode) {
    if (selected) selected.mode = mode;
  }

  function setSelectedColor(hex: string) {
    if (selected) selected.color = hexToRgb(hex);
  }

  function selectFromList(m: Mark) {
    selectedId = m.id;
    scrollToPage(m.page);
  }

  function onKey(ev: KeyboardEvent) {
    const el = ev.target as HTMLElement;
    // 文字を入力する欄では、Delete・Backspace を文字の削除に使う
    const typing = el instanceof HTMLInputElement ? ['text', 'search', 'password', 'number', 'email', 'url', 'tel'].includes(el.type) : el?.tagName === 'TEXTAREA' || el?.isContentEditable;
    if (typing) return;
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedId && editable) {
      deleteMark(selectedId);
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      selectedId = null;
    }
  }

  async function runSearch(ev: Event) {
    ev.preventDefault();
    if (!searchText.trim()) return;
    try {
      const r = await worker.search(searchText, ignoreCase);
      let added = 0;
      const pages = new Set<number>();
      for (const h of r.hits) {
        for (const rect of h.rects) {
          // 既にある範囲とほぼ同じものは足さない
          const dup = marks.some((m) => m.page === h.page && Math.abs(m.rect[0] - rect[0]) < 0.5 && Math.abs(m.rect[1] - rect[1]) < 0.5 && Math.abs(m.rect[2] - rect[2]) < 0.5 && Math.abs(m.rect[3] - rect[3]) < 0.5);
          if (dup) continue;
          marks.push({ id: newId(), page: h.page, rect, mode: newMode, color: hexToRgb(newColor), source: 'search' });
          added++;
          pages.add(h.page);
        }
      }
      const hits = r.hits.length;
      const pageCount = pages.size;
      const truncated = r.truncatedPages.map((p) => p + 1);
      searchMsg = () => {
        let m = hits === 0 ? t('見つかりませんでした') : t('{hits} か所が見つかり、{added} 件の範囲を追加しました（{pages} ページ）', { hits, added, pages: pageCount });
        if (truncated.length) m += t('。{list} ページは件数が多く、すべては拾えていない可能性があります', { list: truncated.join(t('・')), n: truncated.length });
        return m;
      };
    } catch (e) {
      fail(e);
    }
  }

  // ---- 適用 ----
  function askApply() {
    if (!marks.length) return;
    confirmOpen = true;
  }

  async function runApply() {
    confirmOpen = false;
    choiceDialog = null;
    error = null;
    phase = 'applying';
    status = () => t('墨消しを適用しています…');
    try {
      const r = await worker.apply($state.snapshot(marks) as Mark[], $state.snapshot(choice) as ApplyChoice, { stripDocument });
      result = r;
      info = await worker.view('result');
      view = 'result';
      epoch++;
      phase = 'result';
      returnState = 'idle';
      status = r.report.ok ? () => t('適用しました。事後検査はすべて合格です') : () => t('適用しましたが、事後検査に合格しない範囲があります');
      const pixelPages = r.report.pixelFailedPages;
      const otherPages = r.report.otherFailedPages.filter((p) => !pixelPages.includes(p));
      if (pixelPages.length || otherPages.length) {
        const selection: Record<number, 'raster' | 'touched'> = {};
        for (const p of [...pixelPages, ...otherPages]) selection[p] = 'raster';
        choiceDialog = { pixelPages, otherPages, selection };
      }
      await tick();
      fitWidth();
    } catch (e) {
      phase = 'edit';
      status = null;
      fail(e);
    }
  }

  function applyChoice() {
    if (!choiceDialog) return;
    const touched = new Set(choice.lineArtTouchedPages);
    const raster = new Set(choice.rasterPages);
    for (const [k, v] of Object.entries(choiceDialog.selection)) {
      const p = Number(k);
      if (v === 'touched') {
        touched.add(p);
        raster.delete(p);
      } else {
        raster.add(p);
      }
    }
    choice = { lineArtTouchedPages: [...touched], rasterPages: [...raster] };
    runApply();
  }

  async function backToEdit() {
    try {
      info = await worker.view('source');
      view = 'source';
      epoch++;
      phase = 'edit';
      result = null;
      choiceDialog = null;
      choice = { lineArtTouchedPages: [], rasterPages: [] };
      status = null;
    } catch (e) {
      fail(e);
    }
  }

  function outputBlob(): Blob | null {
    if (!result) return null;
    return new Blob([result.bytes as BlobPart], { type: 'application/pdf' });
  }

  function save() {
    const blob = outputBlob();
    if (!blob || !result?.report.ok) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = returnName(fileName, t('文書'), t('_墨消し'));
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function sendBack() {
    const blob = outputBlob();
    if (!blob || !handoffId || !result?.report.ok) return;
    returnState = 'sending';
    const ok = await returnToEditor(handoffId, returnName(fileName, t('文書'), t('_墨消し')), blob);
    returnState = ok ? 'done' : 'closed';
  }

  const counts = $derived({
    fill: marks.filter((m) => m.mode === 'fill').length,
    blur: marks.filter((m) => m.mode === 'blur').length,
  });

  const checkSummary = $derived.by(() => {
    if (!result) return '';
    const n = result.report.marks.length;
    const bad = result.report.marks.filter((m) => !m.ok).length;
    return bad === 0 ? t('事後検査: {n} 件すべて合格', { n }) : t('事後検査: {n} 件中 {bad} 件が不合格', { n, bad });
  });

  const markIndex = $derived(new Map(marks.map((m, i) => [m.id, i + 1])));

  // ①の説明（ワーカーから鍵と値で届く）を、今の言語の文にする
  function pixelsText(detail: Msg[]): string {
    return detail.map(tm).join(t('、'));
  }

  onMount(() => {
    const id = readHandoffId(location.hash);
    if (!id) return;
    handoffId = id;
    // 再読み込みで待ち直さないよう、URL から id を外す
    history.replaceState(null, '', location.pathname + location.search);
    status = () => t('編集アプリから受け取っています…');
    phase = 'opening';
    handoffWaiting = true;
    const done = () => {
      handoffWaiting = false;
      stopHandoff = null;
    };
    stopHandoff = receiveHandoff(id, {
      onPayload: (name, blob) => {
        done();
        openFile(blob, name);
      },
      onPreparing: () => {
        status = () => t('編集アプリが PDF を作っています…');
      },
      onFailed: (message) => {
        done();
        phase = 'empty';
        status = null;
        handoffId = null;
        // message は本体が送った文（本体の言語）か、受け取り側の既定の文（日本語の鍵）
        error = () => t('編集アプリから PDF を受け取れませんでした: {message}', { message: t(message) });
      },
      onTimeout: () => {
        done();
        phase = 'empty';
        status = null;
        handoffId = null;
        error = () => t('編集アプリから PDF を受け取れませんでした。編集アプリの画面からもう一度開くか、ファイルを開いてください');
      },
    });
    return () => stopHandoff?.();
  });

  // 範囲の重なり（同じページで重なる範囲があれば知らせる。適用には差し支えない）
  const overlaps = $derived.by(() => {
    let n = 0;
    for (const list of marksByPage.values()) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (rectsIntersect(list[i].rect, list[j].rect)) n++;
    }
    return n;
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="app"
  class:dragover={dragOver}
  ondragover={(e) => {
    e.preventDefault();
    dragOver = true;
  }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
>
  <header>
    <h1>{t('精密墨消し')}</h1>
    <button data-testid="open-button" onclick={() => fileInput?.click()} disabled={phase === 'applying'}>{t('PDF を開く')}</button>
    <input bind:this={fileInput} data-testid="open-input" type="file" accept="application/pdf,.pdf" hidden onchange={onFileChange} />
    {#if fileName}<span class="filename" data-testid="file-name" title={fileName}>{fileName}</span>{/if}
    {#if info}
      <div class="group" aria-label={t('拡大・縮小')}>
        <button onclick={() => setZoom(zoom / 1.25)} title={t('縮小')}>−</button>
        <span class="zoom" data-testid="zoom">{Math.round(zoom * 100)}%</span>
        <button onclick={() => setZoom(zoom * 1.25)} title={t('拡大')}>＋</button>
        <button onclick={fitWidth}>{t('幅に合わせる')}</button>
      </div>
    {/if}
    {#if phase === 'edit'}
      <div class="group" aria-label={t('道具')}>
        <button class:active={tool === 'rect'} data-testid="tool-rect" onclick={() => (tool = 'rect')}>{t('矩形を描く')}</button>
        <button class:active={tool === 'select'} data-testid="tool-select" onclick={() => (tool = 'select')}>{t('選ぶ')}</button>
      </div>
      <div class="group" aria-label={t('新しい範囲の方式')}>
        <select bind:value={newMode} data-testid="new-mode" title={t('新しい範囲の方式')}>
          <option value="fill">{t('塗りつぶし')}</option>
          <option value="blur">{t('ぼかし')}</option>
        </select>
        {#if newMode === 'fill'}
          <input type="color" bind:value={newColor} title={t('塗りの色')} data-testid="new-color" />
        {/if}
      </div>
      <span class="spacer"></span>
      <button class="primary" data-testid="apply-button" disabled={!marks.length} onclick={askApply}>{t('墨消しを適用（{n}）', { n: marks.length })}</button>
    {:else if phase === 'result'}
      <span class="spacer"></span>
      <button data-testid="back-button" onclick={backToEdit}>{t('指定に戻る')}</button>
      <button class="primary" data-testid="save-button" disabled={!result?.report.ok} onclick={save}>{t('保存')}</button>
      {#if handoffId}
        <button class="primary" data-testid="return-button" disabled={!result?.report.ok || returnState === 'sending' || returnState === 'done'} onclick={sendBack}>{t('編集アプリに戻す')}</button>
      {/if}
    {:else}
      <span class="spacer"></span>
    {/if}
    <!-- 言語の切り替え（今と違う方の言語の名前を、その言語で出す。本人が選んだ言語は保存する） -->
    <button data-testid="lang-switch" lang={lang.current === 'ja' ? 'en' : 'ja'} onclick={() => setLang(lang.current === 'ja' ? 'en' : 'ja')}>{lang.current === 'ja' ? 'English' : '日本語'}</button>
  </header>

  {#if status || error}
    <div class="statusbar">
      {#if status}<span data-testid="status">{status()}</span>{/if}
      {#if handoffWaiting}<button class="link-btn" data-testid="handoff-cancel" onclick={() => cancelHandoff(true)}>{t('引き継ぎをやめる')}</button>{/if}
      {#if error}<span class="error" data-testid="error">{error()}</span>{/if}
    </div>
  {/if}

  <div class="body">
    {#if info}
      <aside class="thumbs" bind:this={thumbsEl}>
        {#each info.pages as size, i (i)}
          <Thumb index={i} {size} {epoch} {scheduler} root={thumbsEl ?? null} count={view === 'source' ? (marksByPage.get(i)?.length ?? 0) : 0} current={i === currentPage} onClick={scrollToPage} />
        {/each}
      </aside>
      <div class="scroller" bind:this={scroller} onscroll={onScroll} data-testid="scroller">
        <div class="pages" style:padding="{PAD}px">
          {#each info.pages as size, i (i)}
            <PageSlot
              index={i}
              {size}
              {zoom}
              {epoch}
              {scheduler}
              root={scroller ?? null}
              marks={view === 'source' ? (marksByPage.get(i) ?? []) : []}
              {selectedId}
              {tool}
              {editable}
              onCreate={createMark}
              onChange={changeMark}
              onSelect={(id) => (selectedId = id)}
            />
          {/each}
        </div>
      </div>
      <aside class="panel">
        {#if view === 'source'}
          <section>
            <h2>{t('文字列で探してマーク')}</h2>
            <form onsubmit={runSearch} class="search">
              <input type="search" bind:value={searchText} placeholder={t('消したい文字列')} data-testid="search-input" disabled={!editable} />
              <button type="submit" data-testid="search-button" disabled={!editable || !searchText.trim()}>{t('探す')}</button>
            </form>
            <label class="check"><input type="checkbox" bind:checked={ignoreCase} data-testid="search-ignore-case" /> {t('大文字と小文字を区別しない')}</label>
            {#if searchMsg}<p class="small" data-testid="search-message">{searchMsg()}</p>{/if}
          </section>
          {#if selected}
            <section data-testid="selected-panel">
              <h2>{t('選んだ範囲')}</h2>
              <div class="row">
                <label><input type="radio" name="mode" checked={selected.mode === 'fill'} onchange={() => setSelectedMode('fill')} /> {t('塗りつぶし')}</label>
                <label><input type="radio" name="mode" checked={selected.mode === 'blur'} onchange={() => setSelectedMode('blur')} data-testid="selected-blur" /> {t('ぼかし')}</label>
              </div>
              {#if selected.mode === 'fill'}
                <label class="row">{t('塗りの色')} <input type="color" value={rgbToHex(selected.color)} oninput={(e) => setSelectedColor((e.target as HTMLInputElement).value)} /></label>
              {/if}
              <button class="danger" onclick={() => deleteMark(selected.id)} data-testid="delete-selected">{t('この範囲を消す')}</button>
            </section>
          {/if}
          <section>
            <h2>{t('墨消しの範囲')} <span class="muted" data-testid="mark-count">{t('{n} 件', { n: marks.length })}</span></h2>
            {#if marks.length}
              <p class="small muted">{t('塗りつぶし {fill} 件・ぼかし {blur} 件・{pages} ページ', { fill: counts.fill, blur: counts.blur, pages: markPages })}{#if overlaps}{t('・重なり {n} か所', { n: overlaps })}{/if}</p>
              <ul class="marklist">
                {#each marks as m, i (m.id)}
                  <li class:sel={m.id === selectedId}>
                    <button class="link" onclick={() => selectFromList(m)}>
                      {i + 1}. {t('{p} ページ・{source}・{mode}', { p: m.page + 1, source: m.source === 'draw' ? t('描いた範囲') : m.source === 'search' ? t('検索') : t('引き継いだ候補'), mode: m.mode === 'fill' ? t('塗り') : t('ぼかし') })}
                    </button>
                    <button class="x" title={t('消す')} onclick={() => deleteMark(m.id)} disabled={!editable}>×</button>
                  </li>
                {/each}
              </ul>
              <button class="danger" onclick={clearMarks} disabled={!editable}>{t('すべて消す')}</button>
            {:else}
              <p class="small muted">{t('ページの上をドラッグして範囲を描くか、文字列で探してマークします。')}</p>
            {/if}
          </section>
        {:else if result}
          <section>
            <h2>{t('適用の結果')}</h2>
            <p class:ok={result.report.ok} class:bad={!result.report.ok} class="summary" data-testid="check-summary">{checkSummary}</p>
            <p class="small">{t('削除した注釈 {annots} 件・取り除いた ActualText などの属性 {attrs} 件', { annots: result.removedAnnots, attrs: result.removedActualText })}{#if choice.rasterPages.length}{t('・画像化したページ {list}', { list: choice.rasterPages.map((p) => p + 1).join(t('・')) })}{/if}{#if choice.lineArtTouchedPages.length}{t('・線も削除したページ {list}', { list: choice.lineArtTouchedPages.map((p) => p + 1).join(t('・')) })}{/if}</p>
            <p class="small" data-testid="removed-doc-items">{result.removedDocItems.length ? t('消した文書の項目: {items}', { items: result.removedDocItems.map((x) => t(x)).join(t('・')) }) : stripDocument ? t('消した文書の項目: なし（もともとありません）') : t('文書の情報・しおり・添付・スクリプトは残しています')}</p>
            {#if result.encrypted}<p class="small">{t('出力は元と同じパスワードで保護されています。')}</p>{/if}
            <table class="checks">
              <thead><tr><th>{t('範囲')}</th><th title={t('画素（覆いだけが見え、下に内容が残らない）')}>①</th><th title={t('範囲内の文字')}>②</th><th title={t('ActualText・Alt・E')}>③</th><th title={t('交差する注釈')}>④</th></tr></thead>
              <tbody>
                {#each result.report.marks as c (c.markId)}
                  <tr data-testid="check-row" data-ok={c.ok} data-page={c.page}>
                    <td>{t('{i}（{p}p）', { i: markIndex.get(c.markId) ?? '?', p: c.page + 1 })}</td>
                    <td class:bad={!c.pixels} title={pixelsText(c.pixelsDetail)}>{c.pixels ? t('合格') : t('不合格')}</td>
                    <td class:bad={c.chars > 0}>{t('{n} 字', { n: c.chars })}</td>
                    <td class:bad={c.actualText > 0}>{c.actualText === 0 ? t('なし') : t('{n} 件', { n: c.actualText })}</td>
                    <td class:bad={c.annots > 0}>{c.annots === 0 ? t('なし') : t('{n} 件', { n: c.annots })}</td>
                  </tr>
                  {#if !c.pixels}<tr class="detail"><td colspan="5">① {pixelsText(c.pixelsDetail)}</td></tr>{/if}
                {/each}
              </tbody>
            </table>
            {#if !result.report.ok}
              <p class="small bad">{t('不合格の範囲があるため、保存・戻しはできません。')}{#if !choiceDialog}<button class="link" onclick={() => runApply()}>{t('もう一度適用する')}</button>{/if}</p>
            {/if}
            {#if returnState === 'sending'}<p class="small" data-testid="return-status">{t('編集アプリへ戻しています…')}</p>{/if}
            {#if returnState === 'done'}<p class="small ok" data-testid="return-status">{t('編集アプリに戻しました。このタブは閉じてかまいません。')}</p>{/if}
            {#if returnState === 'closed'}
              <p class="small bad" data-testid="return-status">{t('編集アプリから応答がありません（閉じられた可能性があります）。「保存」でダウンロードしてください。')}</p>
            {/if}
          </section>
        {/if}
      </aside>
    {:else}
      <div class="empty">
        {#if phase === 'opening'}
          <p>{t('読み込んでいます…')}</p>
        {:else}
          <p>{t('墨消しする PDF を開いてください（ここへドロップもできます）。')}</p>
          <button class="primary" onclick={() => fileInput?.click()}>{t('PDF を開く')}</button>
          <p class="small muted">{t('文字データを残したまま、指定した範囲の文字・画像・線・注釈・ActualText を消し、消えたことを確かめてから保存します。')}<br />{t('ファイルはこの端末の中だけで処理し、外部へは送りません。')}</p>
        {/if}
      </div>
    {/if}
  </div>

  <footer>
    {#if SOURCE_URL}
      <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-testid="source-link">{t('ソースコード')}</a>
    {:else}
      <span data-testid="source-link">{t('ソースコード: 準備中')}</span>
    {/if}
    <span data-testid="license">{t('ライセンス:')} <a href="LICENSE.txt" target="_blank">{LICENSE_NAME}</a></span>
    <a href="licenses.txt" target="_blank" data-testid="third-party">{t('第三者のライセンス')}</a>
    <span class="muted">{t('MuPDF（Artifex Software, AGPL-3.0）を使用')}</span>
    <span class="spacer"></span>
    <span class="muted" data-testid="isolation">{t('クロスオリジン分離: {state}', { state: isolated ? t('有効') : t('無効') })}</span>
  </footer>
</div>

{#if phase === 'password'}
  <div class="dialog-backdrop">
    <form class="dialog" onsubmit={submitPassword} data-testid="password-dialog">
      <h2>{t('パスワード')}</h2>
      <p class="small">{t('この PDF はパスワードで保護されています。パスワードは保存しません。')}</p>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="password" bind:value={passwordInput} autocomplete="off" autofocus data-testid="password-input" />
      {#if passwordError}<p class="small bad" data-testid="password-error">{passwordError()}</p>{/if}
      <div class="actions">
        <button type="button" onclick={cancelPassword}>{t('やめる')}</button>
        <button type="submit" class="primary" data-testid="password-submit">{t('開く')}</button>
      </div>
    </form>
  </div>
{/if}

{#if confirmOpen}
  <div class="dialog-backdrop">
    <div class="dialog" data-testid="apply-confirm">
      <h2>{t('墨消しを適用しますか')}</h2>
      <p data-testid="apply-count">{t('{n} 件の範囲（{pages} ページ。塗りつぶし {fill} 件・ぼかし {blur} 件）', { n: marks.length, pages: markPages, fill: counts.fill, blur: counts.blur })}</p>
      <ul class="small">
        <li>{t('範囲の文字・画像の画素・覆われた線を消し、範囲と交差する注釈（付箋など）を削除します')}</li>
        <li>{t('墨消ししたページの ActualText・Alt・E を取り除きます')}</li>
        <li>{t('保存した PDF を開き直して、消えたことを確かめます')}</li>
      </ul>
      <label class="check">
        <input type="checkbox" bind:checked={stripDocument} data-testid="strip-document" />
        {t('文書の情報・しおり・添付・スクリプトも消す（推奨）')}
      </label>
      <p class="small muted">{t('文書の情報（題名・作成者など）・XMP・しおり・添付ファイル・JavaScript・ページラベルは、範囲の内容の写しを持つことがあります。元のファイルは変わりません。')}</p>
      <div class="actions">
        <button onclick={() => (confirmOpen = false)}>{t('やめる')}</button>
        <button class="primary" data-testid="apply-confirm-ok" onclick={() => runApply()}>{t('適用する')}</button>
      </div>
    </div>
  </div>
{/if}

{#if choiceDialog}
  <div class="dialog-backdrop">
    <div class="dialog" data-testid="choice-dialog">
      <h2>{t('事後検査に合格しないページがあります')}</h2>
      {#if choiceDialog.pixelPages.length}
        <p class="small">{t('範囲の下に、一部だけ覆われた線や図形が残っています。ページごとに対処を選んでください。')}</p>
      {/if}
      {#if choiceDialog.otherPages.length}
        <p class="small">{t('文字・ActualText・注釈が残っているページは、画像化で対処します。')}</p>
      {/if}
      <ul class="choices">
        {#each [...choiceDialog.pixelPages, ...choiceDialog.otherPages] as p (p)}
          <li>
            <strong>{t('{n} ページ', { n: p + 1 })}</strong>
            <label><input type="radio" name="c{p}" checked={choiceDialog.selection[p] === 'raster'} onchange={() => (choiceDialog!.selection[p] = 'raster')} data-testid="choice-raster-{p}" /> {t('ページを画像化（既定。このページの文字は画像になります）')}</label>
            {#if choiceDialog.pixelPages.includes(p)}
              <label><input type="radio" name="c{p}" checked={choiceDialog.selection[p] === 'touched'} onchange={() => (choiceDialog!.selection[p] = 'touched')} data-testid="choice-touched-{p}" /> {t('範囲に触れる線も削除して適用し直す（範囲の外の部分も消えます）')}</label>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="actions">
        <button onclick={() => (choiceDialog = null)}>{t('閉じる')}</button>
        <button class="primary" data-testid="choice-submit" onclick={applyChoice}>{t('選んだ方法で適用し直す')}</button>
      </div>
    </div>
  </div>
{/if}

{#if phase === 'applying'}
  <div class="dialog-backdrop">
    <div class="dialog" data-testid="applying">
      <p>{t('墨消しを適用し、事後検査をしています…')}</p>
    </div>
  </div>
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .app.dragover {
    outline: 3px dashed var(--accent);
    outline-offset: -6px;
  }
  header {
    height: var(--header-h);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex: none;
    overflow-x: auto;
  }
  h1 {
    font-size: 16px;
    margin: 0 6px 0 0;
    white-space: nowrap;
  }
  .filename {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .group {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-left: 10px;
    border-left: 1px solid var(--border);
  }
  .zoom {
    min-width: 48px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }
  .statusbar {
    padding: 6px 14px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 16px;
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .link-btn {
    padding: 1px 8px;
    font-size: 12.5px;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .thumbs {
    width: var(--sidebar-w);
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--surface-2);
    padding: 8px 6px;
    flex: none;
  }
  .scroller {
    flex: 1;
    overflow: auto;
    min-width: 0;
  }
  .pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: max-content;
  }
  .panel {
    width: var(--panel-w);
    overflow-y: auto;
    border-left: 1px solid var(--border);
    background: var(--surface);
    padding: 12px 14px;
    flex: none;
  }
  .panel h2 {
    font-size: 14px;
    margin: 0 0 8px;
  }
  .panel section {
    margin-bottom: 20px;
  }
  .search {
    display: flex;
    gap: 6px;
  }
  .search input {
    flex: 1;
    min-width: 0;
  }
  .check {
    display: block;
    margin-top: 6px;
    font-size: 13px;
  }
  .small {
    font-size: 12.5px;
    line-height: 1.6;
  }
  .row {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 8px;
  }
  .marklist {
    list-style: none;
    padding: 0;
    margin: 0 0 8px;
    max-height: 40vh;
    overflow-y: auto;
  }
  .marklist li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: var(--radius-sm);
  }
  .marklist li.sel {
    background: var(--accent-weak);
  }
  button.link {
    border: none;
    background: none;
    padding: 4px 2px;
    text-align: left;
    color: inherit;
    white-space: normal;
  }
  button.x {
    border: none;
    background: none;
    color: var(--muted);
    padding: 2px 6px;
  }
  .summary {
    font-weight: 600;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
  }
  .summary.ok {
    background: var(--ok-weak);
    color: var(--ok);
  }
  .summary.bad {
    background: var(--danger-weak);
    color: var(--danger);
  }
  .ok {
    color: var(--ok);
  }
  .bad {
    color: var(--danger);
  }
  .checks {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  .checks th,
  .checks td {
    border-bottom: 1px solid var(--border);
    padding: 4px 3px;
    text-align: left;
  }
  .checks tr.detail td {
    color: var(--danger);
    font-size: 12px;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    padding: 24px;
  }
  .choices {
    list-style: none;
    padding: 0;
  }
  .choices li {
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  footer {
    height: var(--footer-h);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 14px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: 12px;
    flex: none;
  }
</style>
