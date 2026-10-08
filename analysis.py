"""
analysis.py — Geçmişe dönük hile/kasma analizi.

activity_log tablosundaki olaylardan kullanıcı başına metrik çıkarır ve
şüphe bayrakları üretir. Discord'a bağımlı değildir; hem AuditCog
(!analiz, !supheli) hem de komut satırı kullanır:

    docker exec <container> python analysis.py --guild <id> --days 30
    docker exec <container> python analysis.py --guild <id> --user <id>
    docker exec <container> python analysis.py --guild <id> --legacy

--legacy: Olay kaydı başlamadan önceki dönem için, user_xp ve
voice_pair_stats toplamlarından (geçmiş verilerden) çıkarım yapar.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

# Türkiye sabit UTC+3 (2016'dan beri yaz saati yok)
TR_TZ = dt.timezone(dt.timedelta(hours=3))

MESSAGE_COOLDOWN_SECONDS = 20
SESSION_GAP_SECONDS = 600          # Bu süreden uzun aralık yeni sohbet oturumu sayılır
VOICE_XP_INTERVAL_SECONDS = 120

MESSAGE_EVENTS = ("message",)
XP_EVENTS = ("xp_message", "xp_voice", "xp_streak_bonus", "admin_xp_add", "admin_xp_set")
ANALYSIS_EVENTS = MESSAGE_EVENTS + XP_EVENTS + ("suspicious", "message_delete")
QUICK_DELETE_SECONDS = 120


@dataclass
class Flag:
    code: str
    weight: int
    detail: str


@dataclass
class UserReport:
    user_id: int
    days: float
    messages: int = 0
    xp_by_source: dict[str, int] = field(default_factory=dict)
    xp_messages: int = 0
    dup_ratio: float = 0.0
    short_ratio: float = 0.0
    median_gap: float | None = None
    gap_cv: float | None = None
    cooldown_hug_ratio: float = 0.0
    quick_deletes: int = 0
    voice_ticks: int = 0
    voice_muted_ratio: float = 0.0
    top_peers: list[tuple[int, int]] = field(default_factory=list)
    hours_active: int = 0
    sleepless_days: int = 0
    realtime_flags: Counter = field(default_factory=Counter)
    flags: list[Flag] = field(default_factory=list)

    @property
    def score(self) -> int:
        return sum(f.weight for f in self.flags)

    @property
    def total_xp(self) -> int:
        return sum(self.xp_by_source.values())


def _meta(row: Mapping[str, Any]) -> dict[str, Any]:
    raw = row["meta"]
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return {}


def _cv(values: list[float]) -> float | None:
    if len(values) < 5:
        return None
    mean = statistics.fmean(values)
    if mean <= 0:
        return None
    return statistics.pstdev(values) / mean


# ---------------------------------------------------------------------------
# Kullanıcı analizi
# ---------------------------------------------------------------------------

def analyze_user(
    user_id: int,
    rows: Iterable[Mapping[str, Any]],
    days: float,
    peer_message_counts: Mapping[int, int] | None = None,
) -> UserReport:
    """rows: kullanıcının ANALYSIS_EVENTS olayları (ts artan sırada)."""
    rep = UserReport(user_id=user_id, days=days)

    msg_ts: list[float] = []
    hashes: list[str] = []
    short = 0
    voice_muted = 0
    peers: Counter = Counter()
    hour_by_day: dict[dt.date, set[int]] = defaultdict(set)
    hours: set[int] = set()
    xp_sources: Counter = Counter()

    for row in rows:
        ev = row["event"]
        ts = float(row["ts"])
        meta = _meta(row)
        local = dt.datetime.fromtimestamp(ts, TR_TZ)

        if ev == "message":
            if meta.get("cmd"):
                continue
            rep.messages += 1
            msg_ts.append(ts)
            if meta.get("h"):
                hashes.append(meta["h"])
            if int(meta.get("len", 0)) <= 3 and not meta.get("att"):
                short += 1
            hour_by_day[local.date()].add(local.hour)
            hours.add(local.hour)
        elif ev in XP_EVENTS:
            xp_sources[ev] += int(row["amount"] or 0)
            if ev == "xp_message":
                rep.xp_messages += 1
            elif ev == "xp_voice":
                rep.voice_ticks += 1
                if meta.get("mute"):
                    voice_muted += 1
                for pid in meta.get("peers", []):
                    peers[int(pid)] += 1
                hour_by_day[local.date()].add(local.hour)
                hours.add(local.hour)
        elif ev == "message_delete":
            if int(meta.get("age", 10**9)) <= QUICK_DELETE_SECONDS:
                rep.quick_deletes += 1
        elif ev == "suspicious":
            rep.realtime_flags[meta.get("rule", "?")] += 1

    rep.xp_by_source = dict(xp_sources)
    rep.hours_active = len(hours)
    rep.sleepless_days = sum(1 for hs in hour_by_day.values() if len(hs) >= 20)
    rep.top_peers = peers.most_common(5)

    if rep.messages:
        rep.short_ratio = short / rep.messages
    if len(hashes) >= 10:
        rep.dup_ratio = 1 - len(set(hashes)) / len(hashes)
    if rep.voice_ticks:
        rep.voice_muted_ratio = voice_muted / rep.voice_ticks

    gaps = [b - a for a, b in zip(msg_ts, msg_ts[1:]) if b - a < SESSION_GAP_SECONDS]
    if gaps:
        rep.median_gap = statistics.median(gaps)
        rep.gap_cv = _cv(gaps)
        hug = sum(1 for g in gaps if MESSAGE_COOLDOWN_SECONDS <= g <= MESSAGE_COOLDOWN_SECONDS + 6)
        rep.cooldown_hug_ratio = hug / len(gaps)

    _apply_flags(rep, peer_message_counts)
    return rep


def _apply_flags(rep: UserReport, peer_message_counts: Mapping[int, int] | None) -> None:
    add = rep.flags.append

    if rep.messages >= 30 and rep.dup_ratio >= 0.4:
        add(Flag("tekrar_mesaj", 3, f"mesajların %{rep.dup_ratio * 100:.0f}'i birebir tekrar"))
    if rep.messages >= 30 and rep.short_ratio >= 0.6:
        add(Flag("kisa_mesaj", 2, f"mesajların %{rep.short_ratio * 100:.0f}'i ≤3 karakter"))
    if rep.gap_cv is not None and rep.messages >= 30 and rep.gap_cv < 0.15:
        add(Flag("makro_zamanlama", 4, f"mesaj aralıkları çok düzenli (CV={rep.gap_cv:.2f}, medyan {rep.median_gap:.0f}sn)"))
    if rep.messages >= 30 and rep.cooldown_hug_ratio >= 0.5:
        add(Flag("cooldown_kasma", 3, f"aralıkların %{rep.cooldown_hug_ratio * 100:.0f}'i tam XP cooldown'ında (20-26sn)"))
    if rep.messages >= 50 and rep.xp_messages / rep.messages >= 0.9:
        add(Flag("xp_odakli_mesaj", 2, f"mesajların %{rep.xp_messages / rep.messages * 100:.0f}'i XP kazandırmış"))
    if rep.messages >= 20 and rep.quick_deletes / rep.messages >= 0.3:
        add(Flag(
            "yaz_sil", 3,
            f"{rep.quick_deletes} mesaj 2 dk içinde silinmiş (XP alıp silme / moderatör silmesi olabilir)",
        ))
    if rep.sleepless_days >= 2:
        add(Flag("uykusuz", 3, f"{rep.sleepless_days} gün boyunca ≥20 farklı saatte aktif (7/24 bot şüphesi)"))
    if rep.voice_ticks >= 60 and rep.voice_muted_ratio >= 0.9:
        hours = rep.voice_ticks * VOICE_XP_INTERVAL_SECONDS / 3600
        add(Flag("sessiz_ses", 3, f"{hours:.0f} saat ses XP'sinin %{rep.voice_muted_ratio * 100:.0f}'i mikrofon kapalı"))

    if rep.voice_ticks >= 60 and rep.messages <= 5:
        hours = rep.voice_ticks * VOICE_XP_INTERVAL_SECONDS / 3600
        add(Flag("mesajsiz_ses", 2, f"{hours:.0f} saat ses XP'si var ama sadece {rep.messages} mesaj (alt hesap olabilir)"))

    # peer_message_counts verilmediyse (None) partner kontrolü yapılmaz
    if rep.top_peers and rep.voice_ticks >= 60 and peer_message_counts is not None:
        peer_id, shared = rep.top_peers[0]
        share = shared / rep.voice_ticks
        peer_msgs = peer_message_counts.get(peer_id, 0)
        if share >= 0.8 and peer_msgs <= 5:
            add(Flag(
                "alt_hesap",
                5,
                f"ses XP'sinin %{share * 100:.0f}'i hep aynı kişiyle ({peer_id}) "
                f"ve o kişi dönemde sadece {peer_msgs} mesaj atmış",
            ))

    admin_xp = rep.xp_by_source.get("admin_xp_add", 0)
    if admin_xp >= 500:
        add(Flag("admin_xp", 1, f"admin tarafından +{admin_xp:,} XP eklenmiş"))

    for rule, count in rep.realtime_flags.items():
        add(Flag(f"canli:{rule}", min(count, 3), f"canlı dedektör {count} kez uyardı"))


# ---------------------------------------------------------------------------
# Sunucu taraması
# ---------------------------------------------------------------------------

def analyze_guild(rows: Iterable[Mapping[str, Any]], days: float) -> list[UserReport]:
    by_user: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
    msg_counts: Counter = Counter()
    for row in rows:
        uid = row["user_id"]
        if uid is None:
            continue
        by_user[int(uid)].append(row)
        if row["event"] == "message":
            msg_counts[int(uid)] += 1

    reports = [analyze_user(uid, user_rows, days, msg_counts) for uid, user_rows in by_user.items()]
    reports.sort(key=lambda r: (r.score, r.total_xp), reverse=True)
    return reports


def peer_message_counts(rows: Iterable[Mapping[str, Any]]) -> Counter:
    return Counter(int(r["user_id"]) for r in rows if r["event"] == "message" and r["user_id"] is not None)


# ---------------------------------------------------------------------------
# Eski (olay kaydı öncesi) veriler: toplamlardan çıkarım
# ---------------------------------------------------------------------------

def legacy_scan(
    users: Iterable[Mapping[str, Any]],
    pairs: Iterable[Mapping[str, Any]],
) -> list[tuple[int, list[Flag]]]:
    """
    users: user_xp satırları; pairs: voice_pair_stats satırları.
    Olay kaydı yokken bile kalıcı toplamlardan şüpheli profilleri çıkarır.
    """
    users = {int(u["user_id"]): u for u in users}
    top_partner: dict[int, tuple[int, int]] = {}
    for p in pairs:
        a, b, sec = int(p["user_low_id"]), int(p["user_high_id"]), int(p["shared_seconds"])
        for me, other in ((a, b), (b, a)):
            if sec > top_partner.get(me, (0, 0))[1]:
                top_partner[me] = (other, sec)

    results: list[tuple[int, list[Flag]]] = []
    for uid, u in users.items():
        flags: list[Flag] = []
        voice_sec = int(u["voice_seconds"])
        msgs = int(u["message_count"])
        text_xp = int(u["text_xp"])
        voice_xp = int(u["voice_xp"])

        if uid in top_partner and voice_sec >= 50 * 3600:
            partner, shared = top_partner[uid]
            share = shared / voice_sec if voice_sec else 0
            partner_row = users.get(partner)
            partner_msgs = int(partner_row["message_count"]) if partner_row else 0
            if share >= 0.8 and partner_msgs <= 20:
                flags.append(Flag(
                    "alt_hesap", 5,
                    f"{shared / 3600:.0f} saat ses süresinin %{share * 100:.0f}'i {partner} ile; "
                    f"o hesap toplam {partner_msgs} mesaj atmış",
                ))
        if voice_sec >= 200 * 3600 and msgs <= 20:
            flags.append(Flag("sessiz_ses", 3, f"{voice_sec / 3600:.0f} saat ses, sadece {msgs} mesaj"))

        # Mesaj başına beklenen üst sınır: 8 XP × %50 streak = 12; streak ödülleri hariç pay bırakılır
        if msgs >= 20 and text_xp > msgs * 14 + 2700:
            flags.append(Flag(
                "anormal_metin_xp", 2,
                f"{msgs} mesaja karşı {text_xp:,} metin XP (admin/boost etkisi olabilir)",
            ))
        # Ses XP'si 2 dakikada 1 XP; boost olmadan voice_xp ≈ voice_seconds/120 civarı olmalı
        if voice_sec > 0 and voice_xp > (voice_sec / VOICE_XP_INTERVAL_SECONDS) * 2.5 + 200:
            flags.append(Flag(
                "anormal_ses_xp", 2,
                f"{voice_sec / 3600:.0f} saat sese karşı {voice_xp:,} ses XP",
            ))
        if text_xp > 1000 and abs(text_xp - voice_xp) <= 1:
            flags.append(Flag("admin_ayar_izi", 1, "metin/ses XP tam yarı yarıya (!xpayarla/!xpekle izi)"))

        if flags:
            results.append((uid, flags))

    results.sort(key=lambda item: sum(f.weight for f in item[1]), reverse=True)
    return results


# ---------------------------------------------------------------------------
# Metin çıktısı
# ---------------------------------------------------------------------------

def format_report(rep: UserReport, name: str | None = None) -> str:
    label = name or str(rep.user_id)
    lines = [f"== {label} ({rep.user_id}) — skor {rep.score} =="]
    lines.append(f"  Dönem: son {rep.days:g} gün | Toplam kazanılan XP: {rep.total_xp:,}")
    if rep.xp_by_source:
        parts = ", ".join(f"{k}={v:,}" for k, v in sorted(rep.xp_by_source.items()))
        lines.append(f"  XP kaynakları: {parts}")
    lines.append(
        f"  Mesaj: {rep.messages} (XP alan {rep.xp_messages}) | tekrar %{rep.dup_ratio * 100:.0f} | "
        f"kısa %{rep.short_ratio * 100:.0f} | cooldown'a yapışık %{rep.cooldown_hug_ratio * 100:.0f} | "
        f"hızlı silinen {rep.quick_deletes}"
    )
    if rep.median_gap is not None:
        cv = f"{rep.gap_cv:.2f}" if rep.gap_cv is not None else "-"
        lines.append(f"  Mesaj aralığı: medyan {rep.median_gap:.0f}sn, düzenlilik CV {cv}")
    lines.append(
        f"  Ses XP tick: {rep.voice_ticks} (~{rep.voice_ticks * VOICE_XP_INTERVAL_SECONDS / 3600:.1f} saat) | "
        f"mute %{rep.voice_muted_ratio * 100:.0f}"
    )
    if rep.top_peers:
        lines.append("  Seste en çok birlikte: " + ", ".join(f"{p} ({c})" for p, c in rep.top_peers))
    lines.append(f"  Aktif saat dilimi: {rep.hours_active}/24 | 7/24 aktif gün: {rep.sleepless_days}")
    for f in rep.flags:
        lines.append(f"  ⚠ [{f.code}] +{f.weight}: {f.detail}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli() -> None:
    from pathlib import Path
    import time

    default_db = Path(__file__).resolve().parent / "data" / "xp_system.db"
    parser = argparse.ArgumentParser(description="Bot-GAP hile/kasma analizi")
    parser.add_argument("--db", default=str(default_db))
    parser.add_argument("--guild", type=int, required=True)
    parser.add_argument("--user", type=int)
    parser.add_argument("--days", type=float, default=30)
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--legacy", action="store_true", help="Olay kaydı öncesi toplam verilerden tarama")
    args = parser.parse_args()

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    if args.legacy:
        users = con.execute("SELECT * FROM user_xp WHERE guild_id = ?", (args.guild,)).fetchall()
        pairs = con.execute("SELECT * FROM voice_pair_stats WHERE guild_id = ?", (args.guild,)).fetchall()
        for uid, flags in legacy_scan(users, pairs)[: args.top]:
            print(f"== {uid} — skor {sum(f.weight for f in flags)} ==")
            for f in flags:
                print(f"  ⚠ [{f.code}] +{f.weight}: {f.detail}")
        return

    since = time.time() - args.days * 86400
    placeholders = ",".join("?" * len(ANALYSIS_EVENTS))
    rows = con.execute(
        f"SELECT * FROM activity_log WHERE guild_id = ? AND ts >= ? AND event IN ({placeholders}) ORDER BY ts",
        (args.guild, since, *ANALYSIS_EVENTS),
    ).fetchall()

    if args.user:
        user_rows = [r for r in rows if r["user_id"] == args.user]
        print(format_report(analyze_user(args.user, user_rows, args.days, peer_message_counts(rows))))
        return

    reports = [r for r in analyze_guild(rows, args.days) if r.flags]
    if not reports:
        print("Şüpheli bulunamadı.")
    for rep in reports[: args.top]:
        print(format_report(rep))
        print()


if __name__ == "__main__":
    _cli()
