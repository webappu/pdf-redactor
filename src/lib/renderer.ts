// 描画の順番待ち。見えているページ（本文 → サムネイル）から順に 1 枚ずつワーカーへ頼む
import type { PdfWorker } from './client';

export interface RenderJob {
  key: string;
  page: number;
  scale: number;
  // 小さいほど先（本文 0、サムネイル 1）
  priority: number;
  done: (bitmap: ImageBitmap | null) => void;
}

export class RenderScheduler {
  private jobs = new Map<string, RenderJob>();
  private busy = false;
  // 文書を切り替えたら上げる（古い描画を捨てる）
  private epoch = 0;

  constructor(private worker: PdfWorker) {}

  request(job: RenderJob): void {
    const old = this.jobs.get(job.key);
    if (old) old.done(null);
    this.jobs.set(job.key, job);
    this.pump();
  }

  cancel(key: string): void {
    const job = this.jobs.get(key);
    if (job) {
      this.jobs.delete(key);
      job.done(null);
    }
  }

  reset(): void {
    this.epoch++;
    for (const job of this.jobs.values()) job.done(null);
    this.jobs.clear();
  }

  private next(): RenderJob | null {
    let best: RenderJob | null = null;
    for (const j of this.jobs.values()) {
      if (!best || j.priority < best.priority || (j.priority === best.priority && j.page < best.page)) best = j;
    }
    return best;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const job = this.next();
    if (!job) return;
    this.jobs.delete(job.key);
    this.busy = true;
    const epoch = this.epoch;
    try {
      const r = await this.worker.render(job.page, job.scale);
      if (epoch === this.epoch) job.done(r.bitmap);
      else {
        r.bitmap.close();
        job.done(null);
      }
    } catch {
      job.done(null);
    } finally {
      this.busy = false;
      this.pump();
    }
  }
}
