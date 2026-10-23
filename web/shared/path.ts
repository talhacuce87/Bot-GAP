// Yol çizgileri: kontrol noktalarından yaylı orta çizgi ve kırık çizgiye uzaklık (dünya yolları ve mahalle caddeleri).

/**
 * Kontrol noktalarından yol orta çizgisi, ~2 m aralıkla: düz parçalar ve her köşede `radius` yarıçaplı yay
 * (köşenin iki yanındaki parçalar kısaysa yay onlara sığacak kadar küçülür). Catmull-Rom köşede sıkışıp
 * keskin dönemeç yapıyordu; yay hep aynı yumuşaklıkta döner. Yol yine bütün kontrol noktalarının yakınından geçer.
 */
export function smoothPath(P: [number, number][], radius: number): [number, number][] {
  const out: [number, number][] = [];
  const line = (a: [number, number], b: [number, number], withEnd: boolean) => {
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let k = 0; k < n + (withEnd ? 1 : 0); k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  };
  let from: [number, number] = P[0];
  for (let i = 1; i < P.length - 1; i++) {
    const [ax, az] = P[i - 1], [bx, bz] = P[i], [cx, cz] = P[i + 1];
    const l1 = Math.hypot(bx - ax, bz - az), l2 = Math.hypot(cx - bx, cz - bz);
    const u1 = [(bx - ax) / l1, (bz - az) / l1], u2 = [(cx - bx) / l2, (cz - bz) / l2];
    const turn = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (turn < 0.01) continue;
    // Teğet uzunluğu: yay köşeden bu kadar önce başlar; parçaların yarısını geçmez
    const t = Math.min(radius * Math.tan(turn / 2), l1 / 2, l2 / 2);
    const r = t / Math.tan(turn / 2);
    const p1: [number, number] = [bx - u1[0] * t, bz - u1[1] * t], p2: [number, number] = [bx + u2[0] * t, bz + u2[1] * t];
    line(from, p1, false);
    // Yay merkezi: p1'den dönüş yönüne dik
    const side = Math.sign(u1[0] * u2[1] - u1[1] * u2[0]);
    const cxr = p1[0] - u1[1] * r * side, czr = p1[1] + u1[0] * r * side;
    const a0 = Math.atan2(p1[1] - czr, p1[0] - cxr);
    const n = Math.max(2, Math.ceil((r * turn) / 2));
    for (let k = 0; k < n; k++) {
      const a = a0 + side * turn * (k / n);
      out.push([cxr + Math.cos(a) * r, czr + Math.sin(a) * r]);
    }
    from = p2;
  }
  line(from, P[P.length - 1], true);
  return out;
}

/** (x, z)'nin kırık çizgiye uzaklığı. */
export function polylineDist(P: [number, number][], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, az] = P[i], [bx, bz] = P[i + 1];
    const ex = bx - ax, ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return best;
}
