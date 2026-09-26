/**
 * Ядро OSINT: нормализация, уверенность, решение о тождестве,
 * противоречия, маскирование.
 *
 * Главные проверки здесь отрицательные. Система обязана предпочесть «не
 * удалось подтвердить» ложному объединению: тёзки остаются разными
 * людьми, одинаковый username у разных людей не склеивает их, десять
 * форумов не подтверждают факт, а противоречие не прячется.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyIdentifier,
  isValidInn,
  isValidOgrn,
  normalizeIdentifier,
} from "../dist/osint/identifiers.js";
import { MAX_QUERIES_PER_IDENTIFIER, personNameVariants, phoneVariants, searchQueries } from "../dist/osint/planning.js";
import { canonicalJson, quoteEvidence, structuredEvidence } from "../dist/osint/evidence.js";
import { claimConfidence, claimStatus } from "../dist/osint/confidence.js";
import { decideMatch } from "../dist/osint/resolver.js";
import { findContradictions } from "../dist/osint/contradictions.js";
import { maskIdentifier, pseudonymize } from "../dist/osint/masking.js";

const norm = (type: Parameters<typeof normalizeIdentifier>[0], raw: string) =>
  normalizeIdentifier(type, raw)?.normalized ?? null;

test("разные записи одного значения сводятся к одной форме", () => {
  assert.equal(norm("phone", "8 (912) 345-67-89"), "+79123456789");
  assert.equal(norm("phone", "+7 912 345 67 89"), "+79123456789");
  // Регистр приводится только у домена: локальную часть провайдер вправе различать.
  assert.equal(norm("email", "Ivan.Petrov@Example.COM"), "Ivan.Petrov@example.com");
  assert.equal(norm("email", "user@пример.рф"), "user@xn--e1afmkfd.xn--p1ai");
  assert.equal(norm("domain", "https://WWW.Example.com/about"), "example.com");
  assert.equal(norm("username", "@Torvalds"), "torvalds");
  assert.equal(norm("asn", "as 13335"), "AS13335");
  assert.equal(norm("ip", "2001:0DB8:0000::0001"), "2001:db8::1");
  assert.equal(norm("cidr", "10.1.2.3/8"), "10.0.0.0/8");
  assert.equal(norm("cidr", "2001:db8:ff::1/32"), "2001:db8::/32");
  assert.equal(norm("name", "  Пётр   «Иванов» "), "петр иванов");
  assert.equal(norm("url", "https://www.example.com/a/?utm_source=x"), "https://example.com/a");
});

test("нормализация не склеивает разные значения", () => {
  // Точки и +метки — у многих провайдеров разные ящики.
  assert.notEqual(norm("email", "i.petrov@example.com"), norm("email", "ipetrov@example.com"));
  assert.notEqual(norm("email", "ivan+work@example.com"), norm("email", "ivan@example.com"));
  assert.notEqual(norm("email", "User@example.com"), norm("email", "user@example.com"));
  // Мусор отвергается, а не проходит «как есть».
  for (const [type, raw] of [
    ["phone", "123"], ["email", "not-an-email"], ["domain", "localhost"], ["ip", "999.1.1.1"],
    ["asn", "AS0"], ["cidr", "10.0.0.0/33"], ["username", "a b"], ["tax_id", "ИНН 7707083894"],
  ] as const) {
    assert.equal(norm(type, raw), null, `${type}: ${raw}`);
  }
});

test("ИНН и ОГРН проверяются контрольной суммой", () => {
  assert.equal(isValidInn("7707083893"), true);
  assert.equal(isValidInn("7707083894"), false, "опечатка в одной цифре — другой номер");
  assert.equal(isValidInn("500100732259"), true);
  assert.equal(isValidOgrn("1027700132195"), true);
  assert.equal(isValidOgrn("1027700132196"), false);
  assert.equal(norm("tax_id", "ИНН 7707083893"), "7707083893");
  assert.equal(norm("registration_number", "ОГРН 1027700132195"), "1027700132195");
  // Российское правило — только в российском контексте.
  assert.equal(normalizeIdentifier("tax_id", "7707083894", { country: "RU" }), null);
  assert.equal(normalizeIdentifier("registration_number", "1027700132196", { country: "RU" }), null);
  // Без него десять цифр — возможный иностранный номер, а не ошибочный ИНН.
  assert.equal(norm("tax_id", "7707083894"), "7707083894");
  assert.equal(norm("registration_number", "1027700132196"), "1027700132196");
});

test("тип запроса не угадывается за человека: неоднозначное даёт варианты", () => {
  // Десять цифр с верной суммой ИНН — и ИНН, и возможный телефон.
  const types = classifyIdentifier("7707083893").map((item) => item.type);
  assert.ok(types.includes("tax_id") && types.includes("phone"), types.join(","));
  assert.deepEqual(classifyIdentifier("ivan@example.com").map((item) => item.type), ["email"]);
  assert.deepEqual(classifyIdentifier("https://github.com/torvalds").map((item) => item.type), ["social_account"]);
  // Статья на обычном сайте — адрес страницы, а не профиль.
  assert.deepEqual(classifyIdentifier("https://example.com/article").map((item) => item.type), ["url"]);
  assert.deepEqual(classifyIdentifier("https://github.com/torvalds/linux").map((item) => item.type), ["url"]);
  assert.deepEqual(classifyIdentifier("Петров Иван Сергеевич").map((item) => item.type), ["name"]);
  // «AS13335» бывает и username, но первым идёт более специфичный тип.
  assert.equal(classifyIdentifier("AS13335")[0]!.type, "asn");
});

test("варианты имени и телефона конечны и разумны", () => {
  assert.deepEqual(personNameVariants("петров иван сергеевич"), [
    "Петров Иван Сергеевич", "Иван Петров", "Петров Иван", "Петров И.С.", "Ivan Petrov",
  ]);
  // «Имя Отчество Фамилия» распознаётся по отчеству.
  assert.ok(personNameVariants("иван сергеевич петров").includes("Петров И.С."));
  assert.deepEqual(phoneVariants("+79123456789"), [
    "+79123456789", "+7 912 345 67 89", "8 (912) 345-67-89", "89123456789", "8-912-345-67-89", "912 345-67-89",
  ]);
  const queries = searchQueries(
    { type: "name", raw: "x", normalized: "петров иван сергеевич" },
    { city: "Пермь", organization: "Ромашка" },
  );
  assert.ok(queries.length <= MAX_QUERIES_PER_IDENTIFIER);
  assert.ok(queries.includes('"Петров Иван Сергеевич" Пермь'));
  // Уточнение идёт первым, открытые страницы соцсетей — с городом.
  assert.equal(queries[0], '"Петров Иван Сергеевич" "Ромашка"');
  assert.ok(queries.includes('"Иван Петров" Пермь site:vk.com'));
  assert.ok(queries.includes('"Иван Петров" Пермь site:ok.ru'));
  const phone = searchQueries({ type: "phone", raw: "x", normalized: "+79123456789" });
  assert.ok(phone.includes('"8-912-345-67-89"') && phone.includes('"89123456789" site:vk.com'));
  assert.ok(phone.length <= MAX_QUERIES_PER_IDENTIFIER);
});

test("доказательство: цитата обязана быть в источнике, отпечаток не зависит от порядка ключей", () => {
  assert.equal(quoteEvidence("родился в Перми", "Иван Петров родился в Москве."), null,
    "цитата, которой нет в тексте, — догадка, а не доказательство");
  assert.ok(quoteEvidence("родился в Москве", "Иван Петров родился в Москве."));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(structuredEvidence({ asn: 1, org: "x" }).hash, structuredEvidence({ org: "x", asn: 1 }).hash);
});

test("уверенность: первичный источник подтверждает, толпа слабых — нет", () => {
  const registry = [{ sourceTier: "official_registry" as const, sourceDomain: "egrul.nalog.ru" }];
  assert.equal(claimStatus(registry, false), "confirmed");
  // Десять форумов — не подтверждение.
  const forums = Array.from({ length: 10 }, (_, index) => ({
    sourceTier: "forum" as const, sourceDomain: `forum${index}.ru`,
  }));
  assert.equal(claimStatus(forums, false), "unverified");
  // Перепечатка на одном домене — одно свидетельство.
  const reprints = Array.from({ length: 5 }, () => ({
    sourceTier: "authoritative_media" as const, sourceDomain: "news.example",
  }));
  assert.equal(claimConfidence(reprints), claimConfidence(reprints.slice(0, 1)));
  // Два независимых авторитетных СМИ — вероятно, но не установлено.
  assert.equal(claimStatus([
    { sourceTier: "authoritative_media", sourceDomain: "a.example" },
    { sourceTier: "authoritative_media", sourceDomain: "b.example" },
  ], false), "probable");
  // Противоречие перекрывает любую уверенность.
  assert.equal(claimStatus(registry, true), "contradicted");
});

const features = (...kinds: Parameters<typeof decideMatch>[0][number]["kind"][]) =>
  kinds.map((kind) => ({ kind, evidenceIds: [`ev-${kind}`] }));

test("тёзки не объединяются: имя без связующего признака — не выше possible", () => {
  assert.equal(decideMatch(features("name_exact")).status, "rejected");
  const context = decideMatch(features("name_exact", "same_city", "same_employer", "same_position"));
  assert.equal(context.status, "possible");
});

test("одинаковый username у разных людей не склеивает их", () => {
  assert.equal(decideMatch(features("exact_username")).status, "rejected");
  assert.equal(decideMatch(features("exact_username", "name_exact")).status, "possible");
  // Тот же username в другой стране при разных биографиях — спор, а не тождество.
  assert.notEqual(
    decideMatch(features("exact_username", "name_exact", "different_country", "different_biography")).status,
    "confirmed",
  );
});

test("коллеги-тёзки с общим сайтом компании не становятся одним человеком", () => {
  const namesakes = decideMatch(features(
    "shared_website", "name_exact", "same_city", "same_employer", "same_position", "biography_overlap",
  ));
  assert.equal(namesakes.status, "possible", `счёт ${namesakes.score}`);
  assert.equal(decideMatch(features("exact_username", "shared_website", "name_exact", "same_city")).status, "possible");
});

test("подтверждение требует независимых сильных признаков", () => {
  assert.equal(decideMatch(features("shared_email")).status, "probable");
  assert.equal(decideMatch(features("shared_email", "shared_phone", "name_exact")).status, "confirmed");
  // Профили ссылаются друг на друга — сильнейший признак владельца.
  assert.equal(decideMatch(features("profile_link_bidirectional", "exact_username")).status, "confirmed");
  assert.equal(decideMatch(features("same_tax_id")).status, "confirmed");
});

test("жёсткое противоречие не перевешивается совпадениями", () => {
  assert.equal(decideMatch(features("name_exact", "different_birth_date")).status, "rejected");
  // Есть сильное «за» и жёсткое «против» — человек видит обе стороны.
  assert.equal(decideMatch(features("shared_email", "shared_phone", "different_birth_date")).status, "conflicting");
  assert.equal(decideMatch(features("same_tax_id", "different_birth_date")).status, "conflicting");
});

test("признак без доказательства в решение не входит", () => {
  const decision = decideMatch([{ kind: "same_tax_id", evidenceIds: [] }]);
  assert.equal(decision.status, "rejected");
  assert.deepEqual(decision.features, []);
  // Ответ «почему» — это признаки с доказательствами.
  const explained = decideMatch(features("shared_email", "shared_phone"));
  assert.deepEqual(explained.features.map((item) => item.evidenceIds), [["ev-shared_email"], ["ev-shared_phone"]]);
});

test("противоречия сохраняются, уточнение даты противоречием не считается", () => {
  const claims = [
    { entityId: "p1", property: "birthPlace", value: "Пермь", sourceId: "s1" },
    { entityId: "p1", property: "birthPlace", value: "Москва", sourceId: "s2" },
    { entityId: "p1", property: "birthDate", value: "1990", sourceId: "s1" },
    { entityId: "p1", property: "birthDate", value: "1990-05-01", sourceId: "s3" },
    // Много адресов почты — не спор.
    { entityId: "p1", property: "email", value: "a@example.com", sourceId: "s1" },
    { entityId: "p1", property: "email", value: "b@example.com", sourceId: "s2" },
  ];
  const found = findContradictions(claims);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.property, "birthPlace");
  assert.deepEqual(found[0]!.values.map((item) => item.value).sort(), ["москва", "пермь"]);
  assert.equal(findContradictions([
    { entityId: "p1", property: "birthDate", value: "1990-05-01", sourceId: "s1" },
    { entityId: "p1", property: "birthDate", value: "1991-05-01", sourceId: "s2" },
  ]).length, 1);
});

test("в журнал идёт маска и псевдоним, а не значение", () => {
  const email = "ivan.petrov@example.com";
  const masked = maskIdentifier("email", email);
  assert.equal(masked, "i***@e***.com");
  assert.ok(!masked.includes("petrov"));
  // Длина значения по маске не угадывается.
  assert.equal(maskIdentifier("username", "ab12").length, maskIdentifier("username", "abcdefgh1234").length);
  assert.equal(maskIdentifier("phone", "+79123456789"), "+7***89");
  const alias = pseudonymize("secret", "email", email);
  assert.equal(alias, pseudonymize("secret", "email", email));
  assert.notEqual(alias, pseudonymize("other-secret", "email", email));
  assert.ok(!alias.includes("ivan"));
  assert.throws(() => pseudonymize("", "email", email), /osint_pseudonym_secret_missing/);
});
