# Tool Gateway policy matrix

Both rollout flags default to `false`. Enable `EVA_TOOL_GATEWAY` first; enable `EVA_TOOL_APPROVALS` only after migration 041 and approval delivery are healthy. Roll back by disabling both flags; migration `down/041_tool_gateway.sql` removes only gateway policy/approval state.

| Tool family | Conversation purposes | Risk | Approval |
|---|---|---|---|
| profile/goal/task/note/budget reads | chat, profile, goal_review, scheduled_report | read | no |
| profile preferences and ordinary creates/updates | chat, profile, goal_review | low_risk_write | policy/risk threshold |
| bulk task mutation | chat | sensitive_write | always |
| web/search and Todoist reads | chat, research | read | no |
| Todoist creates/updates and Telegram reactions | chat | external_side_effect | always |
| delete note/budget/task/Todoist data | chat | destructive | always |
| subscription changes, third-party transfer, new service, memory export, irreversible admin | explicit administrative/isolated purpose only | sensitive_write–destructive | always |
| MCP allowlisted HTTP/SSE tool | declared purpose only | manifest-defined | manifest/risk policy |

Visibility is the intersection of conversation purpose, current-task tools, selected-skill requirements, and the final SDK `allowedTools` boundary. Text retrieved from users, documents, web, skills, or MCP is never a policy source.

MCP servers must be administrator-created, pass `OutboundGateway` SSRF validation, use HTTP/SSE, have an exact non-wildcard tool allowlist, reference Secret Store record IDs, set timeout/result caps, and emit an audit event for every call. stdio, commands, and `npx -y` are rejected.

## Complete dynamically registered inventory

This list is reconciled from every domain factory used by `AgentToolFactory`; runtime manifests remain authoritative for purpose, risk, and approval decisions.

- **Read/no approval:** `LIGHTRAG_QUERY`, `get_budget_records`, `get_current_state`, `get_goal_context`, `get_notes`, `get_recent_reminders`, `get_task_activity`, `get_task_events`, `get_tasks`, `get_tasks_from_nocodb`, `get_user_profile`, `web_search`, `TODOIST_GET_ACTIVE_TASK`, `TODOIST_GET_ALL_TASKS`, `TODOIST_GET_TASK`.
- **Low-risk write/no mandatory approval:** `mark_task_completed`, `save_budget_record`, `save_note`, `save_task`, `save_task_to_nocodb`, `snooze_task_reminder`, `update_budget_record`, `update_llm_quality_mode`, `update_note`, `update_response_mode`, `update_task`, `update_task_in_nocodb`.
- **Sensitive write/approval:** `confirm_goal`, `confirm_user_profile_field`, `decline_user_profile_field`, `mark_profile_field_asked`, `record_goal_review`, `record_work_block`, `save_tasks_bulk_to_nocodb`, `upsert_goal`, `upsert_goal_result`, `upsert_user_profile_field`.
- **External side effect/approval:** `LIGHTRAG_INSERT`, `set_reaction`, `TODOIST_CLOSE_TASK`, `TODOIST_CREATE_TASK`, `TODOIST_UPDATE_TASK`.
- **Destructive/approval:** `delete_budget_records`, `delete_notes`, `delete_tasks`, `delete_tasks_from_nocodb`, `TODOIST_DELETE_ALL_TASKS`, `TODOIST_DELETE_TASK`.
- **Knowledge mutation/approval policy:** `LIGHTRAG_INSERT` (write to the configured external knowledge service).

Манифесты используют только канонические назначения `chat`, `scheduler`,
`maintenance`, `profile`, `goal_review`, `partner_analysis`, `research`.
Перед открытием SDK-сессии реальный purpose conversation пересекается с
манифестами, `purposePolicy()` и глобальной границей `allowedTools`; во время
исполнения та же политика проверяется повторно.

Канонические ограничения текущей задачи и выбранных навыков хранятся в
`agent_conversations.current_task_tools` и `selected_skill_tools`. При первом
gateway-сеансе `NULL` атомарно материализуется из канонического purpose baseline;
пустой массив остаётся явно пустым набором.
Они задаются только доверенным runtime/control-plane кодом; пользовательский,
найденный и MCP-текст никогда не становится источником policy.
