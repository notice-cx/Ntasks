#!/usr/bin/env bash
# Connects the AI coding agents on this machine to an Ntasks deployment and
# installs the Ntasks skill for each one. docs/agents.md describes it.
#
#   curl -fsSL https://raw.githubusercontent.com/notice-cx/Ntasks/main/install.sh | bash
#
# It runs on the bash that macOS ships (3.2): no associative arrays, and no
# expansion of an array that may be empty under `set -u`. Prompts read from
# /dev/tty because stdin is the script itself when it is piped to bash.
set -euo pipefail

SERVER=ntasks
SUPPORTED='claude codex gemini'
SKILL_SOURCE=${NTASKS_SKILL_SOURCE:-https://raw.githubusercontent.com/notice-cx/Ntasks/${NTASKS_REF:-main}/skills/ntasks/SKILL.md}

usage() {
  cat <<'EOF'
Connects AI coding agents to Ntasks and installs the Ntasks skill for each.

Usage: install.sh [--url <address>] [--agents <list>] [--yes]

  --url <address>   The Ntasks address, such as https://ntasks.example.com
                    (environment: NTASKS_URL)
  --agents <list>   The agents to set up, separated by commas: claude, codex,
                    gemini (environment: NTASKS_AGENTS)
  --yes             Make the changes without asking, including replacing an
                    ntasks server registered at another address or as a
                    local command (environment: NTASKS_YES=1)
  --help            Show this text

NTASKS_REF names the branch or tag of notice-cx/Ntasks the skill is
downloaded from (default main); NTASKS_SKILL_SOURCE replaces the download with
another URL or a local file.
EOF
}

die() {
  printf 'Stopped: %s\n' "$*" >&2
  exit 1
}

# Whether this process can open the terminal: false when it runs without one,
# such as in CI or under another program.
has_tty() { { : </dev/tty; } 2>/dev/null; }

# Asks a question on the terminal and puts the reply in $answer. $2 is the
# sentence to stop with when there is no terminal.
ask() {
  has_tty || die "$2"
  printf '%s' "$1" >/dev/tty
  answer=''
  # read fails at the end of input (Ctrl-D); a last line with no newline still counts.
  IFS= read -r answer </dev/tty || [ -n "$answer" ] || die 'no answer.'
}

# The address as an origin, such as https://ntasks.example.com, or nothing when
# it is not one: https only, except http://localhost and http://127.0.0.1.
normalise_address() {
  local address=$1 host
  address=$(printf '%s' "$address" | tr -d '[:space:]')
  while [ "${address%/}" != "$address" ]; do address=${address%/}; done
  address=${address%/api/mcp}
  case $address in
    http://* | https://*) ;;
    *) address="https://$address" ;;
  esac
  host=${address#*://}
  case $host in
    '' | *[!A-Za-z0-9.:-]*) return 0 ;;
  esac
  case $address in
    https://* | http://localhost | http://localhost:* | http://127.0.0.1 | http://127.0.0.1:*)
      printf '%s' "$address"
      ;;
  esac
}

agent_name() {
  case $1 in
    claude) printf 'Claude Code' ;;
    codex) printf 'OpenAI Codex CLI' ;;
    gemini) printf 'Gemini CLI' ;;
  esac
}

# Codex reads user skills from ~/.agents/skills, and Gemini CLI reads that
# folder before its own, so the two share one copy.
skill_path() {
  case $1 in
    claude) printf '%s' "$HOME/.claude/skills/$SERVER/SKILL.md" ;;
    codex | gemini) printf '%s' "$HOME/.agents/skills/$SERVER/SKILL.md" ;;
  esac
}

sign_in_step() {
  case $1 in
    claude) printf 'run claude mcp login %s, or /mcp in a Claude Code session' "$SERVER" ;;
    codex) printf 'run codex mcp login %s' "$SERVER" ;;
    gemini) printf 'run /mcp auth %s in a Gemini CLI session' "$SERVER" ;;
  esac
}

