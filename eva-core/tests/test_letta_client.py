from app.letta_client import extract_text, summarize_response
from app.main import _model_handle


def test_extract_text_handles_plain_strings():
    assert extract_text("hello") == "hello"


def test_extract_text_handles_content_parts():
    content = [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}]
    assert extract_text(content) == "first\nsecond"


def test_extract_text_ignores_non_text_parts():
    content = [{"type": "image", "url": "x"}, {"type": "text", "text": "kept"}]
    assert extract_text(content) == "kept"


def test_extract_text_of_none_is_empty():
    assert extract_text(None) == ""


def test_summarize_response_picks_the_assistant_message():
    response = {
        "messages": [
            {"message_type": "reasoning_message", "reasoning": "thinking about it"},
            {"message_type": "tool_call_message", "tool_call": {"name": "core_memory_append"}},
            {"message_type": "tool_return_message", "tool_return": "ok"},
            {"message_type": "assistant_message", "content": "Привет! Как ты сегодня?"},
        ],
        "stop_reason": {"stop_reason": "end_turn"},
        "usage": {"completion_tokens": 12, "prompt_tokens": 300, "total_tokens": 312, "step_count": 2},
    }
    summary = summarize_response(response)
    assert summary["reply"] == "Привет! Как ты сегодня?"
    assert summary["reasoning"] == ["thinking about it"]
    assert summary["tool_calls"] == ["core_memory_append"]
    assert summary["stop_reason"] == "end_turn"
    assert summary["usage"]["total_tokens"] == 312
    assert summary["message_count"] == 4


def test_summarize_response_joins_multiple_assistant_messages():
    response = {
        "messages": [
            {"message_type": "assistant_message", "content": "one"},
            {"message_type": "assistant_message", "content": [{"type": "text", "text": "two"}]},
        ],
        "stop_reason": {"stop_reason": "end_turn"},
        "usage": {},
    }
    assert summarize_response(response)["reply"] == "one\n\ntwo"


def test_summarize_empty_response_is_safe():
    summary = summarize_response({})
    assert summary["reply"] == ""
    assert summary["message_count"] == 0


def test_model_handle_qualifies_bare_model_names():
    assert _model_handle("mimo-v2.5-pro") == "eva-llm/mimo-v2.5-pro"


def test_model_handle_keeps_explicit_provider():
    assert _model_handle("openai/gpt-4o-mini") == "openai/gpt-4o-mini"


def test_model_handle_of_empty_is_none():
    assert _model_handle("") is None
