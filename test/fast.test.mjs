import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFast, FAST } from "../bot/fast.mjs";

const bar = (c, v = 1000, i = 0) => ({ ts: i * 6e4, open: c, high: c + 0.02, low: c - 0.02, close: c, volume: v });
const noise = (n, base = 100) => Array.from({ length: n }, (_, i) => base + (i % 2 ? 0.02 : -0.02));

test("ani yükseliş: hacimli patlama + zirve kırılımı → CALL, stop altta, hedef 2R", () => {
  const cl = [...noise(40), 100.15, 100.3, 100.45, 100.6, 100.75];
  const bars = cl.map((c, i) => bar(c, i >= 40 ? 3000 : 1000, i));
  const s = detectFast(bars, null, true);
  assert.equal(s?.kind, "burst"); assert.equal(s.dir, "C");
  assert.ok(s.stop < s.S && s.target > s.S);
  assert.ok(Math.abs((s.target - s.S) - 2 * (s.S - s.stop)) < 0.02);
});

test("ani düşüş: hacimli çöküş + dip kırılımı → PUT", () => {
  const cl = [...noise(40), 99.85, 99.7, 99.55, 99.4, 99.25];
  const s = detectFast(cl.map((c, i) => bar(c, i >= 40 ? 3000 : 1000, i)), null, true);
  assert.equal(s?.kind, "burst"); assert.equal(s.dir, "P");
  assert.ok(s.stop > s.S && s.target < s.S);
});

test("hacimsiz patlama alarm vermez (sahte hareket)", () => {
  const cl = [...noise(40), 100.15, 100.3, 100.45, 100.6, 100.75];
  const s = detectFast(cl.map((c, i) => bar(c, 1000, i)), null, true);
  assert.ok(!s || s.kind !== "burst");
});

test("V-tepe (saf dönüş, açıkken): koşu → zirve → sert ters dönüş → PUT", () => {
  FAST.REV_ON = true;
  const up = Array.from({ length: 30 }, (_, i) => 100 + i * 0.0345 + (i % 2 ? 0.01 : -0.01));
  const cl = [...up, 101.05, 100.9, 100.75, 100.6, 100.5, 100.4];
  const s = detectFast(cl.map((c, i) => bar(c, 1000, i)), null, true);
  assert.equal(s?.kind, "reversal"); assert.equal(s.dir, "P");
  assert.ok(s.stop > 101.05);
});

test("V-dip (saf dönüş, açıkken): düşüş → dip → sert dönüş → CALL", () => {
  FAST.REV_ON = true;
  const dn = Array.from({ length: 30 }, (_, i) => 100 - i * 0.0345 + (i % 2 ? 0.01 : -0.01));
  const cl = [...dn, 98.95, 99.1, 99.25, 99.4, 99.5, 99.6];
  const s = detectFast(cl.map((c, i) => bar(c, 1000, i)), null, true);
  assert.equal(s?.kind, "reversal"); assert.equal(s.dir, "C");
  assert.ok(s.stop < 98.95);
});

test("sakin piyasa ve yetersiz veri → alarm yok", () => {
  assert.equal(detectFast(noise(60).map((c, i) => bar(c, 1000, i)), null, true), null);
  assert.equal(detectFast(noise(10).map((c, i) => bar(c, 1000, i)), null, true), null);
  assert.equal(detectFast([], null, true), null);
});

test("hisse eşiği ETF'ten yüksek: %0.75'lik patlama hissede alarm değil", () => {
  const cl = [...noise(40), 100.15, 100.3, 100.45, 100.6, 100.75];
  const s = detectFast(cl.map((c, i) => bar(c, i >= 40 ? 3000 : 1000, i)), null, false);
  assert.ok(!s || s.kind !== "burst");
});

test("saf dönüş varsayılan kapalı; zirveden sonra hacimli ters patlama = ANİ DÖNÜŞ (turn)", () => {
  FAST.REV_ON = false;
  const up = Array.from({ length: 30 }, (_, i) => 100 + i * 0.0345 + (i % 2 ? 0.01 : -0.01));
  const pure = [...up, 101.05, 100.9, 100.75, 100.6, 100.5, 100.4];
  assert.equal(detectFast(pure.map((c, i) => bar(c, 1000, i)), null, true), null);
  const cl = [...up, 101.05, 101.0, 100.98, 101.0, 100.97, 100.99, 100.8, 100.6, 100.4, 100.2, 100.0];
  const s = detectFast(cl.map((c, i) => bar(c, i >= cl.length - 5 ? 4000 : 1000, i)), null, true);
  assert.equal(s?.kind, "turn"); assert.equal(s.dir, "P");
});
