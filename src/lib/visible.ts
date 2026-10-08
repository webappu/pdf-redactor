// 要素が画面（または指定した入れ物）の近くに入ったかを知らせる（Svelte のアクション）
export function visible(node: HTMLElement, params: { onChange: (v: boolean) => void; margin?: string; root?: HTMLElement | null }) {
  let current = params;
  const make = () =>
    new IntersectionObserver(
      (entries) => {
        for (const e of entries) current.onChange(e.isIntersecting);
      },
      { root: current.root ?? null, rootMargin: current.margin ?? '300px' },
    );
  let io = make();
  io.observe(node);
  return {
    update(p: typeof params) {
      const rootChanged = p.root !== current.root || p.margin !== current.margin;
      current = p;
      if (rootChanged) {
        io.disconnect();
        io = make();
        io.observe(node);
      }
    },
    destroy() {
      io.disconnect();
    },
  };
}
