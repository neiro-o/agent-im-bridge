# Agent Bridge：Pi 专属增强命令设计

- 文档状态：Draft
- 面向项目：[HoPGoldy/agent-bridge](https://github.com/HoPGoldy/agent-bridge)
- 基准版本：`@hopgoldy/agent-bridge 0.8.6`
- Pi：`@earendil-works/pi-coding-agent` RPC 模式
- 设计目标：增强 Pi 命令，同时与 OpenCode Agent 严格隔离

## 1. 背景

agent-bridge 同时支持多个 Agent 后端，包括：

- `pi-coding-agent`
- `opencode`

两个后端共享 `GatewayCore`、IM Adapter、`AgentAdapter` 等基础抽象，但其会话能力和控制协议不同：

- Pi 通过 JSONL RPC 提供模型、thinking、session tree、fork、clone、export、队列策略等能力；
- OpenCode 通过 OpenCode SDK/API 提供自己的 session、summarize、permission、question 和 model 能力；
- Pi 的 `/thinking`、`/commands`、`/fork`、`/clone` 等语义不能假设 OpenCode 同样支持；
- OpenCode 的 permission/question 机制也不能反向硬编码到 Pi Adapter。

因此，Pi 增强命令必须作为 **Agent-specific capability** 实现，不能把 Pi RPC 调用写进飞书适配器或通用 Slash Command Parser。

---

## 2. 目标

### 2.1 功能目标

在现有通用命令基础上，为 Pi 通道增加：

- 补全 `/compact [instructions]`
- `/thinking [level]` 与 `/effort [level]`
- `/session`
- `/name <name>`
- `/commands`
- `/steer <message>`
- `/follow-up <message>`
- `/clone`
- `/fork`、`/fork <entry-id|selection>`
- `/resume`、`/resume <session-id|path>`
- `/export [path]`
- `/last`
- `/auto-compact [on|off]`
- `/retry [on|off]`
- 可选 `/model-next`、`/thinking-next`
- 可选只读 `/tree`

### 2.2 隔离目标

- Pi-only 命令不出现在 OpenCode 通道的 `/help` 或 `/commands` 中；
- OpenCode 通道收到 Pi-only 命令时，不调用任何 Pi 代码；
- Pi RPC 类型、Pi session 文件格式和 Pi-specific 状态不得泄漏到 `OpenCodeAgentAdapter`；
- 通用 Core 不通过 `instanceof PiCodingAgentAdapter` 判断后端；
- 不通过 `agentModule.type === "pi-coding-agent"` 在 Core 中堆积大量分支；
- 应通过显式 capability/command provider 扩展；
- 未实现 capability 时必须安全降级，而不是隐式发送给模型。

### 2.3 非目标

- 不完整复制 Pi TUI；
- 不远程实现 `/login`、`/logout`、`/trust` 等安全敏感 UI；
- 不把 `/settings` TUI 整体搬到聊天；
- 不要求 OpenCode 实现 Pi 的 session tree；
- 不允许 Pi 命令名称覆盖 Bridge 管理命令。

---

## 3. 当前命令分类

### 3.1 Bridge 通用命令

这些由 agent-bridge 定义，不属于特定 Agent：

```text
/help
/new [working-directory]
/stop
/status
/model [provider/model]
/compact
/schedule-run <task>
/schedule-here <task>
/queue-here <queue>
```

其中 `/stop`、`/status`、`/model`、`/compact` 依赖 `AgentAdapter` 通用 capability，Pi 与 OpenCode 当前都已有相应基础实现。

### 3.2 Bridge 本地控制命令

如果 enhanced 分支包含远程 Shell：

```text
/agent
/ssh
/upload
/upload-cancel
/download <path>
```

这些由 IM/local-control 层处理，也不应属于 Pi AgentAdapter。它们可以与 Pi、OpenCode 独立组合，是否开放由 channel 配置和 allowlist 决定。

### 3.3 Pi-only 命令

```text
/thinking [level]
/effort [level]
/session
/name <name>
/commands
/steer <message>
/follow-up <message>
/clone
/fork [entry-id]
/resume [session]
/export [path]
/last
/auto-compact [on|off]
/retry [on|off]
/model-next
/thinking-next
/tree
```

这些命令只在 Pi command provider 声明并实现后出现。

---

## 4. 隔离架构

## 4.1 不推荐的实现

以下方案禁止采用：

```ts
// 禁止：飞书适配器直接调用 Pi RPC
if (text.startsWith("/thinking")) {
  await piRpc.setThinkingLevel(...);
}
```

```ts
// 禁止：Core 依赖具体类
if (runtime.agentAdapter instanceof PiCodingAgentAdapter) {
  ...
}
```

```ts
// 不推荐：Core 对 agent type 写越来越长的 switch
if (this.#agentModule.type === "pi-coding-agent") {
  ...
}
```

问题包括：

- Feishu、WeCom、Weixin 会产生重复实现；
- OpenCode 行为容易被误伤；
- Core 与 Pi RPC 紧耦合；
- 新增后端时无法复用；
- `/help` 难以按后端动态生成。

## 4.2 推荐：Agent Command Provider

在 Agent Adapter 旁增加可选命令能力：

```ts
export interface AgentCommandDescriptor {
  name: string;
  aliases?: string[];
  description: string;
  argumentHint?: string;
  scope: "session" | "runtime";
  requiresActiveSession: boolean;
}

export interface AgentCommandInvocation {
  name: string;
  rawArgs: string;
}

export interface AgentCommandContext {
  clientSessionId: string;
  agentSessionId: string;
}

export type AgentCommandResult =
  | {
      handled: true;
      messages?: Array<{
        text?: string;
        attachments?: OutboundAttachment[];
      }>;
    }
  | {
      handled: false;
    };

export interface AgentCommandProvider {
  listCommands(): Promise<AgentCommandDescriptor[]> | AgentCommandDescriptor[];
  executeCommand(
    invocation: AgentCommandInvocation,
    context: AgentCommandContext,
  ): Promise<AgentCommandResult>;
}
```

在 `AgentAdapter` 中增加可选能力：

```ts
export interface AgentAdapter {
  // existing methods...
  commandProvider?: AgentCommandProvider;
}
```

或者使用方法形式：

```ts
getCommandProvider?(): AgentCommandProvider;
```

推荐方法形式，可避免可变 public property。

### 4.2.1 后端行为

Pi：

```ts
class PiCodingAgentAdapter implements AgentAdapter {
  getCommandProvider(): AgentCommandProvider {
    return this.#piCommandProvider;
  }
}
```

OpenCode 第一阶段：

```ts
class OpenCodeAgentAdapter implements AgentAdapter {
  // 不实现 getCommandProvider()
}
```

因此 Pi-only 命令在 OpenCode runtime 上自然不可见、不可调用。

未来 OpenCode 需要专属命令时，可实现自己的 provider：

```ts
getCommandProvider(): AgentCommandProvider {
  return this.#openCodeCommandProvider;
}
```

二者互不依赖。

## 4.3 通用命令与专属命令边界

已有通用 typed events 继续保留：

```ts
command.session.new
command.session.compact
command.session.stop
command.session.status
command.session.model.list
command.session.model.set
```

原因：这些能力 Pi 和 OpenCode 都已经支持，且是 Gateway Core 生命周期的一部分。

Pi 新增命令不要逐个扩展 `ClientOutputEvent` 为几十个 union variant。建议只增加一个通用扩展事件：

```ts
| {
    type: "command.agent.invoke";
    clientSessionId: string;
    name: string;
    rawArgs: string;
  }
```

但 IM Adapter 在解析时并不知道当前 Agent command provider 的命令集合。为避免误识别，推荐采用下一节的两阶段解析。

---

## 5. 两阶段命令路由

### 5.1 第一阶段：IM/Bridge 命令

IM Adapter 只解析：

- Bridge 固有命令；
- Scheduler/Queue 命令；
- 本地模式命令；
- `/help`。

未知 Slash Command 保持为普通 `user.message` 进入 Core。

### 5.2 第二阶段：Core 查询当前 Agent Provider

在 `GatewayCore.#handleUserMessage()` 调用 Agent `input()` 之前：

```ts
if (text.startsWith("/")) {
  const handled = await this.#tryHandleAgentCommand(clientSessionId, text);
  if (handled) return;
}
```

伪代码：

```ts
async #tryHandleAgentCommand(
  clientSessionId: string,
  text: string,
): Promise<boolean> {
  const invocation = parseAgentCommandInvocation(text);
  if (!invocation) return false;

  const runtime = await this.#getActiveRuntime(clientSessionId);
  if (!runtime) {
    // 仅当命令名能被 module-level manifest 识别时返回“无活动会话”。
    // 否则继续作为 prompt template/skill/extension command 交给 Pi。
    return false;
  }

  const provider = runtime.agentAdapter.getCommandProvider?.();
  if (!provider) return false;

  const commands = await provider.listCommands();
  if (!matches(commands, invocation.name)) return false;

  const result = await provider.executeCommand(invocation, {
    clientSessionId,
    agentSessionId: runtime.agentSessionId,
  });

  if (!result.handled) return false;
  for (const message of result.messages ?? []) {
    await this.#deliverClientInput({
      type: "assistant.message",
      clientSessionId,
      text: message.text ?? "",
      attachments: message.attachments,
    });
  }
  return true;
}
```

### 5.3 防止吞掉 Pi 动态命令

Pi 还支持：

- Extension commands，例如 `/mycommand`
- Prompt templates，例如 `/review`
- Skill commands，例如 `/skill:pdf-tools`

它们必须继续通过 RPC `prompt` 交给 Pi 展开或执行。因此：

- Core 只消费 command provider 明确声明的固定命令；
- 未匹配的 Slash Command原样转发给 `AgentAdapter.input(user.message)`；
- 不允许使用“所有 `/xxx` 都当控制命令”的策略。

### 5.4 无活动 Session 的问题

`/thinking`、`/session` 等命令要求已有 runtime。若当前没有 runtime，Core 仍需要知道该命令是否为 Pi-only，才能返回准确提示。

有两种设计：

#### 方案 A：Module-level Command Manifest（推荐）

在 `AgentModule` 增加：

```ts
getCommandManifest?(): AgentCommandDescriptor[];
```

Pi module 返回静态描述，执行仍由 active adapter provider 完成。

Core 可在无 runtime 时：

- 识别 `/thinking`；
- 回复“当前没有活动 Pi 会话，请先发送消息或使用 `/new`”；
- 不隐式创建会话。

OpenCode module 不声明 Pi 命令，因此不会误提示。

#### 方案 B：只在有 runtime 时识别

实现更小，但无 runtime 时 `/thinking` 会被当作普通 prompt 发送，并可能隐式创建 Agent 会话，不符合预期。

因此推荐方案 A。

---

## 6. Help 与命令发现

## 6.1 `/help`

当前 `/help` 在 IM Adapter 本地直接返回静态文本，这会导致所有 Agent 后端看到相同帮助。

建议拆分：

```text
Bridge common commands
+ local-control commands
+ active/configured Agent module command manifest
```

新增 callback：

```ts
export type OnListAgentCommands = (
  clientSessionId: string,
) => Promise<AgentCommandDescriptor[]>;
```

`ChannelRunner` 将 callback 从 Gateway Core 注入 IM Adapter。

或者将 `/help` 从 Adapter 移到 Core，由 Core 根据：

- client module
- agent module
- runtime capability

动态渲染。长期推荐移到 Core。

Pi 通道帮助中显示：

```text
Pi commands:
/session
/name <name>
/thinking [level]
/compact [instructions]
/commands
/steer <message>
/follow-up <message>
/clone
/fork [entry-id]
/resume [session]
/export [path]
/last
/auto-compact [on|off]
/retry [on|off]
```

OpenCode 通道不得显示这些 Pi-only 项。

## 6.2 `/commands`

`/commands` 是 Pi-only 的动态命令发现命令，应组合两类结果：

1. Pi command provider 的增强控制命令；
2. Pi RPC `get_commands` 返回的 extension/template/skill commands。

建议输出分组：

```text
Pi control commands
- /thinking [level]
- /session
- /name <name>
...

Extensions
- /my-command — description

Prompt templates
- /review [focus] — Review code

Skills
- /skill:pdf-tools — PDF processing
```

内置 TUI 命令不应伪装为可执行命令。Pi 文档明确说明，`get_commands` 不包含 `/model`、`/settings` 等内置 TUI command。

---

## 7. Pi Command Provider 设计

推荐文件：

```text
src/modules/agent/pi-coding-agent/commands/
├── pi-command-provider.ts
├── pi-command-manifest.ts
├── command-parser.ts
├── session-selection.ts
├── renderers.ts
└── *.test.ts
```

Pi RPC 扩展：

```text
src/modules/agent/pi-coding-agent/adapter/pi-rpc-client.ts
```

Pi Adapter capability 转发：

```text
src/modules/agent/pi-coding-agent/adapter/pi-coding-agent-adapter.ts
```

通用接口：

```text
src/types.ts
src/core/gateway-core.ts
```

---

## 8. 命令详细设计

## 8.1 `/compact [instructions]`

### 当前缺口

agent-bridge 只识别：

```text
/compact
/c
```

Pi RPC 已支持：

```json
{
  "type": "compact",
  "customInstructions": "Focus on code changes"
}
```

### 设计

通用事件扩展为：

```ts
| {
    type: "command.session.compact";
    clientSessionId: string;
    customInstructions?: string;
  }
```

Agent input：

```ts
| {
    type: "command.session.compact";
    customInstructions?: string;
  }
```

Pi Adapter 透传 instructions。

OpenCode 隔离行为：

- OpenCode 当前 `summarize(sessionID, model)` 不支持自定义 instructions；
- 无 instructions 时维持现有 behavior；
- 有 instructions 时应显式返回 capability unsupported，或由 OpenCode Adapter 忽略但明确提示；
- 不应静默假装已使用 instructions。

更严谨的 capability：

```ts
compactCapabilities?: {
  customInstructions: boolean;
};
```

`/compact` 是通用命令，不属于 Pi-only，但“custom instructions”是 provider capability。

## 8.2 `/thinking [level]`、`/effort [level]`

Pi RPC：

```text
get_available_thinking_levels
set_thinking_level
get_state
```

行为：

```text
/thinking
/effort
/thinking high
/effort xhigh
```

无参数：返回当前等级和当前模型支持等级。

有参数：

1. lowercase normalization；
2. 每次实时查询当前模型可用 levels；
3. 校验后调用 `set_thinking_level`；
4. 返回实际设置值。

Pi-only 原因：当前 OpenCode Adapter 未暴露动态 thinking-level API。OpenCode 通道不显示、不消费该命令。

## 8.3 `/session`

组合：

```text
get_state
get_session_stats
```

返回：

- session name
- session ID
- session file
- provider/model
- thinking level
- message count
- pending message count
- token input/output/cache
- cost
- context usage
- auto compaction state
- steering/follow-up mode

必须对缺失字段兼容，不能假设每个 provider 都报告 cost/cache。

## 8.4 `/name <name>`

Pi RPC：

```text
set_session_name
```

语法：

```text
/name Refactor authentication
/name -
```

建议 `/name -` 清空名称；需确认 Pi RPC 以空字符串清名的语义。如果 Pi 不支持清空，则只支持设置。

输入限制：

- trim；
- 最大 200 字符；
- 禁止控制字符；
- 不把名称写入日志全文。

## 8.5 `/commands`

Pi RPC：

```text
get_commands
```

返回 extension、prompt template、skill commands，并与 Pi command manifest 合并。

不执行命令，只发现。

## 8.6 `/steer <message>`

Pi RPC：

```text
steer
```

行为：将消息排入 steering queue，在当前 assistant turn 的工具调用结束后、下一次模型调用前送达。

要求：

- 仅 active/busy session；
- 空参数返回 usage；
- 支持图片时，需要扩展入站附件到 Pi ImageContent；
- RPC 失败时不回退为普通 prompt，避免语义改变。

## 8.7 `/follow-up <message>`

Pi RPC：

```text
follow_up
```

行为：Agent 完全结束后再处理。

要求同 `/steer`。建议别名：

```text
/fu <message>
```

不要与 agent-bridge queue files 混淆；文档应说明它是 Pi 当前会话的内存消息队列。

## 8.8 `/clone`

Pi RPC：

```text
clone
```

复制当前 active branch 到新 Pi session 文件。

关键问题：Pi RPC clone 后，Pi 进程内部 session 已切换。agent-bridge 持久化的 Pi session binding/path 也必须更新，否则服务重启会恢复旧 session。

因此命令成功后必须：

1. 调用 `get_state` 获取新 session ID/file；
2. 原子更新 `PiCodingAgentSessionStateV1`；
3. 保持 Core agentSessionId 不变，provider session ID/path 更新；
4. 回复新 session 信息。

## 8.9 `/fork`

Pi RPC：

```text
get_fork_messages
fork(entryId)
```

交互建议：

```text
/fork
```

返回最近可 fork 用户消息及稳定 entry ID：

```text
1. [abc123] Implement attachment support...
2. [def456] Fix tests...

使用 /fork <entry-id>
```

执行：

```text
/fork abc123
```

不建议只允许数字索引，因为列表可能在并发消息后变化。如果支持数字，应保存带 TTL 的 selection snapshot，并校验 session leaf 未变化。

成功后的 session state 更新要求与 `/clone` 相同。

## 8.10 `/resume`

Pi RPC 有：

```text
switch_session
```

但没有“列举所有 session”的 RPC 命令。agent-bridge 需要使用 Pi session manager/目录扫描列举。

交互：

```text
/resume
/resume <session-id>
/resume <absolute-session-path>
```

安全要求：

- 只允许配置 `sessionDir` 下的 JSONL；
- path 必须 realpath 校验；
- partial ID 必须唯一；
- session 工作目录必须通过现有 allowed roots；
- 切换成功后更新持久化 Pi session state；
- 不接受任意系统 JSONL 路径。

如果无法安全确定 session cwd，应拒绝，不要默认信任。

## 8.11 `/export [path]`

Pi RPC：

```text
export_html
```

无参数：

- 导出到 agent-bridge 临时目录；
- 通过 IM `OutboundAttachment` 发送；
- IM 上传完成后删除临时文件。

有 path：

- 相对当前 Pi working directory；
- 必须通过 allowed roots；
- 用户指定路径视为持久文件，发送后不删除。

返回 attachment 不能由 Agent Adapter 直接操作 FeishuClient，应使用通用 `AgentCommandResult.attachments`，由 Gateway Core 和 IM Adapter 正常发送。

## 8.12 `/last`

Pi RPC：

```text
get_last_assistant_text
```

返回最后一条 assistant 文本。它替代 TUI `/copy`：远程 Bridge 无法把文本写入用户设备剪贴板。

建议：

```text
/last
/last file
```

- 默认重新发送纯文本；
- `file` 可生成临时 `.txt` 附件并在发送后清理。

## 8.13 `/auto-compact [on|off]`

Pi RPC：

```text
get_state.autoCompactionEnabled
set_auto_compaction
```

行为：

```text
/auto-compact
/auto-compact on
/auto-compact off
```

无参数查询；有参数设置。

## 8.14 `/retry [on|off]`

Pi RPC：

```text
set_auto_retry
abort_retry
```

建议：

```text
/retry on
/retry off
/retry-stop
```

如果 `get_state` 不返回 autoRetryEnabled，则 `/retry` 无参数不能可靠查询，应只返回 usage 或在 Pi RPC 增加查询字段。不能由 Bridge 自行缓存后声称是 authoritative state。

## 8.15 `/model-next`

Pi RPC：

```text
cycle_model
```

返回：

- 新 provider/model
- thinking level
- 是否 scoped

这是 Pi-only 便利命令。现有通用 `/model` 继续保留。

## 8.16 `/thinking-next`

Pi RPC：

```text
cycle_thinking_level
```

返回新 level。模型不支持 thinking 时返回明确提示。

## 8.17 `/tree`

Pi RPC：

```text
get_tree
get_entries
```

第一阶段只实现只读树：

```text
/tree
/tree 2
```

输出应限制节点和文本长度，可分页。

当前 Pi RPC 没有通用 `navigate_tree(entryId)`，因此不能宣称完整实现 Pi TUI `/tree`。完整导航需要先扩展 Pi RPC。

---

## 9. PiRpcClient 扩展

当前 agent-bridge 的 `PiRpcCommand` 只包含少量 RPC：

```text
prompt
abort
compact
get_last_assistant_text
get_state
get_session_stats
get_available_models
set_model
set_session_name
```

需按功能增加：

```ts
type PiRpcCommand =
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "set_thinking_level"; level: string }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "steer"; message: string; images?: PiImage[] }
  | { id?: string; type: "follow_up"; message: string; images?: PiImage[] }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_entries"; since?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" };
```

不要把所有 response `data` 保持为 `unknown` 后到处强制断言。建议定义每个命令的 response map：

```ts
interface PiRpcResponseDataMap {
  get_state: PiState;
  get_session_stats: PiSessionStats;
  get_commands: { commands: PiDynamicCommand[] };
  // ...
}
```

并提供泛型：

```ts
async send<K extends keyof PiRpcResponseDataMap>(
  command: PiRpcCommandFor<K>,
): Promise<PiRpcResponseDataMap[K]>;
```

运行时仍须验证外部进程返回数据，推荐使用手写 type guards 或 schema validator。

---

## 10. Extension UI 隔离

Pi extension command 可能通过 RPC 发出：

```text
extension_ui_request
```

方法包括：

- `select`
- `confirm`
- `input`
- `editor`
- `notify`
- `setStatus`
- `setWidget`
- `setTitle`
- `set_editor_text`

第一阶段 `/commands` 可以列出 extension commands，但执行需要交互 UI 的命令可能超时。

建议分阶段：

### Phase 1

- 支持不需要交互 UI 的 extension commands；
- 收到 dialog request 时明确回复“不支持此交互”，并发送 cancelled response，不能让 Pi 永久等待。

### Phase 2

- 将 `select/confirm` 映射为 IM card；
- 将 `input/editor` 映射为带 request ID 的下一条消息；
- request state 按 `clientSessionId + requestId` 隔离；
- 超时后自动取消。

OpenCode 的 permission/question 流程继续使用现有 OpenCode Runtime 逻辑，不复用 Pi `extension_ui_request` 类型。

---

## 11. 名称冲突策略

优先级必须固定：

1. Bridge 保留命令；
2. Local-control 命令；
3. Agent provider command；
4. Agent 动态 extension/template/skill command；
5. 普通 prompt。

Bridge 保留命令集合：

```text
help
new
stop
status
model
compact
schedule-run
schedule-here
queue-here
agent
ssh
upload
upload-cancel
download
```

Pi provider 不得注册这些名称。

如果 Pi extension 注册 `/status` 等冲突名称：

- Bridge 命令优先；
- `/commands` 标注 dynamic command 被遮蔽；
- 日志 warning；
- 不提供绕过保留命令的隐藏语法，除非未来设计 `/pi-command <name>`。

---

## 12. 状态一致性

### 12.1 Core ID 与 Provider Session ID

agent-bridge 的 `agentSessionId` 是 Core-owned ID；Pi session ID/file 是 Adapter-owned state。执行以下命令可能改变 Pi provider session：

- `/clone`
- `/fork`
- `/resume`

必须保持：

```text
clientSessionId -> core agentSessionId
core agentSessionId -> latest Pi provider session state
```

不能把 Pi 新 session ID 直接替换 Core ID，否则绑定、idle timer、scheduler output routing 可能失效。

### 12.2 原子更新

Provider 切换成功后：

1. 获取 Pi 最新 state；
2. 验证新 session path/cwd；
3. 原子更新 adapter-owned persisted state；
4. 更新内存字段；
5. 回复成功。

持久化失败时：

- 尝试切回旧 session，或
- 明确返回“切换成功但持久化失败，服务重启可能恢复旧会话”；
- 不静默成功。

### 12.3 并发

每个 client session 的控制命令应串行：

- `/clone` 与 `/resume` 不得并发；
- `/fork` 列表 snapshot 与执行需要 leaf/version 校验；
- busy agent 时是否允许 session switch，应遵循 Pi RPC 结果，不自行强制；
- destructive session switch 建议先 abort 或明确拒绝 busy 状态。

---

## 13. 安全设计

### 13.1 不远程暴露的 Pi 命令

默认不实现：

```text
/login
/logout
/trust
/settings
/reload
/quit
/share
/import
/llama
```

原因：

- credential 泄漏或修改；
- 项目信任与任意 extension 执行；
- 远程终止服务；
- 上传外部数据；
- 导入不可信 session；
- 大型模型下载/GPU 管理。

### 13.2 Export/Resume 路径

- `export` 用户路径受 allowed roots；
- `resume` 只允许 Pi sessionDir；
- realpath + boundary check；
- 禁止字符串 `startsWith` 判断目录边界；
- 临时 export 在 IM 上传完成后删除；
- 用户指定 export 保留。

### 13.3 日志

不得记录：

- 完整 prompt；
- session 内容；
- API Key、OAuth token；
- Authorization header；
- 完整 RPC 错误对象。

只记录命令名、session IDs 的安全短格式、状态和精简错误。

---

## 14. OpenCode 不回归保证

必须增加以下测试：

### 14.1 命令可见性

- Pi manifest 包含 `/thinking`、`/session` 等；
- OpenCode manifest 不包含 Pi-only 命令；
- OpenCode `/help` 不显示 Pi-only 命令。

### 14.2 路由隔离

OpenCode 通道收到：

```text
/thinking high
/session
/clone
```

预期策略需要明确选择一种：

#### 推荐策略：保留 Slash Command 错误

如果文本看起来是已知其他后端命令，但当前后端不支持，回复：

```text
当前 Agent（OpenCode）不支持命令 /thinking。
```

不能转发给 OpenCode 模型，避免模型误以为用户提出自然语言任务。

为此，Core 需要全局 command catalog 知道命令存在，但只允许所属 provider 执行：

```ts
interface AgentCommandDescriptor {
  owner: string; // "pi-coding-agent"
  ...
}
```

如果不希望 Core 知道其他 module catalog，可以采用更简单策略：OpenCode 未匹配时原样转发；但用户体验和安全性较差。

建议 ChannelRunner 持有当前 configured AgentModule，并只识别当前 module manifest；同时维护 Bridge reserved command list。对于 Pi-only 命令在 OpenCode 中，可统一回复“未知命令”，不必泄露 Pi command catalog。

### 14.3 通用命令回归

Pi 与 OpenCode 都必须通过：

- `/new`
- `/compact`
- `/stop`
- `/status`
- `/model`
- scheduler/queue commands

其中 `/compact instructions` 在 OpenCode 上必须正确报告“不支持自定义指令”，而无参数 `/compact` 保持成功。

### 14.4 类型隔离

CI 增加规则或 review 检查：

- `src/core/**` 不 import `pi-coding-agent/**`；
- `src/modules/client/**` 不 import Pi RPC 类型；
- `src/modules/agent/opencode/**` 不 import Pi command provider；
- Pi-only 类型位于 Pi module 内部，通用层只见 capability interface。

---

## 15. 测试计划

## 15.1 Command Provider 单元测试

- manifest 名称和 alias 唯一；
- Bridge reserved names 不可注册；
- 参数 parser 保留空格和 Unicode；
- 不匹配命令返回 handled false；
- 执行结果转成通用 assistant messages/attachments。

## 15.2 Pi 命令测试

- `/thinking` 查询与设置；
- `/effort` alias；
- 模型切换后 levels 动态变化；
- `/session` 缺失字段；
- `/name` 验证；
- `/commands` 分组；
- `/steer`、`/follow-up` busy/idle 行为；
- `/compact instructions` 透传；
- `/clone`、`/fork`、`/resume` state 更新；
- `/export` 临时文件清理；
- `/last` 无历史；
- `/auto-compact` 查询与设置；
- `/retry` 设置；
- `/tree` 分页和截断。

## 15.3 OpenCode 回归测试

- 不构造 PiRpcClient；
- 不调用 Pi command provider；
- help 不显示 Pi-only 命令；
- 通用 status/model/compact/stop 正常；
- Pi-only slash command 返回未知/不支持，不触发 OpenCode API；
- OpenCode permission/question 流程不变。

## 15.4 IM 无关性测试

同一 Pi command provider 在：

- Feishu
- WeCom
- Weixin

应得到相同 command result；只有渲染和 attachment transport 不同。

## 15.5 集成测试

使用真实 Pi RPC 子进程：

1. 创建 Pi session；
2. `/name`；
3. `/thinking high`；
4. `/session`；
5. `/compact custom instructions`；
6. `/commands`；
7. `/clone`；
8. `/export` 并验证附件；
9. 重启 Bridge，验证恢复 clone 后 session；
10. 同时启动 OpenCode channel，验证没有 Pi command 泄漏。

---

## 16. 推荐实施阶段

### Phase 1：能力框架与低风险命令

- AgentCommandProvider interface
- Module-level manifest
- Core 两阶段路由
- 动态 `/help`
- `/thinking`、`/effort`
- `/session`
- `/name`
- `/compact [instructions]`
- OpenCode 隔离测试

### Phase 2：Pi 队列与动态命令

- `/commands`
- `/steer`
- `/follow-up`
- extension UI 非交互降级
- `/auto-compact`
- `/retry`

### Phase 3：Session 操作

- `/clone`
- `/fork`
- `/resume`
- provider session state 原子更新
- `/tree` 只读版

### Phase 4：文件输出

- `/export`
- `/last file`
- 临时 attachment 生命周期统一管理

---

## 17. 推荐提交拆分

```text
refactor(core): add provider-scoped agent command capabilities
refactor(client): render help from bridge and agent command manifests
feat(pi): expose thinking and detailed session commands
feat(pi): support compact instructions and session naming
feat(pi): bridge dynamic commands and message queues
feat(pi): add clone fork and resume session controls
feat(pi): export sessions as outbound attachments
fix(opencode): reject unsupported provider-specific commands without regression
test: verify pi and opencode command isolation
```

避免一个超大 PR 同时修改 Core、三个 IM Adapter、Pi、OpenCode 和文件传输。

---

## 18. 验收标准

实现完成必须满足：

1. Pi 通道能查询到 Pi 增强命令；
2. OpenCode 通道不显示 Pi-only 命令；
3. OpenCode 执行路径不 import、不构造、不调用 Pi RPC；
4. 未匹配的 Pi extension/template/skill command 仍能通过 `prompt` 执行；
5. `/compact [instructions]` 在 Pi 上完整透传，在 OpenCode 上显式 capability 降级；
6. `/thinking` 每次按当前 Pi 模型动态校验等级；
7. `/clone`、`/fork`、`/resume` 后持久化 provider session state 正确；
8. `/export` 临时文件发送后清理；
9. `/help` 按当前 Agent module 动态生成；
10. 所有 Pi-only 命令均有无 active session、busy、RPC error 测试；
11. OpenCode 原有 `/new`、`/compact`、`/stop`、`/status`、`/model`、permission/question 流程全部通过回归测试；
12. Core 与 IM Adapter 不包含 Pi-specific RPC 类型。

---

## 19. 最终建议命令表

### Bridge 通用

```text
/help
/new [working-directory]
/compact [instructions]
/stop
/status
/model [provider/model]
/schedule-run <task>
/schedule-here <task>
/queue-here <queue>
```

### 可选本地控制

```text
/agent
/ssh
/upload
/upload-cancel
/download <path>
```

### Pi-only

```text
/thinking [level]
/effort [level]
/session
/name <name>
/commands
/steer <message>
/follow-up <message>
/clone
/fork [entry-id]
/resume [session]
/export [path]
/last
/auto-compact [on|off]
/retry <on|off>
/retry-stop
/model-next
/thinking-next
/tree [page]
```

### 默认不远程开放

```text
/login
/logout
/trust
/settings
/reload
/quit
/share
/import
/llama
```

本设计的核心原则是：**通用生命周期能力留在 Gateway Core；Pi 的附加能力通过 AgentCommandProvider 暴露；OpenCode 不实现该 Provider 即天然隔离；IM Adapter 永远不直接依赖 Pi RPC。**
