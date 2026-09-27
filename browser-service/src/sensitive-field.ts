/**
 * Поле, в которое браузер Евы ничего не вводит и значение которого не
 * показывает модели: пароль, одноразовый код, данные карты.
 *
 * Тип и `autocomplete` сайт указывать не обязан: код из СМС часто —
 * обычное `<input type="text" name="otp">`, номер карты —
 * `name="cardNumber"`. Введённое в такое поле обработчик страницы
 * отправит сразу, разрешённым GET или WebSocket, и запрет POST этого не
 * остановит. Поэтому поле опознаётся и по смыслу: name, id, placeholder,
 * aria-label, title, подписи `<label>` и `aria-labelledby`. Ошибка в
 * сторону «опасно» стоит одного отказа ввести текст, в обратную —
 * секрета человека.
 *
 * Функция выполняется в странице (`locator.evaluate`) и потому
 * самодостаточна: ни одной ссылки на область модуля.
 */
export function isSensitiveField(element: Element): boolean {
  const input = element as HTMLInputElement;
  const type = String(input.type ?? "").toLowerCase();
  if (type === "password" || type === "file") return true;
  const autocomplete = String(element.getAttribute("autocomplete") ?? "").toLowerCase();
  if (/(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/.test(autocomplete)) return true;

  const hints: string[] = [];
  for (const attribute of ["name", "id", "placeholder", "aria-label", "title", "data-testid"]) {
    const value = element.getAttribute(attribute);
    if (value) hints.push(value);
  }
  for (const label of Array.from(input.labels ?? [])) hints.push(label.textContent ?? "");
  for (const id of (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
    hints.push(element.ownerDocument.getElementById(id)?.textContent ?? "");
  }
  // cardNumber → card number, cc_exp → cc exp: слова разделяются так, как
  // их разделил бы человек, и граница слова работает на любом стиле имени.
  const text = hints.join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-.:[\]()]+/g, " ");
  const english = /\b(pass ?(word|wd|code|phrase)?|pwd|pin( ?code)?|otp|totp|hotp|2fa|mfa|one ?time|verification ?code|security ?code|auth(entication)? ?code|sms ?code|confirmation ?code|cvv2?|cvc2?|cvn|csc|card ?(number|no|num)|credit ?card|cc ?(num|number|no|exp|csc|cvv)|ccnum|exp(iry|iration)? ?(date|month|year)|iban|secret)\b/;
  const russian = /(парол|пин[- ]?код|код подтвержд|код из (смс|sms)|(смс|sms)[- ]?код|одноразов|номер (банковской )?карты|срок действия|код безопасности|секретн)/;
  return english.test(text) || russian.test(text);
}
