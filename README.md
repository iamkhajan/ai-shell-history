# ai-shell-suggestions

![Usage](assets/new-branch.png)


## What it is 
Usecase around System One/Decission model - Important it doesnt generate so no direct compare to LLM
- Gives command auto suggestion with highest score
- Domain understanding
- ag - grep
- ah - history commands

## Install

Try it with one command:

```sh
git clone --depth 1 git@github.com:iamkhajan/ai-shell-suggestions.git ~/.zsh/ai-shell-suggestions && zsh ~/.zsh/ai-shell-suggestions/zsh/install.zsh && exec zsh
```

Setup prompts for `TYPESAFE_API_KEY` and stores it outside `~/.zshrc` with
owner-only permissions.

To check an existing setup without changing it:

```sh
❯ npm run doctor

> ai-shell-suggestions@0.1.0 doctor
> zsh zsh/install.zsh --check

  ok    zsh 5.9.1
  ok    Node v26.5.0
  ok    no zsh-autosuggestions conflict
  ok    API key available from /Users/iamkhajan/.config/ai-shell-suggestions/env
  ok    plugin sourced last from /Users/iamkhajan/.zshrc
```

### zsh-autosuggestions conflict

`ai-shell-suggestions` attempts to replace or alternate to `zsh-autosuggestions`

Setup detects active references and tells you which lines to change. Drop it
from your plugin list, then rerun setup:

```diff
-plugins=(git zsh-autosuggestions zsh-syntax-highlighting)
+plugins=(git zsh-syntax-highlighting)
```

The installer then ensures `ai-shell-suggestions` is sourced last, after frameworks
and other widget-wrapping plugins.

## Priority commands

Point `JEV_PRIORITY_FILE` at a plain text file with one command per line.
A `# heading` assigns its text as the group for the commands below it:

```zsh
export JEV_PRIORITY_FILE=~/.commands.txt
```

```
# git
git checkout -b feature/
git add -A && git commit -m ""

# docker
docker compose up -d
```

## hcgrep

`ag` (also available as `hcgrep`) finds repositories from a
natural-language query. It scans the immediate children of `WORKSPACE_ROOT`,
or the current directory when that variable is unset, and joins local checkouts to the
repository descriptions in `repos.json`, creates a lexical shortlist, then uses
Jev to rank that shortlist, reject unrelated queries, and classify the requested
action as `cd`, `code`, `open`, `web`, or `no_action`.

The zsh plugin exposes both names after setup. Configure a persistent checkout
root when you want to run it from anywhere:

```zsh
export WORKSPACE_ROOT=~/work

ag "go to cookai backend"
ag "open cookai frontend"
ag "show secret management on github"
ag "account service" --for "auth handler"
```

`ag` queues the best command into the next zsh prompt when the query requests
an action and both the repository match and top result are strong. Review the
prefilled command, then press Enter. 
Low-confidence actions and `no_action` queries show ranked repositories without
producing a command. Override the action confidence gate with `--action-threshold`.

Supported outputs are `cd`, VS Code's `code`, macOS `open`, and
`gh repo view --web`. Explicit `code` or `vscode` requests use VS Code, explicit
`open` requests use macOS, and terminal-work requests such as building or testing
use `cd`. Queries without an action only show ranked repositories.
Commands use paths relative to the current directory. Action routing is
classified by Jev; path resolution, shell quoting, and command construction remain
deterministic and restricted to the supported commands. Jev ranks repositories and files.



## History search

`ah` finds a command by meaning in the 500 most recent distinct history entries.
It searches bounded batches and reranks their best candidates:

```zsh
ah "how was payment service deployed"
ah "show worktree for account"
```

Probable credentials and
long opaque values are excluded before history is sent to TypeSafe. Destructive
commands such as recursive `rm` or `git reset --hard` are shown for review but
never queued.

Run `node src/ah-cli.ts --help` for configurable history, result, and confidence
limits.