shown() {
  case $1 in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Where a registration points, from registered_url.
described() {
  if [ "$1" = - ]; then printf 'as a local command'; else printf 'at %s' "$1"; fi
}

# Runs an agent's command in an empty folder, so that no project's own MCP
# settings hide the user-level ones, with stdin closed so that it cannot read
# the rest of a piped script.
in_work() { (cd "$work" && "$@" </dev/null); }

# Runs a command quietly; when it fails, prints what it said and fails.
quietly() {
  local said
  if ! said=$("$@" 2>&1); then
    printf '%s\n' "$said" >&2
    return 1
  fi
}

# The URL of the user-level ntasks server an agent has registered, - when it is
# registered without one (a local command), or nothing. Each agent's output is
# read as its current release prints it.
registered_url() {
  local said line
  case $1 in
    claude)
      said=$(in_work claude mcp get "$SERVER" 2>/dev/null) || return 0
      case $said in *'Scope: User'*) ;; *) return 0 ;; esac
      while IFS= read -r line; do
        line=${line#"${line%%[![:space:]]*}"}
        case $line in 'URL: '*)
          printf '%s' "${line#URL: }"
          return 0
          ;;
        esac
      done <<<"$said"
      printf -- -
      ;;
    codex)
      said=$(in_work codex mcp get "$SERVER" --json 2>/dev/null) || return 0
      while IFS= read -r line; do
        line=${line#"${line%%[![:space:]]*}"}
        case $line in '"url": "'*)
          line=${line#'"url": "'}
          printf '%s' "${line%%\"*}"
          return 0
          ;;
        esac
      done <<<"$said"
      printf -- -
      ;;
    gemini)
      said=$(in_work gemini mcp list 2>/dev/null) || return 0
      while IFS= read -r line; do
        case $line in *" $SERVER: "*)
          line=${line#*" $SERVER: "}
          line=${line%% *}
          case $line in http://* | https://*) printf '%s' "$line" ;; *) printf -- - ;; esac
          return 0
          ;;
        esac
      done <<<"$said"
      ;;
  esac
}

# Registers ntasks at the endpoint for every project; $2 says whether an
# earlier registration of that name goes first.
register() {
  case $1 in
    claude)
      if [ "$2" = replace ]; then quietly in_work claude mcp remove "$SERVER" --scope user || return 1; fi
      quietly in_work claude mcp add --transport http --scope user "$SERVER" "$endpoint"
      ;;
    # Both replace a registration of the same name.
    codex) quietly in_work codex mcp add "$SERVER" --url "$endpoint" ;;
    gemini) quietly in_work gemini mcp add --transport http --scope user "$SERVER" "$endpoint" ;;
  esac
}

fetch_skill() {
  case $SKILL_SOURCE in
    http://* | https://*)
      command -v curl >/dev/null 2>&1 || die "curl is needed to download the skill."
      curl -fsSL "$SKILL_SOURCE" -o "$skill" || die "could not download the skill from $SKILL_SOURCE."
      ;;
    *)
      [ -r "$SKILL_SOURCE" ] || die "cannot read the skill at $SKILL_SOURCE."
      cp "$SKILL_SOURCE" "$skill"
      ;;
  esac
  grep -qx "name: $SERVER" "$skill" || die "$SKILL_SOURCE is not the Ntasks skill."
}

# Writes the skill. Each step is chained because set -e does not apply inside
# a function whose status the caller tests.
install_skill() {
  mkdir -p "$(dirname "$1")" && cp "$skill" "$1.$$" && mv -f "$1.$$" "$1"
}

