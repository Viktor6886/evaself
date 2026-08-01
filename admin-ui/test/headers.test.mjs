/**
 * Заголовки безопасности панели.
 *
 * Это не придирка к конфигу: заголовок решает судьбу возможности
 * раньше, чем пользователь успеет что-нибудь разрешить. Кнопка
 * «Записать голос» не работала именно поэтому — Permissions-Policy
 * содержал `microphone=()`, то есть запрет для всех, включая саму
 * панель, и getUserMedia отвечал NotAllowedError, не спрашивая
 * человека. Проверено на живом Chromium: с `microphone=()` доступ
 * запрещён даже при выданном разрешении, с `microphone=(self)` —
 * разрешён.
 *
 * Ослабления проверяются поимённо: заголовок легко «починить»
 * снятием всей политики, и такой откат должен упереться в красный тест.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_CADDYFILE = fs.readFileSync(path.join(HERE, "..", "Caddyfile"), "utf8");
const EDGE_CADDYFILE = fs.readFileSync(
  path.join(HERE, "..", "..", "Caddyfile"), "utf8");

/** Значение заголовка из Caddyfile по имени. */
function header(source, name) {
  const match = new RegExp(`^\\s*${name}\\s+"([^"]*)"`, "m").exec(source);
  return match?.[1] ?? null;
}

describe("заголовки безопасности панели", () => {
  test("микрофон разрешён самой панели и никому больше", () => {
    const policy = header(ADMIN_CADDYFILE, "Permissions-Policy");
    assert.ok(policy, "Permissions-Policy должен быть задан");
    // (self) — панели можно; () означало бы запрет включая себя.
    assert.match(policy, /microphone=\(self\)/);
    // Камера и геолокация панели не нужны и остаются запрещёнными.
    assert.match(policy, /camera=\(\)/);
    assert.match(policy, /geolocation=\(\)/);
  });

  test("прослушивание записи разрешено в CSP на обоих уровнях", () => {
    // blob: нужен для <audio src=URL.createObjectURL(запись)>. Заголовок
    // с границы перекрывает вложенный — у Caddy header задаёт значение,
    // а не дополняет, — поэтому послабление обязано быть в обоих.
    for (const [name, source] of [
      ["admin-ui/Caddyfile", ADMIN_CADDYFILE],
      ["Caddyfile", EDGE_CADDYFILE],
    ]) {
      const csp = header(source, "Content-Security-Policy");
      assert.ok(csp, `${name}: CSP должен быть задан`);
      assert.match(csp, /media-src [^;]*blob:/, `${name}: без media-src blob: запись не слышно`);
    }
  });

  test("послабления не расползлись на остальные источники", () => {
    for (const [name, source] of [
      ["admin-ui/Caddyfile", ADMIN_CADDYFILE],
      ["Caddyfile", EDGE_CADDYFILE],
    ]) {
      const csp = header(source, "Content-Security-Policy");
      // blob: и data: — только там, где они нужны. В script-src их быть
      // не должно ни при каких обстоятельствах.
      const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
      assert.ok(!script.includes("blob:"), `${name}: blob: в script-src`);
      assert.ok(!script.includes("unsafe-eval"), `${name}: unsafe-eval в script-src`);
      assert.match(csp, /object-src 'none'/, `${name}: object-src должен быть none`);
      assert.match(csp, /base-uri 'none'/, `${name}: base-uri должен быть none`);
    }
  });

  test("панель не встраивается в чужие страницы", () => {
    assert.match(header(ADMIN_CADDYFILE, "X-Frame-Options") ?? "", /DENY/);
    assert.match(
      header(ADMIN_CADDYFILE, "Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  });
});
