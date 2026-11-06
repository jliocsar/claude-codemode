#!/usr/bin/env bash
# Refuse a Bash command that skips the git hooks. The hooks are the gate, so an
# agent fixes what they report rather than stepping around them. Quoted text is
# dropped first, so a commit message that merely mentions a flag still passes.

set -u

command=$(jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then exit 0; fi

refuse() {
  printf '%s. The git hooks are the gate: fix what they report instead of skipping them.\n' "$1" >&2
  exit 2
}

matches() {
  printf '%s' "$1" | grep -Eiq "$2"
}

if matches "$command" '(^|[[:space:];&|])GIT_CONFIG_(COUNT|PARAMETERS)='; then
  refuse 'Setting git config through the environment can replace the hooks path'
fi

unquoted=$(printf '%s' "$command" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

while IFS= read -r segment; do
  if ! matches "$segment" '(^|[[:space:]])git([[:space:]]|$)'; then continue; fi

  if matches "$segment" '(^|[[:space:]])--no-v[a-z]*([[:space:]=]|$)'; then
    refuse '--no-verify skips the git hooks'
  fi

  if matches "$segment" '(^|[[:space:]])commit([[:space:]]|$)' &&
    printf '%s' "$segment" | grep -Eq '(^|[[:space:]])-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$)'; then
    refuse 'git commit -n skips the git hooks'
  fi
done <<<"$(printf '%s\n' "$unquoted" | sed -E 's/&&|\|\||;|\|/\n/g')"

while IFS= read -r segment; do
  if ! matches "$segment" '(^|[[:space:]])git([[:space:]]|$)' || ! matches "$segment" 'core\.hooksPath'; then continue; fi

  if matches "$segment" '[[:space:]]config[[:space:]]+(--get|--show-origin[[:space:]]+--get)[[:space:]]+["'"'"']?core\.hooksPath'; then continue; fi

  if matches "$segment" '[[:space:]]config[[:space:]]+["'"'"']?core\.hooksPath["'"'"']?[[:space:]]*$'; then continue; fi

  refuse 'Changing core.hooksPath replaces the git hooks'
done <<<"$(printf '%s\n' "$command" | sed -E 's/&&|\|\||;|\|/\n/g')"

exit 0
