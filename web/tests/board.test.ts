import { describe, expect, it } from "vitest";
import { BOARD_SIZE, Boards, sanitizeEntries } from "../server/src/board";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `u${id}`, avatar: null, level: 3, xp: 120, ...extra });

describe("leaderboard", () => {
  it("drops malformed rows and clamps values", () => {
    const rows = sanitizeEntries([
      entry("123456789"),
      { id: "../etc", name: "x" },
      null,
      entry("223456789", { avatar: "not-a-hash", level: -4, xp: "9.7", name: "\u0007  " }),
      entry("323456789", { avatar: "a_" + "f".repeat(32) }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["123456789", "223456789", "323456789"]);
    expect(rows[1]).toMatchObject({ avatar: null, level: 0, xp: 9, name: "Üye 6789" });
    expect(rows[2].avatar).toBe("a_" + "f".repeat(32));
  });

  it("keeps at most the top 10", () => {
    const many = Array.from({ length: 15 }, (_, i) => entry(String(100000 + i)));
    expect(sanitizeEntries(many)).toHaveLength(BOARD_SIZE);
  });

  it("serves the player's guild board, or the first one for guests", () => {
    const b = new Boards();
    b.replace({ "111111": [entry("123456")], "222222": [entry("654321")], bad: [entry("1")] }, 5);
    expect(b.for("222222")?.entries[0].id).toBe("654321");
    expect(b.for("222222")?.updated).toBe(5);
    expect(b.for(null)?.entries[0].id).toBe("123456");
    expect(b.for("999999")).toBeNull();
  });
});
