# Eva WebApp — retention-oriented v17

Главный экран строится вокруг одного core loop:

`Trigger → Action → Variable Reward → Investment`

## Что реализовано во frontend

- Dynamic trigger bar по weekly close-to-finish, inactivity/reactivation, reward, milestone и time-of-day ritual.
- Единственный primary CTA в hero.
- First-value onboarding из 2 шагов для нового пользователя: выбор текущей потребности → первый персональный фокус на 2 минуты.
- Variable reward: маленькая победа, инсайт, наблюдение, вопрос дня, сильная сторона, curiosity pattern, вечерний итог, weekly snapshot и milestone reward.
- Post-reward investment: сохранить инсайт, отметить эмоцию, добавить мысль, продолжить профиль.
- Meaningful streak: простое открытие приложения не засчитывается.
- Daily minimum: 1 meaningful action.
- Weekly goal: 5 meaningful steps.
- Milestones 3 / 7 / 14 / 30 дней.
- Earned streak shield после 7 дней и мягкий recovery flow.
- Perfect week без пропуска/защиты.
- Profile-as-asset: пояснение, почему накопленный контекст повышает полезность Евы.
- Reactivation state: 24h / 48h / 72h / 7d.
- Soft accountability через ежедневное намерение для себя.
- Shareable milestone через Web Share API с fallback в clipboard.

## Activation

Activation считается только после полного цикла:

1. core action completed;
2. reward viewed;
3. investment completed.

Событие: `activation_completed`.

Time to first value измеряется событием `first_value_ready`.

## Analytics

Frontend содержит встроенную событийную схему `eva-retention-v1` и локальную очередь до 250 событий. Если backend передаёт `analytics_endpoint` в session response или задаёт `window.EVA_ANALYTICS_ENDPOINT`, очередь может отправляться туда автоматически.

Также поддержан внешний адаптер:

```js
window.EvaAnalytics = {
  track(name, properties) {}
}
```

И browser event:

```js
window.addEventListener("eva:retention", (event) => {
  console.log(event.detail);
});
```

Доступ к диагностике:

```js
window.EvaRetention.metrics()
window.EvaRetention.activation()
window.EvaRetention.reactivation()
window.EvaRetention.streak()
window.EvaRetention.performance()
```

## Backend / CRM required

WebApp не должен сам рассылать Telegram/push-уведомления. Backend/CRM/outbox должен:

- хранить канонический meaningful streak;
- хранить/списывать streak shield;
- строить cohort metrics D1 / D3 / D7 / D30;
- выполнять reactivation 24h / 48h / 72h / 7d;
- соблюдать cadence 1–3 персонализированных уведомления в неделю;
- принимать retention events;
- вычислять production API p95 и crash-free sessions.

Машиночитаемый контракт находится в `webapp/retention-contract.json`.

## Performance targets

Цели:
- crash-free sessions ≥ 99.95%;
- cold start < 2s;
- API p95 < 500ms.

Frontend измеряет cold-start, клиентские ошибки и API latency. Выполнение production SLO должно подтверждаться серверной телеметрией, а не локальным smoke-test.