main() {
  local address=${NTASKS_URL:-} agents=${NTASKS_AGENTS:-} yes='' found='' chosen='' id word url changes=0
  case ${NTASKS_YES:-} in 1 | true | yes) yes=1 ;; esac

  while [ $# -gt 0 ]; do
    case $1 in
      --url)
        [ $# -ge 2 ] || die "--url needs an address."
        address=$2
        shift 2
        ;;
      --url=*)
        address=${1#--url=}
        shift
        ;;
      --agents)
        [ $# -ge 2 ] || die "--agents needs a list, such as claude,codex."
        agents=$2
        shift 2
        ;;
      --agents=*)
        agents=${1#--agents=}
        shift
        ;;
      -y | --yes)
        yes=1
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) die "unknown option $1. --help lists the options." ;;
    esac
  done
  : "${HOME:?HOME is not set}"

  printf 'Connects your AI coding agents to Ntasks and installs the Ntasks skill for each.\n\n'

  if [ -n "$address" ]; then
    endpoint=$(normalise_address "$address")
    [ -n "$endpoint" ] || die "$address is not an Ntasks address. Use https://, or http:// for localhost."
  else
    endpoint=''
    while [ -z "$endpoint" ]; do
      ask 'Ntasks address, such as https://ntasks.example.com: ' 'no Ntasks address. Pass --url or set NTASKS_URL.'
      endpoint=$(normalise_address "$answer")
      [ -n "$endpoint" ] || printf '%s is not an Ntasks address. Use https://, or http:// for localhost.\n' "$answer"
    done
  fi
  endpoint="$endpoint/api/mcp"
  printf 'MCP endpoint: %s\n\nAgents on this machine:\n' "$endpoint"

  for id in $SUPPORTED; do
    if command -v "$id" >/dev/null 2>&1; then
      found="$found $id"
      printf '  %-8s %-18s found\n' "$id" "$(agent_name "$id")"
    else
      printf '  %-8s %-18s not found\n' "$id" "$(agent_name "$id")"
    fi
  done
  found=${found# }
  printf '\n'
  [ -n "$found" ] || die "no supported agent found. docs/agents.md shows how to connect other agents."

  if [ -z "$agents" ]; then
    ask "Agents to set up [$found]: " 'no agents chosen. Pass --agents or set NTASKS_AGENTS.'
    agents=${answer:-$found}
    printf '\n'
  fi
  for word in $(printf '%s' "$agents" | tr ',' ' '); do
    case " $SUPPORTED " in *" $word "*) ;; *) die "$word is not an agent this script sets up: $SUPPORTED." ;; esac
    case " $found " in *" $word "*) ;; *) die "$(agent_name "$word") ($word) is not installed." ;; esac
    case " $chosen " in *" $word "*) ;; *) chosen="$chosen $word" ;; esac
  done
  chosen=${chosen# }
  [ -n "$chosen" ] || die 'no agents chosen.'

  # A template, because macOS's mktemp -d alone ignores TMPDIR.
  work=$(mktemp -d "${TMPDIR:-/tmp}/ntasks.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  skill="$work/SKILL.md"
  fetch_skill

  # Each agent's plan, in variables named after it: plan_<id> is add, replace,
  # keep (already at the endpoint) or other (left at another address).
  for id in $chosen; do
    url=$(registered_url "$id")
    if [ "$url" = "$endpoint" ]; then
      printf -v "plan_$id" keep
    elif [ -z "$url" ]; then
      printf -v "plan_$id" add
    elif [ -n "$yes" ]; then
      printf -v "plan_$id" replace
    else
      ask "$(agent_name "$id") has $SERVER registered $(described "$url"). Replace it with $endpoint? [y/N] " \
        "$(agent_name "$id") has $SERVER registered $(described "$url"). Pass --yes to replace it with $endpoint."
      case $answer in
        y | Y | yes | Yes) printf -v "plan_$id" replace ;;
        *) printf -v "plan_$id" other ;;
      esac
      printf '\n'
    fi
    printf -v "was_$id" '%s' "$url"
  done

  printf 'Plan:\n'
  for id in $chosen; do
    local plan="plan_$id" was="was_$id" path
    path=$(skill_path "$id")
    printf '  %s\n' "$(agent_name "$id")"
    case ${!plan} in
      add) printf '    register the MCP server %s at %s, for every project\n' "$SERVER" "$endpoint" ;;
      replace) printf '    replace the MCP server %s %s with %s\n' "$SERVER" "$(described "${!was}")" "$endpoint" ;;
      keep) printf '    keep the MCP server %s: already at %s\n' "$SERVER" "$endpoint" ;;
      other) printf '    keep the MCP server %s %s\n' "$SERVER" "$(described "${!was}")" ;;
    esac
    case ${!plan} in add | replace) changes=$((changes + 1)) ;; esac
    if cmp -s "$skill" "$path"; then
      printf '    keep the skill at %s: already current\n' "$(shown "$path")"
    else
      printf '    install the skill at %s\n' "$(shown "$path")"
      changes=$((changes + 1))
    fi
  done
  printf '\n'

  if [ "$changes" -eq 0 ]; then
    printf 'Nothing to change.\n'
  else
    if [ -z "$yes" ]; then
      ask 'Make these changes? [Y/n] ' 'nothing changed. Pass --yes to make these changes without a prompt.'
      case $answer in '' | y | Y | yes | Yes) ;; *) die 'nothing changed.' ;; esac
      printf '\n'
    fi
    for id in $chosen; do
      local plan="plan_$id" name path
      name=$(agent_name "$id")
      path=$(skill_path "$id")
      case ${!plan} in
        add | replace)
          register "$id" "${!plan}" || die "$name did not register $SERVER. Its output is above."
          printf '%s: registered %s at %s\n' "$name" "$SERVER" "$endpoint"
          ;;
      esac
      if ! cmp -s "$skill" "$path"; then
        install_skill "$path" || die "could not write the skill at $(shown "$path")."
        printf '%s: installed the skill at %s\n' "$name" "$(shown "$path")"
      fi
    done
  fi

  printf '\nSign each agent in to Ntasks. Its first sign-in opens Ntasks in your browser, where you allow the agent and choose its projects.\n'
  for id in $chosen; do
    printf '  %s: %s\n' "$(agent_name "$id")" "$(sign_in_step "$id")"
  done
}

main "$@"
