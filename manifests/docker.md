---
app: docker
platform: cli
version: 1
notes:
  - Most tools assume the Docker daemon is running. Check via `system_status` first if needed.
  - Output of `ps`, `images`, `logs` etc. can be large — pipe through head/tail in steps if you only need a slice.
tools:
  - name: ps
    description: List running containers.
    steps:
      - run: docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
      - read: stdout

  - name: ps_all
    description: List ALL containers (running + stopped).
    steps:
      - run: docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
      - read: stdout

  - name: images
    description: List local Docker images.
    steps:
      - run: docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
      - read: stdout

  - name: logs
    description: Get the most recent log lines from a container.
    params:
      container:
        type: string
        required: true
        description: Container name or ID.
      lines:
        type: number
        required: false
        description: Number of trailing lines (default 50).
    steps:
      - run: docker logs --tail ${lines} ${container}
      - read: stdout

  - name: system_status
    description: Show overall Docker system info (daemon health, disk usage).
    steps:
      - run: docker system info
      - read: stdout
---

# AgentDOM Manifest — Docker

Docker's `docker --help` produces good Cobra-style output and the auto-scanner
already emits ~57 typed tools (`click_run`, `click_build`, `click_logs`, ...).
This manifest adds **structured query intents** an agent reaches for
constantly: list containers, list images, tail logs, check daemon health.

The difference: the auto-emitted `click_logs` would just open the help for
the `logs` subcommand. The manifest's `logs({container, lines})` actually
runs `docker logs --tail N <container>` and returns the output.

## Status: 🟡 template

Verified that the syntax parses and the manifest loads. End-to-end run
against a live Docker daemon depends on Docker Desktop being installed
and running.
