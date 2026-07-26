#!/usr/bin/env bash
# Verify that all prompt files referenced from agent-runner source code actually exist.
#
# Background: agent-runner loads `.md` prompt files at module-load time (readFileSync).
# If src references a file that no longer exists in container/agent-runner/prompts/,
# the container crashes at startup with `ENOENT '/tmp/prompts/<name>.md'` — but only
# when the container actually runs. This check moves the failure earlier, into typecheck.
#
# Covered call patterns:
#   loadPrompt('foo.md')                — single-arg helper
#   loadPrompt('seg', 'foo.md')         — multi-segment helper (last arg is the file)
#   loadPrompt(\n  'foo.md',\n)         — prettier-reflowed call (arg on its own line)
#   path.join(..., 'prompts', 'foo.md') — path.join literal
#   'prompts/foo.md' / "prompts/foo.md" — direct concatenation
#
# These patterns are line-based, so a new call style can slip past them. The
# guard near the end makes that loud: every .md literal in src/ must be either
# captured by a pattern or listed as deliberately-not-a-prompt. Without it a
# partial miss still printed "all resolved" — which is exactly what happened
# when prettier reflowed two loadPrompt calls onto multiple lines.
#
# Style aligned with scripts/check-stream-event-sync.sh: pure bash + grep -E, no python3.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/container/agent-runner/src"
PROMPTS_DIR="$ROOT/container/agent-runner/prompts"

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: agent-runner src dir not found: $SRC_DIR"
  exit 1
fi

if [ ! -d "$PROMPTS_DIR" ]; then
  echo "ERROR: agent-runner prompts dir not found: $PROMPTS_DIR"
  exit 1
fi

# Collect all .ts files under src/.
TS_FILES=()
while IFS= read -r -d '' f; do
  TS_FILES+=("$f")
done < <(find "$SRC_DIR" -type f -name '*.ts' -print0)

if [ "${#TS_FILES[@]}" -eq 0 ]; then
  echo "ERROR: no .ts files found under $SRC_DIR"
  exit 1
fi

# Match patterns and capture the .md filename.
# We emit each hit as: <abs-file>:<line>:<filename.md>
#
# Patterns (each emits one occurrence per line):
#   1) loadPrompt(...,  'foo.md')   — captures the LAST quoted .md token before ')'
#   2) 'prompts', 'foo.md'           — path.join-style literal pair
#   3) 'prompts/foo.md'              — slash-form direct literal
HITS_FILE="$(mktemp)"
ALL_MD_FILE="$(mktemp)"
CAPTURED_FILE="$(mktemp)"
trap 'rm -f "$HITS_FILE" "$ALL_MD_FILE" "$CAPTURED_FILE"' EXIT

# .md literals that are intentionally not agent-runner prompts: they name the
# user's workspace memory files and are resolved against the workspace dir at
# runtime, not against container/agent-runner/prompts/.
NON_PROMPT_MD='^(CLAUDE|CLAUDE\.local)\.md$'

# Pattern 1: loadPrompt(...) — pull the final quoted .md arg before the closing paren.
#            Works for loadPrompt('foo.md') and loadPrompt('seg', 'foo.md').
grep -HnE "loadPrompt\([^)]*\.md['\"]\)" "${TS_FILES[@]}" 2>/dev/null \
  | sed -nE "s/.*loadPrompt\([^)]*['\"]([a-zA-Z0-9_.-]+\.md)['\"]\).*/&/p" \
  | sed -nE "s/^([^:]+):([0-9]+):.*loadPrompt\([^)]*['\"]([a-zA-Z0-9_.-]+\.md)['\"]\).*$/\1:\2:\3/p" \
  >> "$HITS_FILE" || true

# Pattern 2: 'prompts', 'foo.md' or "prompts", "foo.md" (path.join-style)
grep -HnE "['\"]prompts['\"][[:space:]]*,[[:space:]]*['\"][a-zA-Z0-9_.-]+\.md['\"]" "${TS_FILES[@]}" 2>/dev/null \
  | sed -nE "s/^([^:]+):([0-9]+):.*['\"]prompts['\"][[:space:]]*,[[:space:]]*['\"]([a-zA-Z0-9_.-]+\.md)['\"].*$/\1:\2:\3/p" \
  >> "$HITS_FILE" || true

