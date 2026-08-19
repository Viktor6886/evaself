# Retention implementation status — v17

| Area | Status | Owner |
|---|---|---|
| Dynamic trigger | Implemented | Frontend |
| Single core action | Implemented | Frontend |
| 2-step first-value onboarding | Implemented | Frontend |
| Activation state machine | Implemented | Frontend instrumentation |
| Reward rotation 5+ | Implemented | Frontend |
| Post-reward investment | Implemented | Frontend |
| Meaningful streak rules | Implemented locally + contract | Frontend + Backend |
| 3/7/14/30 milestones | Implemented | Frontend |
| Earned streak shield | Frontend fallback + contract | Backend should be source of truth |
| 24/48/72h/7d reactivation messages | Implemented as lifecycle logic | CRM/outbox required for sending |
| Personalized notification candidates | Implemented | CRM/outbox required for sending |
| Push cadence 1–3/week | Policy implemented | CRM/outbox enforcement required |
| D1/D3/D7/D30 cohorts | Event schema ready | Analytics backend required |
| Reward CTR | impression/view events ready | Analytics backend required |
| Investment completion rate | events ready | Analytics backend required |
| Reactivation recovery rate | events ready | Analytics backend required |
| Cold-start telemetry | Implemented | Frontend |
| API latency samples | Implemented | Frontend + server observability |
| Crash-free SLO | Client error events ready | Production observability required |

No XP economy, coins, leaderboard or anxiety-based loss messaging was added.
