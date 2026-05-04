---
app: git
platform: cli
version: 1
notes:
  - All tools assume the working directory is a git repo. Wrap calls in try/catch on the agent side or check exit codes via read:exit_code.
  - The default `scan_cli` parser doesn't fully recognize git's prose --help output; prefer the manifest-declared tools below.
tools:
  - name: status
    description: Show the working tree status in machine-readable form.
    intent: vcs.status
    steps:
      - run: git status --porcelain
      - read: stdout

  - name: log_recent
    description: Show the last N commits as one-liners.
    intent: vcs.log
    params:
      limit:
        type: number
        required: true
        description: Number of commits to show (1-200).
    steps:
      - run: git log --oneline -n ${limit}
      - read: stdout

  - name: current_branch
    description: Print the current branch name.
    intent: vcs.current_branch
    steps:
      - run: git rev-parse --abbrev-ref HEAD
      - read: stdout

  - name: diff_stat
    description: Summarize unstaged + staged changes (file count, insertions, deletions).
    intent: vcs.diff
    steps:
      - run: git diff --stat HEAD
      - read: stdout

  - name: blame_line
    description: Show who last touched a specific line of a file.
    intent: vcs.blame
    params:
      file:    { type: string, required: true, description: Path relative to repo root. }
      line:    { type: number, required: true, description: 1-indexed line number. }
    steps:
      - run: git blame -L ${line},${line} -- ${file}
      - read: stdout
---

# AgentDOM Manifest — git

git's `--help` output is prose-style and the auto-scanner only catches a fraction
of its subcommands. This manifest exposes the most common queries directly.

## What this manifest provides

- **Five typed query tools** an agent will reach for constantly: `status`,
  `log_recent`, `current_branch`, `diff_stat`, `blame_line`.
- Each is a one-liner that runs the right `git` invocation and returns stdout
  as a string.

## Why an app owner would ship this

git's CLI is stable and well-known, but its `--help` doesn't fit the
Cobra/Click pattern the auto-scanner expects. Without this manifest, an LLM
would have to know how to compose `git log --oneline -n 5` from scratch; with
it, the agent calls `log_recent({ limit: 5 })` and gets the right lines back.

Same idea applies to any CLI whose `--help` is non-standard: Docker, kubectl,
gh, terraform, npm, pnpm, yarn, cargo, go, stack…

## Step grammar reference

- `run: <cmdline-with-${param}>` — `execFileSync` after splitting on whitespace.
  The first token must match `^[a-zA-Z][\w.-]{0,63}$`.
- `read: stdout|stderr|exit_code` — capture the last `run`'s output and return.
- `wait: <ms>` — small delay between steps.
