// Ping takibi: ekrana tek ölçüm yerine ortanca; bağlantı uzun süre yavaş ya da sessizse yeniden bağlanma kararı.

/** Bu kadar ms'yi aşan ölçüm "yavaş" sayılır. */
export const SLOW_RTT_MS = 600;
/** Art arda bu kadar yavaş ölçüm (2 sn'de bir ping: ~8 sn) bağlantıyı yeniletir. */
export const SLOW_PINGS = 4;
/** Bu kadar süre hiç pong gelmezse bağlantı takılmış sayılır. */
export const STALL_MS = 8000;
/** İki zorla yeniden bağlanma arasında en az bu kadar beklenir (hat gerçekten kötüyse döngüye girmesin). */
export const KICK_COOLDOWN_MS = 60_000;
const WINDOW = 5;

export class RttMonitor {
  /** Ekranda gösterilen ping: son ölçümlerin ortancası. */
  rtt = 0;
  private samples: number[] = [];
  private slow = 0;
  private lastPong = 0;
  private lastKick = -Infinity;

  /** Yeni bağlantı açıldı. */
  reset(now: number): void {
    this.samples = [];
    this.slow = 0;
    this.lastPong = now;
  }

  /** Pong geldi; yeniden bağlanılması gerekiyorsa true. */
  sample(rtt: number, now: number): boolean {
    this.lastPong = now;
    this.samples.push(rtt);
    if (this.samples.length > WINDOW) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.rtt = sorted[sorted.length >> 1];
    this.slow = rtt > SLOW_RTT_MS ? this.slow + 1 : 0;
    return this.slow >= SLOW_PINGS && this.kick(now);
  }

  /** Ping gönderilmeden önce: uzun süredir pong gelmediyse true. */
  stalled(now: number): boolean {
    return now - this.lastPong > STALL_MS && this.kick(now);
  }

  private kick(now: number): boolean {
    if (now - this.lastKick < KICK_COOLDOWN_MS) return false;
    this.lastKick = now;
    this.slow = 0;
    return true;
  }
}
