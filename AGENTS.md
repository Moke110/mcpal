## Agent skills

### Issue tracker

Read [the issue tracker guide](docs/agents/issue-tracker.md) before reading or updating GitHub issues for Moke110/mcpal.

### Triage labels

Read [the triage label mapping](docs/agents/triage-labels.md) when assigning or interpreting triage labels.

### Domain docs

Read [the single-context domain docs guide](docs/agents/domain.md) before exploring the codebase with an engineering skill.

## Temporary files

Keep task-generated temporary files under the repository's `tmp/` directory. This includes downloads, model weights, tool caches, extracted runtimes, logs, and prototype artifacts. Configure child processes to use repo-local output and cache paths, including `TEMP` and `TMP` when applicable. Apply this rule to subagents and tools to keep task-generated temporary files off the system drive.
