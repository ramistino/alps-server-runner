# ALPS Recovery Patch v1 — Patch Notes

## Fixed
- Health no longer says only `RUNNING` when paper-forward is stale.
- Adds explicit `STALE_FORWARD` status when `lastForwardRefresh` is older than `ALPS_FORWARD_STALE_MS`.
- Adds persistent recovery snapshots.
- Adds previous ledger seed from the last known non-zero report.
- Adds recovery endpoints and report markdown section.

## Not changed
- Strategy engine.
- AHI/ARI decision logic.
- Paper-only mode.
- No real execution controls.
