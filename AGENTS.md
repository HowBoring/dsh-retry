# AGENTS.md

DeepSeek Harness plugin for a manual `/retry` (task continuation) experience. The design
specification and implementation brief live in [`dev-pack/`](dev-pack/README.md); treat that
directory as the source of truth for behaviour.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `HowBoring/dsh-retry`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map 1:1 to `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
