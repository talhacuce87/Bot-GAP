import { afterEach, beforeEach, expect, it } from "vitest";
import { beginMode, listen, stopMode } from "../client/src/mode";

const target = new EventTarget();
const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  g.addEventListener = target.addEventListener.bind(target);
});
afterEach(() => {
  stopMode();
  delete g.addEventListener;
});

it("mod durunca mod dinleyicileri kalkar, çıplak dinleyiciler kalır", () => {
  let moded = 0, bare = 0;
  beginMode();
  listen("keydown", () => moded++);
  target.addEventListener("keydown", () => bare++);
  target.dispatchEvent(new Event("keydown"));
  expect([moded, bare]).toEqual([1, 1]);
  stopMode();
  target.dispatchEvent(new Event("keydown"));
  expect([moded, bare]).toEqual([1, 2]);
});

it("yeni mod eski modun dinleyicilerini taşımaz", () => {
  let a = 0, b = 0;
  beginMode();
  listen("resize", () => a++, true);
  stopMode();
  beginMode();
  listen("resize", () => b++);
  target.dispatchEvent(new Event("resize"));
  expect([a, b]).toEqual([0, 1]);
});
