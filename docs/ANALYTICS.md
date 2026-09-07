# Phase 19 — Analytics & Insights

Analytics are computed deterministically from real ExtensionLab records.

Sources:
- analysis_snapshots
- test_runs
- packages / extensions
- browser_matrix_runs
- regressions
- usage
- public_activity / notifications / community

No fake metrics. Zero means zero. No data means insufficient evidence.

## Metrics

- Health score: from analysis_snapshots (current vs previous when both exist)
- Pass rate: completed successful tests / eligible completed tests
- CI success: CI executions with success / total CI executions
- Regression count: real regression records
- Average duration: mean of non-zero durations; not shown if insufficient samples
- Browser compatibility: successful supported executions / eligible executions

## Insights

Insights reference real metric changes. AI may optionally explain, but AI never becomes the source of truth.

## Authorization

- Existing API-key scopes enforced
- Organization isolation enforced
- Extension access verified server-side
- Public analytics only show explicitly public data

## Empty States

- No data available yet.
- Not enough data to calculate this metric.
- Zero when genuinely zero.

## Performance

Bounded queries. No unbounded aggregation over full history without filtering.
