#!/usr/bin/env zsh

emulate -L zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL

typeset -r root=${0:A:h:h}
typeset -r zshrc=${ZDOTDIR:-$HOME}/.zshrc
typeset -r config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/ai-shell-suggestions
typeset -r env_file=$config_dir/env
typeset -r plugin=$root/zsh/ai-shell-suggestions.plugin.zsh
typeset mode=install

if [[ ${1:-} == --check ]]; then
  mode=check
elif [[ -n ${1:-} ]]; then
  print -u2 "usage: zsh install.zsh [--check]"
  exit 2
fi

fail() {
  print -u2 "  fail  $1"
  return 1
}

pass() {
  print "  ok    $1"
}

if (( ${ZSH_VERSION%%.*} < 5 )) || { (( ${ZSH_VERSION%%.*} == 5 )) && (( ${${ZSH_VERSION#*.}%%.*} < 9 )); }; then
  fail "zsh 5.9+ required (found $ZSH_VERSION)"
  exit 1
fi
pass "zsh $ZSH_VERSION"

if ! (( $+commands[node] )); then
  fail "Node 22+ is not installed"
  exit 1
fi
typeset node_version=$($commands[node] --version)
typeset node_major=${${node_version#v}%%.*}
if (( node_major < 22 )); then
  fail "Node 22+ required (found $node_version)"
  exit 1
fi
pass "Node $node_version"

typeset -a conflicts
typeset line trimmed active
if [[ -r $zshrc ]]; then
  while IFS= read -r line; do
    trimmed=${line##[[:space:]]#}
    [[ $trimmed == \#* ]] && continue
    active=${line%%\#*}
    [[ $active == *zsh-autosuggestions* ]] && conflicts+=("$line")
  done < "$zshrc"
fi

if (( $#conflicts )); then
  fail "zsh-autosuggestions is enabled in $zshrc"
  print -u2 "        Remove it from your plugin list or source lines, then rerun setup:"
  for line in $conflicts; do
    print -u2 "        $line"
  done
  exit 1
fi
pass "no zsh-autosuggestions conflict"

if [[ $mode == check ]]; then
  typeset result=0
  if [[ -r $env_file ]] && ( source "$env_file"; [[ -n ${TYPESAFE_API_KEY:-} ]] ); then
    pass "API key available from $env_file"
  elif [[ -n ${TYPESAFE_API_KEY:-} ]]; then
    pass "TYPESAFE_API_KEY available"
  else
    fail "TYPESAFE_API_KEY is unavailable" || true
    result=1
  fi

  typeset source_found=0 source_is_last=0
  if [[ -r $zshrc ]]; then
    while IFS= read -r line; do
      trimmed=${line##[[:space:]]#}
      [[ -z $trimmed || $trimmed == \#* ]] && continue
      if [[ $line == "source ${(q)plugin}" ]]; then
        source_found=1
        source_is_last=1
      elif (( source_found )); then
        source_is_last=0
      fi
    done < "$zshrc"
  fi
  if (( source_found && source_is_last )); then
    pass "plugin sourced last from $zshrc"
  elif (( source_found )); then
    fail "plugin must be sourced after other commands in $zshrc" || true
    result=1
  else
    fail "plugin is not sourced from $zshrc" || true
    result=1
  fi
  exit $result
fi

if ! (( $+commands[npm] )); then
  fail "npm is not installed"
  exit 1
fi

print "Installing dependencies..."
npm install --prefix "$root"

typeset api_key=${TYPESAFE_API_KEY:-}
if [[ -z $api_key && -r $env_file ]]; then
  source "$env_file"
  api_key=${TYPESAFE_API_KEY:-}
fi
if [[ -z $api_key ]]; then
  if [[ ! -t 0 ]]; then
    fail "TYPESAFE_API_KEY is unavailable; export it and rerun setup"
    exit 1
  fi
  print -nu2 -- "TypeSafe API key (input hidden, stored in $env_file): "
  if ! read -rs api_key; then
    print -u2
    fail "unable to read the API key"
    exit 1
  fi
  print -u2
fi
if [[ -z $api_key ]]; then
  fail "API key cannot be empty"
  exit 1
fi

mkdir -p "$config_dir"
umask 077
print -r -- "export TYPESAFE_API_KEY=${(q)api_key}" >| "$env_file"
chmod 600 "$env_file"
pass "API key stored in $env_file (mode 600)"

mkdir -p "${zshrc:h}"
[[ -e $zshrc ]] || touch "$zshrc"

# Remove older source entries so the managed one is guaranteed to load last.
typeset tmp=$zshrc.ai-shell-suggestions.$$
while IFS= read -r line; do
  trimmed=${line##[[:space:]]#}
  if [[ $trimmed != \#* && $line == *ai-shell-suggestions.plugin.zsh* ]]; then
    continue
  fi
  print -r -- "$line"
done < "$zshrc" >| "$tmp"
command cat "$tmp" >| "$zshrc"
rm "$tmp"

cat >> "$zshrc" <<EOF

# ai-shell-suggestions (managed by $root/zsh/install.zsh)
source ${(q)plugin}
EOF

pass "plugin sourced last from $zshrc"
print
print "Setup complete. Start a new shell with: exec zsh"
