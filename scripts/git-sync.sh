#!/usr/bin/env bash
set -euo pipefail

# Default repo dir (you can override by passing a path as the first arg)
REPO_DIR="${1:-$HOME/Projects/PlayTime-USA/backend-v2}"

# Default commit message (you can override by passing a second arg)
COMMIT_MSG="${2:-"chore: sync backend-v2 changes"}"

echo "=== Git sync for $REPO_DIR ==="

cd "$REPO_DIR" || {
  echo "ERROR: Repo directory not found: $REPO_DIR"
  exit 1
}

# Make sure this is a git repo
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $REPO_DIR is not a git repository."
  exit 1
fi

# Show current status
echo
echo "--- git status (before) ---"
git status

# Stage all changes (new, modified, deleted)
echo
echo "--- git add -A ---"
git add -A

# If nothing staged, bail out cleanly
if git diff --cached --quiet; then
  echo
  echo "No changes to commit. Exiting."
  exit 0
fi

# Figure out current branch
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo
echo "--- git commit ---"
echo "Branch: $CURRENT_BRANCH"
echo "Message: $COMMIT_MSG"
git commit -m "$COMMIT_MSG"

# Make sure origin exists
if ! git remote get-url origin >/dev/null 2>&1; then
  echo
  echo "ERROR: No 'origin' remote configured. Set it with:"
  echo "  git remote add origin git@github.com:YOUR_USER/YOUR_REPO.git"
  exit 1
fi

echo
echo "--- git push origin $CURRENT_BRANCH ---"
git push origin "$CURRENT_BRANCH"

echo
echo "✅ Sync complete: $CURRENT_BRANCH pushed to origin."
