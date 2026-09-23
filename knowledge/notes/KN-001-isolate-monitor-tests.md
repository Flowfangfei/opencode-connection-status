# KN-001 — Isolate monitor tests from live status data

Type: method

Status: verified on 2026-09-23T23:55:00+08:00

The monitor writes to a user cache file by default. Tests must set `OPENCODE_CONN_STATUS_FILE` to a path inside a temporary directory before importing `connection-status.ts`. The earlier suite removed the live file while resetting its fixture and contaminated the viewer with test sessions. The revised suite uses a temporary SDK shim and status file. Its 25 monitor checks passed without touching the installed status path.

Provenance: [audit session](../../docs/ai-collaboration/sessions/2026-09-23-audit.md), [test harness](../../tests/plugin.test.mjs).
