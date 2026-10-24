// Kıyafet geometrisini chibiWorker'da kurdurur: oyun sırasında ana iş parçacığında kıyafet kurulmaz. İşçi
// açılamazsa (eski tarayıcı, test) aynı iş burada yapılır.
import type * as THREE from "three";
import type { Look } from "../../../shared/protocol";
import { type ChibiArrays, type ChibiManifest, type ChibiPack, chibiGeometry } from "./chibiPack";
import type { BakeRequest } from "./chibiWorker";

export class ChibiBaker {
  private worker: Worker | null = null;
  private next = 1;
  private wait = new Map<number, { look: Look | null; lod: 0 | 1; done: (g: THREE.BufferGeometry) => void }>();

  /** `buf` işçiye kopyalanır (paketin kendisi ana iş parçacığında kalır: gardırop önizlemesi, pivotlar). */
  constructor(
    private pack: ChibiPack,
    manifest: ChibiManifest,
    buf: ArrayBuffer,
  ) {
    if (typeof Worker !== "function") return;
    try {
      const w = new Worker(new URL("./chibiWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ id: number; a: ChibiArrays }>) => {
        const job = this.wait.get(e.data.id);
        if (!job) return;
        this.wait.delete(e.data.id);
        job.done(chibiGeometry(e.data.a));
      };
      w.onerror = (e) => {
        console.warn("[chibi] kurulum işçisi açılamadı, ana iş parçacığında kurulur:", e.message);
        this.worker = null;
        w.terminate();
        for (const job of this.wait.values()) job.done(this.pack.build(job.look, job.lod));
        this.wait.clear();
      };
      w.postMessage({ t: "init", manifest, buf } satisfies BakeRequest);
      this.worker = w;
    } catch (err) {
      console.warn("[chibi] kurulum işçisi yok:", err);
    }
  }

  /** Kıyafetin geometrisi (işçide kurulur; birkaç ms – birkaç on ms sonra gelir). */
  geometry(look: Look | null | undefined, lod: 0 | 1): Promise<THREE.BufferGeometry> {
    const w = this.worker;
    if (!w) return Promise.resolve(this.pack.build(look, lod));
    return new Promise((done) => {
      const id = this.next++;
      this.wait.set(id, { look: look ?? null, lod, done });
      w.postMessage({ t: "bake", id, look: look ?? null, lod } satisfies BakeRequest);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