# Pattern 3: 'prompts/foo.md' direct
grep -HnE "['\"]prompts/[a-zA-Z0-9_.-]+\.md['\"]" "${TS_FILES[@]}" 2>/dev/null \
  | sed -nE "s/^([^:]+):([0-9]+):.*['\"]prompts\/([a-zA-Z0-9_.-]+\.md)['\"].*$/\1:\2:\3/p" \
  >> "$HITS_FILE" || true

# Pattern 4: a lone quoted .md literal on its own line — what prettier produces
#            when a loadPrompt(...) call exceeds the print width.
grep -HnE "^[[:space:]]*['\"][a-zA-Z0-9_.-]+\.md['\"],?[[:space:]]*$" "${TS_FILES[@]}" 2>/dev/null \
  | sed -nE "s/^([^:]+):([0-9]+):[[:space:]]*['\"]([a-zA-Z0-9_.-]+\.md)['\"],?[[:space:]]*$/\1:\2:\3/p" \
  >> "$HITS_FILE" || true

# Sort + uniq by (file, line, filename) tuple.
sort -u -o "$HITS_FILE" "$HITS_FILE"

HIT_COUNT=$(wc -l < "$HITS_FILE" | tr -d ' ')

# Sanity check: if the regex matched 0 references but src/ clearly contains 'prompts',
# that's almost certainly a regex bug rather than "no prompts referenced".
if [ "$HIT_COUNT" -eq 0 ]; then
  if grep -lE "prompts" "${TS_FILES[@]}" >/dev/null 2>&1; then
    echo "✗ Suspicious: source contains 'prompts' but regex matched 0 references — possibly a regex bug"
    echo "  Files containing 'prompts':"
    grep -lE "prompts" "${TS_FILES[@]}" | sed 's/^/    /'
    exit 1
  fi
  echo "✓ No prompt-file references found in agent-runner src (prompts may be inlined)."
  exit 0
fi

# Guard: no .md literal in src/ may go uncaptured. A pattern that stops
# matching must fail the build, not silently shrink the checked set.
grep -hoE "['\"][a-zA-Z0-9_.-]+\.md['\"]" "${TS_FILES[@]}" 2>/dev/null \
  | tr -d "'\"" | sort -u > "$ALL_MD_FILE" || true
awk -F: '{print $3}' "$HITS_FILE" | sort -u > "$CAPTURED_FILE"

UNCAPTURED=""
while IFS= read -r name; do
  [ -z "$name" ] && continue
  if echo "$name" | grep -qE "$NON_PROMPT_MD"; then continue; fi
  if ! grep -qxF "$name" "$CAPTURED_FILE"; then
    UNCAPTURED="$UNCAPTURED $name"
  fi
done < "$ALL_MD_FILE"

if [ -n "$UNCAPTURED" ]; then
  echo "✗ Unrecognized prompt-reference form for:$UNCAPTURED"
  echo ""
  echo "  These .md literals appear in agent-runner src/ but no pattern above"
  echo "  captured them, so they would not be checked for existence."
  echo "  Add a pattern, or extend NON_PROMPT_MD if they are not prompts."
  exit 1
fi

# Walk through hits, check existence.
MISSING=0
declare -a UNIQUE_NAMES=()
while IFS=: read -r file line name; do
  if [ -z "$name" ]; then continue; fi
  if echo "$name" | grep -qE "$NON_PROMPT_MD"; then continue; fi
  if [ ! -f "$PROMPTS_DIR/$name" ]; then
    rel="${file#$ROOT/}"
    echo "Missing: prompts/$name (referenced in $rel:$line)"
    MISSING=$((MISSING + 1))
  fi
done < "$HITS_FILE"

if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "Container will fail to start with 'ENOENT /tmp/prompts/<name>.md' when it runs."
  echo "Either restore the missing files, or remove the references from src/."
  exit 1
fi

# Count unique referenced filenames for the success message.
UNIQUE_COUNT=$(awk -F: '{print $3}' "$HITS_FILE" | sort -u | wc -l | tr -d ' ')

echo "✓ All $UNIQUE_COUNT prompt references resolved"
awk -F: '{print $3}' "$HITS_FILE" | sort -u | sed 's/^/   - /'
