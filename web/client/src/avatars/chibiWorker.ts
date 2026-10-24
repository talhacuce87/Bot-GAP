// Chibi kıyafet kurucusu (Web Worker): paket burada da tutulur, kıyafet dizileri ana iş parçacığını durdurmadan
// kurulup aktarılır (şapkalı bir kıyafet 5–60 ms sürüyordu; oyuncu yaklaşınca kare takılıyordu).
import type { Look } from "../../../shared/protocol";
import { type ChibiManifest, ChibiPack } from "./chibiPack";

export type BakeRequest = { t: "init"; manifest: ChibiManifest; buf: ArrayBuffer } | { t: "bake"; id: number; look: Look | null; lod: 0 | 1 };

let pack: ChibiPack | null = null;

self.onmessage = (e: MessageEvent<BakeRequest>) => {
  const m = e.data;
  if (m.t === "init") {
    pack = new ChibiPack(m.manifest, m.buf);
    return;
  }
  if (!pack) return;
  const a = pack.bake(m.look, m.lod);
  const transfer: ArrayBuffer[] = [a.pos, a.nor, a.col, a.limb, a.outl, a.index].map((v) => v.buffer as ArrayBuffer);
  if (a.index2) transfer.push(a.index2.buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage({ id: m.id, a }, transfer);
};
