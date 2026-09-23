# Decisions

Updated: 2026-09-23T23:45:47+08:00

| ID | Decision | Reason |
|---|---|---|
| D-001 | Keep per-session activity and a separate process-wide idle probe. | Session state has an owner; endpoint reachability does not. One probe interval should not multiply with open conversations. |
| D-002 | Describe probes as HTTP endpoint reachability. | A response from `/models`, including 401 or 404, does not prove that a model request will work. |
| D-003 | Keep the phase timeline and activity shares; omit an upload/download throughput chart. | Available events and the fetch patch cannot reliably attribute byte counts to each concurrent session. A throughput label would imply precision the monitor does not have. |
| D-004 | Show reasoning excerpts only when supplied by OpenCode. | The event stream does not identify which queued user message the excerpt concerns. |
| D-005 | Keep machine-specific handoff material and real-session screenshots outside tracked files. | Public documentation can explain installation with relative paths and synthetic examples. |
| D-006 | Run tests against temporary status files. | Tests must not modify the user's live monitor history. |
