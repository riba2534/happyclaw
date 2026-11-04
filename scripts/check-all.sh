#!/usr/bin/env bash
# The merge gate, run locally (`make check`). Every check the former GitHub
# Actions CI ran, in the same order, plus the copies of every shared file and
# `git diff --check`. Stops at the first failure and prints per-step times.
#
# Environment:
#   PLAYWRIGHT_PORT   port for the Web e2e dev server (parallel worktrees)
#   CHECK_SKIP_E2E=1  skip the browser e2e step (say so in the PR)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

results=()
run_step() {
  local name="$1"
  shift
  local start=$SECONDS
  echo "▶ $name"
  if "$@"; then
    results+=("✓ $(printf '%4ds' $((SECONDS - start)))  $name")
  else
    results+=("✗ $(printf '%4ds' $((SECONDS - start)))  $name")
    printf '%s\n' "${results[@]}"
    echo "✗ $name failed" >&2
    exit 1
  fi
}

run_step "Changed-file formatting" npm run -s format:check
run_step "Production dependency audit" npm run -s audit:prod
# Checked before typecheck, which runs sync-types first and would hide drift.
run_step "Shared file copies are in sync" ./scripts/check-stream-event-sync.sh
run_step "Typecheck (incl. prompts and docs)" make --no-print-directory typecheck
# A failed test runs once more (the former CI retried e2e the same way):
# timing-sensitive tests can lose a race under a full parallel run, while a
# real regression fails both times.
run_step "Unit tests" npm test -- --run --retry=1
run_step "Build" npm run -s build:all
run_step "Provider failure upstream smoke" node tests/e2e/provider-failure-upstream.mjs fast
run_step "Codex gateway real SDK tool-loop smoke" node tests/e2e/codex-gateway-sdk.mjs
run_step "Process visibility full-stack smoke" node tests/e2e/process-visibility-stack.mjs
run_step "Per-turn context notes full-stack smoke" node tests/e2e/turn-context-dedup.mjs
if [ "${CHECK_SKIP_E2E:-}" = 1 ]; then
  results+=("-    skipped  Web browser e2e (CHECK_SKIP_E2E=1)")
else
  run_step "Web browser e2e (phone + desktop)" npm --prefix web run -s test:e2e -- --retries=1
fi
run_step "Agent runner self-test" npm run -s self-test:agent-runner
run_step "Whitespace" git diff --check "$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD)"

echo
printf '%s\n' "${results[@]}"
echo "All checks passed."
