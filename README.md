# agent-im-bridge

[![npm version](https://img.shields.io/npm/v/%40neiro_o%2Fagent-im-bridge?style=flat-square&logo=npm)](https://www.npmjs.com/package/@neiro_o/agent-im-bridge)
[![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40neiro_o%2Fagent-im-bridge?style=flat-square)](https://www.npmjs.com/package/@neiro_o/agent-im-bridge)
[![test status](https://img.shields.io/github/actions/workflow/status/neiro-o/agent-im-bridge/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/neiro-o/agent-im-bridge/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](#license)

`agent-im-bridge` connects IM channel (feishu, weixin, wecom...) to local coding agent (pi, codex, opencode...) using a dual-adapter architecture.

The design stays intentionally simple and compact: no harness layer, no extra tools, no extra skills, just forwarding messages from IM to the local agent.

## Current support

Client side:

| Platform      | Image/file in | Image/file out | Emoji | Dynamic progress |
| ------------- | ------------- | -------------- | ----- | ---------------- |
| Feishu / Lark | ✅            | ✅             | ✅    | ✅               |
| WeCom         | ✅            | ✅             | —     | ✅               |
| Weixin        | ✅            | ✅             | —     | —                |

- **Emoji** = platform-native emoji / reaction capability currently used by the bridge.
- **Dynamic progress** = progress shown before the final answer arrives.

Agent side:

| Agent           | New | Stop | Compact | Model switching | Setup guide                        |
| --------------- | --- | ---- | ------- | --------------- | ---------------------------------- |
| PI Coding Agent | ✅  | ✅   | ✅      | ✅              | [Guide](./docs/pi-coding-agent.md) |
| OpenCode        | ✅  | ✅   | ✅      | ✅              | [Guide](./docs/opencode.md)        |

> The current built-in support is intentionally small, but the architecture is designed for straightforward horizontal extension. The project will primarily maintain the integrations used in practice today, and contributions for additional client or agent adapters are welcome through forks and PRs.

## Quick Start

Install the CLI:

```bash
npm install -g @neiro_o/agent-im-bridge
```

The CLI currently provides these commands:

- `agent-im-bridge add`
- `agent-im-bridge ls`
- `agent-im-bridge remove <channel-name>`
- `agent-im-bridge start <channel-name>`
- `agent-im-bridge feishu setup` — guided Feishu bot onboarding: exact permission checklist with console links and QR codes, credential verification, and a live capability probe (receiving the bot's reply proves event subscription, version publish and availability in one go)
- `agent-im-bridge access pending|list` — show users waiting for authorization / already authorized
- `agent-im-bridge access approve <open-id> [--ssh]` / `deny` / `revoke` — manage the user allowlist (applies to a running bridge within seconds, no restart)
- `agent-im-bridge queue add`
- `agent-im-bridge queue insert <queue-name> --prompt "..." [--directory <path>]`
- `agent-im-bridge queue list`
- `agent-im-bridge schedule history [task-name]`
- `agent-im-bridge queue history <queue-name>`

### User access control (Feishu)

A Feishu channel can require administrator approval before a user may talk to the bot: enable `accessControl.enabled` in the channel config (the `add` wizard and `feishu setup` both offer it). Unauthorized users get a "waiting for approval" reply and are recorded — with their open_id captured automatically — in `~/.config/agent-bridge/authz.json`. The administrator approves them from the CLI:

```bash
agent-im-bridge access pending              # who is waiting (open_id, name, chat)
agent-im-bridge access approve ou_xxx       # grant bot access (agent mode)
agent-im-bridge access approve ou_xxx --ssh # also grant SSH mode
```

The approved user is notified in their chat automatically. SSH mode stays additionally protected by the chat-level `localControl.allowedClientSessionIds` allowlist — both gates must pass.

Create a channel interactively:

```bash
agent-im-bridge add
```

The prompt flow currently asks for:

- channel name
- select client module type
- set client config...
- select agent module type
- set agent config...

Start the configured channel:

```bash
agent-im-bridge start <channel-name>
```

List configured channels:

```bash
agent-im-bridge ls
```

Remove a configured channel:

```bash
agent-im-bridge remove <channel-name>
```

Config file: `~/.config/agent-bridge/config.json`

Architecture overview: [`docs/architecture-design.md`](./docs/architecture-design.md)

Command usage across IM adapters: [`docs/command-system.md`](./docs/command-system.md)

Scheduled tasks (cron-style agent sessions with file-based prompts): [`docs/scheduled-tasks.md`](./docs/scheduled-tasks.md)

Event queues (FIFO agent task queues with file-based prompts, worker concurrency and chat-bound result delivery): [`docs/event-queue.md`](./docs/event-queue.md)

Event queues let you run a stream of agent prompts through the same pipeline as scheduled tasks: a queue definition (`queues/<name>.md`) carries a worker count, an optional model and a shared-context body appended to every task; tasks are inserted with `agent-im-bridge queue insert` and consumed FIFO by the owning channel's controller, which delivers each result (or failure/timeout notice) to the chat bound with `/queue-here`. Like scheduled tasks, queue runs are fully isolated from the target chat's own session. Both scheduled tasks and event queues use the same completion protocol: the run ends when the agent appends the `BRIDGE_TASK_STATUS_DONE` marker as the last line of its final message, at which point the full accumulated transcript is delivered once; a silence probe asks an inactive run whether it is finished, and the wall-clock `timeout` remains the hard cap.

## Start a session in a specific directory

From any IM chat, `/new <path>` starts the next agent session in that directory instead of the bridge's working directory:

```text
/new ~/project-learn/demo
```

A directory given once is remembered per chat (persisted in the channel's client session store): a later bare `/new` reuses it, and only falls back to the bridge's working directory when nothing was ever chosen. Paths are validated locally before a session is created — invalid ones are rejected immediately and never remembered — see [`docs/command-system.md`](./docs/command-system.md) for details.

If the bot is not strictly private, restrict the directories users may start sessions in via `defaults.allowedWorkingDirectoryRoots` in `~/.config/agent-bridge/config.json`:

```json
{
  "defaults": {
    "allowedWorkingDirectoryRoots": ["/Users/wesley/project-learn"]
  }
}
```

When configured, user-originated `/new <path>` targets (including remembered defaults) must resolve inside one of the roots. The client-side cwd fallback for a bare `/new` and the channel-level agent configuration are trusted and never checked.

The bridge also releases agent sessions that are idle: a session whose last observable activity is older than `defaults.agentIdleTimeoutMs` (default `24h`) is stopped and released. The idle timer is pure inactivity — it tracks the last run event and reschedules whenever one arrives; there is no busy check. The agent adapters defend themselves internally (an `abort()` when there is no active turn is a no-op), and `/model` performs no busy gating.

## Development

```bash
npm install
npm run build
npm test
npm run dev -- --help
```

## Q&A

### Why not implement this directly as a `pi-feishu`, `pi-wechat`, or similar plugin?

Because plugin-style integrations for Pi or similar local agents do not provide enough control over session lifecycle, channel behavior, and local runtime isolation.

In practice, this shows up in a few ways:

- It is hard to implement a real `/new` that cleanly resets the remote conversation while keeping channel-side routing predictable.
- Connecting the same local agent cleanly to multiple channels is much harder when each integration is embedded as a plugin inside the agent runtime.
- Different channels have very different behavior, and existing integrations are often maintained independently without a shared contract.
- The local development and runtime experience becomes much more invasive: starting Pi for normal local work can also start multiple channel-facing plugins and inject extra tools that are unrelated to the task at hand.

`agent-im-bridge` takes the opposite approach: keep the local agent runtime focused, keep channel integration outside the agent process, and make session routing explicit at the bridge layer.

## License

MIT.
