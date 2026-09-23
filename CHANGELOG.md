# Changelog

## 0.1.0 (2026-09-23)

- Initial release: YouTube comments and replies through the official YouTube Data API v3 from video, Shorts, live and channel URLs (@handle or channel ID).
- Top-comments or newest-first order, date cutoff with early stop, keyword filter (YouTube comment search), max comments per video.
- Author data modes: include, pseudonymise (stable per-user hash) or omit; isByVideoOwner flag in every mode.
- Free failure records for invalid URLs, missing or private videos, disabled comments, quota and key errors; the run stops cleanly when the key quota is used up.
- Built-in shared API key with optional own key (`apiKey` input, falls back to the `YOUTUBE_API_KEY` environment variable).
