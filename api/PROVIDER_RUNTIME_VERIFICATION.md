# Provider runtime verification

PR #113 changes the AI provider transport boundary, so the exact PR head must boot in Render before merge.

Runtime lane:
- wait for `/health` to report the exact PR head SHA;
- POST a neutral symptom to the real `/api/translate` route so execution traverses `aiClient -> providerRouter -> configured live provider`;
- require HTTP 200 with a non-empty translated result and retrieval keywords;
- inspect exact-preview application logs to confirm the live provider adapter executed and that Gemini request logging reports the configured timeout ceiling;
- keep retryable timeout/high-demand failover deterministic in provider regression tests rather than forcing a live provider outage.

The Gemini adapter default request ceiling is 30 seconds (`GEMINI_REQUEST_TIMEOUT_MS` may override it). A retryable Gemini 408/429/5xx/UNAVAILABLE/high-demand failure may fall back once to Groq when configured. A retryable Groq failure may still fall back once to Gemini. There is no provider bounce loop.

The dedicated `SKSK Provider Runtime Gate` workflow owns the repeatable HTTP smoke. This file intentionally remains an `api/`-visible change on the final PR head so Render provisions that exact commit before the workflow calls it.
