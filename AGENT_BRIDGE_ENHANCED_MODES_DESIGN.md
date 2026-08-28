# Agent Bridge 增强功能设计：`/effort` 与 SSH 文件传输

- 文档状态：Draft
- 面向项目：[HoPGoldy/agent-bridge](https://github.com/HoPGoldy/agent-bridge)
- 基准版本：`@hopgoldy/agent-bridge 0.8.6`
- 目标实现：修改 TypeScript 源码，不依赖安装后修改 `dist/*.js`

## 1. 背景与目标

本文设计两个相互独立的增强功能：

1. 增加 `/effort`（别名 `/thinking`）命令，用于查询和动态切换当前 Agent 会话的思考等级。
2. 增加 `/agent`、`/ssh` 两种聊天模式。SSH 模式提供有状态的远程 Shell，并直接在该模式中支持 `/upload` 和 `/download` 文件传输，不再单独设置 `/file` 模式。

目标行为：

- `/agent`：恢复 agent-bridge 原有消息处理流程。
- `/ssh`：后续普通文本作为 Shell 命令执行，保留当前工作目录并返回执行结果。
- `/upload`：仅在 SSH 模式生效，提示用户发送飞书附件；附件保存到 SSH 当前工作目录。
- `/download <path-or-pattern>`：仅在 SSH 模式生效；路径可为相对路径、绝对路径、目录或 glob。单文件直接发送，目录或多个匹配项临时打包为 `tar.gz` 后发送。
- 下载产生的临时 `tar.gz` 在飞书上传完成后删除；原始文件始终保留。
- `/effort` 与模式无关，建议作为核心命令实现；在 Agent 模式中正常使用，在 SSH 模式中也应优先识别为全局控制命令。

非目标：

- `/ssh` 不实现 SSH 协议、PTY、交互式终端、持续运行的 Bash 进程或 TTY 程序。
- 不支持 `vim`、`top`、`sudo` 密码输入等交互式命令。
- 不提供独立 `/file` 模式。
- 不允许未经授权的聊天启用远程 Shell。

---

## 2. 用户交互规范

### 2.1 全局命令优先级

所有入站消息按以下优先级处理：

1. 授权和群聊 mention 策略；
2. 全局模式命令：`/agent`、`/ssh`；
3. 全局 Agent 控制命令：`/effort`、`/thinking`、`/help`、`/status` 等；
4. SSH 模式本地命令：`/upload`、`/upload-cancel`、`/download`；
5. 若当前为 SSH 模式，普通文本作为 Shell 命令；
6. 若当前为 Agent 模式，按原有流程交给 Gateway Core 和 Agent。

注意：必须避免在 SSH 模式下把 `/effort high` 当作 Shell 路径或可执行文件。

### 2.2 `/effort`

查询当前思考等级：

```text
/effort
```

建议回复：

```text
思考等级

- 当前：medium
- 可用：off / minimal / low / medium / high / xhigh

使用 /effort <等级> 切换。
```

切换等级：

```text
/effort high
```

成功回复：

```text
思考等级已切换为 high。
```

别名：

```text
/thinking
/thinking high
```

错误行为：

- 当前会话尚未创建：提示先发送普通 Agent 消息或使用 `/new`；不应为了查询 effort 隐式创建会话。
- Agent 适配器不支持动态 effort：返回“当前 Agent 不支持动态调整思考等级”。
- 等级无效：列出当前模型实际支持的等级。
- RPC 调用失败：返回精简错误，不泄露 Token、Secret、完整请求对象。

模型切换后：可用等级可能发生变化，必须每次从 Pi RPC 查询，不能使用全局静态列表。

### 2.3 `/agent`

```text
/agent
```

行为：

- 当前聊天切换为 Agent 模式；
- 取消待上传状态；
- 不销毁现有 Agent 会话；
- 不重置 SSH 当前目录，以便以后 `/ssh` 恢复；
- 回复：

```text
已切换到 Agent 模式。
```

### 2.4 `/ssh`

```text
/ssh
```

行为：

- 仅对配置 allowlist 中的聊天开放；
- 建议默认只允许私聊，群聊默认拒绝；
- 切换到 SSH 模式；
- 初次进入时 cwd 为配置的 `defaultWorkingDirectory`；
- 再次进入时恢复该聊天此前的 SSH cwd；
- 回复当前目录和基本帮助：

```text
已切换到 SSH 模式。
当前目录：/workspace

输入 Shell 命令执行；可使用：
- /upload
- /upload-cancel
- /download <路径、目录或通配符>
- /agent
```

### 2.5 Shell 命令

SSH 模式中的普通消息：

```text
cd project && ls -lah
```

建议通过一次非交互 Bash 调用执行：

```bash
/bin/bash -lc '<command>; capture status and $PWD'
```

回复格式：

```text
exit 0

<命令 stdout/stderr>

当前目录：/workspace/project
```

语义要求：

- 每条消息启动一个新的非交互 Bash，而不是维护长期 Shell 子进程；
- 通过命令末尾的唯一 marker 回传 `$PWD`，从而跨消息保存 cwd；
- 只有新 cwd 经 canonical path 校验且位于 `allowedRoots` 内时才更新状态；
- stdout 与 stderr 都返回，建议保留顺序；若实现成本较高，至少明确标注两者；
- 默认超时 120 秒；
- 默认最大返回 64 KiB，超出截断并提示；
- 禁止将命令原文、环境变量、访问令牌完整写入 info 日志；
- 服务停止时应终止正在运行的子进程。

命令本身仍具有服务用户权限。`allowedRoots` 只能可靠限制 cwd 和文件传输路径，不能阻止用户通过 Shell 命令读取其他可读路径。因此 `/ssh` 是“远程代码执行能力”，必须依赖聊天 allowlist 和 OS/systemd 沙箱，而不能宣称仅靠路径检查已经完成 Shell 沙箱化。

### 2.6 `/upload`

仅在 SSH 模式中生效：

```text
/upload
```

行为：

1. 将当前聊天状态设置为 `awaitingUpload=true`；
2. 将上传目标固定为执行 `/upload` 时的 canonical cwd；
3. 提示用户发送飞书附件：

```text
请发送文件，文件将保存到：/workspace/project
发送 /upload-cancel 取消。
```

用户下一条或后续多条附件消息：

- 将飞书资源下载到 agent-bridge 的临时目录；
- 对文件名执行 `basename` 和安全净化，禁止 `/`、`\`、NUL 和 `..` 路径穿越；
- 将文件复制或原子移动到固定上传目标；
- 默认建议“不覆盖”：若同名文件存在，使用 `name (1).ext`，或者返回冲突错误；如需覆盖，应增加显式配置 `overwriteUploads`，默认 `false`；
- 成功后回复保存路径和大小；
- 可支持连续上传，直到 `/upload-cancel`、`/agent` 或 `/ssh` 重置；也可配置 `uploadSingleShot=true`。建议默认连续上传，交互更适合飞书逐个发送多个附件。

示例：

```text
上传完成：
- subtitle.srt → /workspace/project/subtitle.srt
- notes.txt → /workspace/project/notes.txt
- image.png → /workspace/project/image.png
```

取消：

```text
/upload-cancel
```

关键状态语义：上传目标必须在 `/upload` 时固定，不能因为并发 Shell 命令改变 cwd 而漂移。

若收到附件但不处于 awaiting-upload 状态：

- Agent 模式：保持原有 Agent 附件行为；
- SSH 模式：回复“请先发送 `/upload`”，不要把 `<file ...>` 等标准化占位文本当作 Shell 命令。

飞书权限要求：应用身份至少开通以下之一，建议最小权限：

```text
im:message:readonly
```

资源下载端点：

```text
GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image|file
```

资源类型映射：

- image → `image`
- file/audio/video → `file`

不能把 `audio` 或 `video` 原样传给该接口的 `type` 参数。

### 2.7 `/download`

仅在 SSH 模式中生效：

```text
/download README.md
/download ./results/*.csv
/download /data/project/output
```

路径规则：

- 相对路径：相对于该聊天当前 SSH cwd；
- 绝对路径：直接解析，但必须位于配置允许的文件根目录；
- 支持 glob：`*`、`?`、`[]`、`**` 是否支持应由选定 glob 库明确决定；建议使用 Node glob 库，不要用 `shell=true` 拼接用户字符串；
- 对每个匹配结果执行 `realpath`，防止符号链接逃逸 `allowedRoots`；
- 不存在或无匹配时返回明确错误。

发送策略：

1. 仅匹配一个普通文件：直接作为飞书原生附件发送。
2. 匹配目录、多个文件或多个路径：生成临时 `tar.gz` 后发送。
3. 单个原文件超过默认 100 MiB：忽略，并在结果中列出。
4. 最终压缩包超过默认 100 MiB：不发送并删除临时压缩包。
5. 飞书附件发送 Promise 成功完成后，在 `finally` 中删除**本次命令生成的临时 tar.gz**。
6. 无论成功、失败或超时，都不得删除任何原始文件。

推荐临时文件布局：

```text
${os.tmpdir()}/agent-bridge-download-<random>/download-<timestamp>.tar.gz
```

伪代码：

```ts
const tempDir = await mkdtemp(join(tmpdir(), "agent-bridge-download-"));
const archivePath = join(tempDir, makeArchiveName());
try {
  await createArchive(resolvedFiles, archivePath);
  await assertSizeAtMost(archivePath, maxTransferBytes);
  await imClient.sendAttachment(chatId, {
    kind: "file",
    filePath: archivePath,
    fileName: basename(archivePath),
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
```

重要：`sendAttachment()` 必须在飞书 SDK 已完成文件上传后才 resolve；否则不能立即删除 tar。应通过集成测试确认 SDK 的 Promise 生命周期。

压缩包内容路径：

- 禁止把绝对路径直接写入 archive；
- 为所有匹配项计算一个安全公共基准目录，使用相对路径打包；
- glob 匹配多个不同根时，可在 archive 内建立明确的相对层级或使用净化后的顶层名称；
- 文件重名时不得静默覆盖。

---

## 3. 架构设计

### 3.1 模块边界

建议新增通用“聊天本地模式”层，而不是把全部逻辑堆入 `FeishuIMAdapter`：

```text
src/modules/client/modes/
├── chat-mode-controller.ts
├── shell-mode.ts
├── shell-session-store.ts
├── file-transfer.ts
├── path-policy.ts
└── *.test.ts
```

飞书专有资源下载仍留在：

```text
src/modules/client/feishu/adapter/feishu-client.ts
```

职责划分：

- `FeishuClient`：把飞书原始资源下载成结构化入站附件；发送出站附件。
- `FeishuIMAdapter`：群聊 mention、聊天授权、命令优先级、模式控制器接入。
- `ChatModeController`：每个 `clientSessionId` 的 agent/ssh 状态机。
- `ShellMode`：执行命令、捕获 cwd、超时和输出限制。
- `FileTransfer`：上传落盘、download 路径展开、临时归档和清理。
- `PathPolicy`：canonical path、allowed roots、symlink 边界检查。
- `GatewayCore`：`/effort` 等 Agent 会话级命令。

如果未来希望微信、企业微信也支持 SSH，可复用 modes 层；各 IM 适配器只负责把附件标准化。

### 3.2 入站附件类型

当前 `ClientOutputEvent.user.message` 只有 `text`。建议增加通用入站附件：

```ts
export interface InboundAttachment {
  kind: "image" | "file" | "audio" | "video";
  localPath?: string;
  fileName?: string;
  sizeBytes?: number;
  mimeType?: string;
  downloadError?: {
    code?: string | number;
    message: string;
  };
}

export type ClientOutputEvent =
  | {
      type: "user.message";
      clientSessionId: string;
      text: string;
      attachments?: InboundAttachment[];
    }
  | ...;
```

即使下载失败也保留 attachment descriptor，使模式层能回复“收到附件但下载失败”，而不是把附件占位文本误判为 `/download` 路径。

如不希望附件进入 Gateway Core，可以定义适配器内部的 `NormalizedInboundMessage`，由模式控制器先消费；未消费时再将文本和附件转成 Agent 能理解的消息。但长期看通用 `InboundAttachment` 更可扩展。

### 3.3 模式状态

```ts
type ChatMode = "agent" | "ssh";

interface ShellChatState {
  mode: ChatMode;
  cwd: string;
  upload?: {
    targetDirectory: string;
    startedAt: number;
  };
}
```

状态键为完整 `clientSessionId`：

```text
feishu:dm:<chatId>
feishu:group:<chatId>
```

建议：

- 第一版可内存存储；服务重启后回到 Agent 模式。
- 如果持久化，单独定义版本化 codec，不要把临时上传状态持久化。
- `cwd` 持久化前和恢复后都必须重新 canonicalize，并重新应用最新 allowlist。
- Agent 会话状态与 SSH 模式状态相互独立。

### 3.4 并发模型

同一聊天必须串行处理 Shell、上传和下载操作，否则 cwd 和上传目标会竞争。建议每个 `clientSessionId` 使用 Promise queue 或 mutex：

```ts
await sessionQueue.run(clientSessionId, () => handleMessage(message));
```

不同聊天可以并行。

模式切换时：

- `/agent`：取消待上传；可选择终止当前 Shell 子进程，建议终止。
- `/ssh`：不应中断正在运行的 Agent turn；但后续消息不再转发给 Agent。
- `/stop`：在 Agent 模式停止 Agent；在 SSH 模式建议停止当前 Shell 命令。需要在帮助文档中明确，或增加 `/ssh-stop` 避免语义冲突。

---

## 4. `/effort` 源码设计

### 4.1 类型扩展

在 `src/types.ts` 的 `AgentAdapter` 增加可选能力：

```ts
export interface AgentAdapter {
  // existing methods
  getAvailableThinkingLevels?(): Promise<string[]>;
  setThinkingLevel?(level: string): Promise<void>;
}
```

建议也可以将等级定义为 string，而不是硬编码 union，因为不同 provider/model 的等级集合可能不同。

### 4.2 Pi RPC Client

在：

```text
src/modules/agent/pi-coding-agent/adapter/pi-rpc-client.ts
```

增加：

```ts
async getAvailableThinkingLevels(): Promise<string[]> {
  const response = await this.#send({
    type: "get_available_thinking_levels",
  });
  return response.data?.levels ?? [];
}

async setThinkingLevel(level: string): Promise<void> {
  await this.#send({
    type: "set_thinking_level",
    level,
  });
}
```

要求：

- 验证 `levels` 是 string array；
- 对畸形响应返回空数组或抛出类型错误；
- 不在日志中打印整个 RPC 响应。

### 4.3 Pi Agent Adapter

在：

```text
src/modules/agent/pi-coding-agent/adapter/pi-coding-agent-adapter.ts
```

增加能力转发：

```ts
async getAvailableThinkingLevels(): Promise<string[]> {
  if (!this.#client) throw new Error("PiCodingAgentAdapter is not started");
  return this.#client.getAvailableThinkingLevels();
}

async setThinkingLevel(level: string): Promise<void> {
  if (!this.#client) throw new Error("PiCodingAgentAdapter is not started");
  await this.#client.setThinkingLevel(level);
}
```

### 4.4 命令路由

建议 `/effort` 由 Gateway Core 处理，因为它操作活动 Agent runtime，而不是飞书专属行为。

两种实现方式：

A. 推荐：扩展 `ClientOutputEvent`：

```ts
| {
    type: "command.session.effort.get";
    clientSessionId: string;
  }
| {
    type: "command.session.effort.set";
    clientSessionId: string;
    level: string;
  }
```

然后在 `slash-commands.ts` 统一解析，并由 `gateway-core.ts` 处理。

B. 较小改动：让未知 `/effort` 以 `user.message` 到达 Core，再由 Core 正则识别。该方法与当前 `/queue-here` 类似，但类型语义较弱。

正式源码建议采用 A。

Core 处理逻辑：

1. 使用现有 client→agent runtime binding 查找活动会话；
2. 不存在则返回明确提示，不隐式创建；
3. 检查 adapter 是否同时实现 get/set；
4. 查询可用 levels；
5. 无参数：结合 `getStatus().thinkingLevel` 返回当前值和列表；
6. 有参数：normalize 为 lowercase，确认在 levels 中，再 set；
7. 通过现有 `#deliverClientInput()` 返回 `assistant.message`。

### 4.5 `/effort` 测试

至少覆盖：

- `/effort` 与 `/thinking` 解析；
- 查询当前值；
- 合法切换；
- uppercase 输入 normalization；
- 无效等级列出可用值；
- 无活动会话不创建 runtime；
- adapter 不支持能力；
- Pi RPC 错误映射；
- 模型切换后重新查询等级；
- synthetic schedule/queue session 不允许聊天命令注入；
- SSH 模式下 `/effort` 仍优先作为全局命令，而非 Shell 命令。

---

## 5. SSH 与文件传输源码设计

### 5.1 配置

建议在 IM client 配置之外增加明确的本地控制配置。若第一版仅支持飞书，可先放入 `FeishuClientConfig`：

```ts
interface LocalControlConfig {
  enabled?: boolean;                  // default false
  allowedClientSessionIds?: string[]; // required when enabled
  allowGroupChats?: boolean;          // default false
  defaultWorkingDirectory?: string;
  allowedFileRoots?: string[];
  shellTimeoutMs?: number;            // default 120000
  maxShellOutputBytes?: number;       // default 65536
  maxTransferBytes?: number;          // default 104857600
  overwriteUploads?: boolean;         // default false
  uploadSingleShot?: boolean;         // default false
}
```

配置示例：

```json
{
  "client": {
    "type": "feishu",
    "config": {
      "appId": "cli_xxx",
      "appSecret": "...",
      "domain": "feishu",
      "localControl": {
        "enabled": true,
        "allowedClientSessionIds": [
          "feishu:dm:oc_xxx"
        ],
        "allowGroupChats": false,
        "defaultWorkingDirectory": "/workspace",
        "allowedFileRoots": [
          "/workspace",
          "/data/projects"
        ],
        "shellTimeoutMs": 120000,
        "maxShellOutputBytes": 65536,
        "maxTransferBytes": 104857600
      }
    }
  }
}
```

注意：`allowedFileRoots` 约束上传、下载和 cwd，不是完整 Shell 沙箱。真正隔离应通过独立低权限 Unix 用户、容器或 systemd sandbox 完成。

### 5.2 推荐源码文件

```text
src/modules/client/modes/chat-mode-controller.ts
src/modules/client/modes/shell-command-runner.ts
src/modules/client/modes/file-transfer-service.ts
src/modules/client/modes/path-policy.ts
src/modules/client/modes/chat-mode-controller.test.ts
src/modules/client/modes/shell-command-runner.test.ts
src/modules/client/modes/file-transfer-service.test.ts
```

飞书接入修改：

```text
src/modules/client/feishu/adapter/feishu-client.ts
src/modules/client/feishu/adapter/feishu-im-adapter.ts
src/modules/client/feishu/adapter/feishu-im-adapter.test.ts
src/types.ts
src/i18n/locales/*.ts
```

### 5.3 PathPolicy

必须提供：

```ts
interface PathPolicy {
  resolveExisting(input: string, cwd: string): Promise<string>;
  resolveDirectory(input: string, cwd: string): Promise<string>;
  assertAllowed(realPath: string): Promise<void>;
}
```

规则：

- 先 `resolve(cwd, input)`，再 `realpath`；
- allowed root 本身也预先 `realpath`；
- 使用 `path.relative(root, candidate)` 做路径边界判断，不能用字符串 `startsWith`；
- 对上传的新文件，校验目标父目录的 realpath，再拼接净化后的 basename；
- glob 必须先展开，再逐项 realpath 和校验；
- 符号链接目标在 root 外则拒绝；
- TOCTOU 无法仅靠路径检查完全消除；高安全部署应配合 OS sandbox。

### 5.4 ShellCommandRunner

接口建议：

```ts
interface ShellRunResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  cwd: string;
  timedOut: boolean;
  truncated: boolean;
}

interface ShellCommandRunner {
  run(command: string, cwd: string, signal?: AbortSignal): Promise<ShellRunResult>;
}
```

实现注意：

- 使用 `execFile('/bin/bash', ['-lc', script])`，不要使用 `exec(command)`；
- 用户命令作为脚本内容执行是此功能本意，但不要再额外插值到另一层 Shell 字符串；
- marker 必须随机且难以冲突；
- 捕获命令后的 `$PWD` 和 exit status；
- 限制 maxBuffer，并自行处理截断，避免仅得到笼统 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`；
- 使用 AbortController 和 timeout；
- 子进程组清理需要考虑命令启动的后代进程；Linux 下可创建独立 process group 并终止整个组。

### 5.5 FileTransferService

建议接口：

```ts
interface DownloadPlan {
  directFile?: string;
  archive?: {
    path: string;
    displayName: string;
    cleanup(): Promise<void>;
  };
  skipped: Array<{ path: string; reason: string }>;
}

interface FileTransferService {
  saveInboundAttachments(
    attachments: InboundAttachment[],
    targetDirectory: string,
  ): Promise<UploadResult[]>;

  prepareDownload(
    expression: string,
    cwd: string,
  ): Promise<DownloadPlan>;
}
```

Controller 负责：

```ts
const plan = await fileTransfer.prepareDownload(expression, state.cwd);
try {
  if (plan.directFile) await client.sendAttachment(...);
  if (plan.archive) await client.sendAttachment(...);
} finally {
  await plan.archive?.cleanup();
}
```

这能确保只有服务生成的临时文件被清理，原文件不会进入 cleanup 列表。

---

## 6. 飞书附件可靠性修复

现有 `FeishuClient.downloadResource()` 应增强为：

1. 将 API type 映射为 `image` 或 `file`；
2. 下载失败时返回结构化错误，而非只返回 `null`；
3. `channel.on('message')` 的异步 handler 必须 `.catch()` 并记录精简错误；
4. 不把完整 Axios error 对象写入日志，因为其中可能包含 `Authorization: Bearer ...`；
5. 临时文件名使用随机 ID，原始文件名只用于 display name；
6. 下载完成后校验实际大小；
7. 明确临时附件的清理时机。

建议结果类型：

```ts
type ResourceDownloadResult =
  | {
      ok: true;
      attachment: InboundAttachment & { localPath: string };
    }
  | {
      ok: false;
      attachment: InboundAttachment & {
        downloadError: { code?: string | number; message: string };
      };
    };
```

权限错误 `99991672` 应映射成可操作提示：

```text
飞书应用缺少 im:message:readonly 应用身份权限；请开通权限并发布应用版本。
```

不要把失败附件的 `<file key="..."/>`、`![image](...)` 占位文本当作路径或 Shell 命令。

---

## 7. 安全要求

### 7.1 默认关闭

增强模式必须默认关闭：

```text
localControl.enabled = false
```

开启时必须配置非空 allowlist。空 allowlist 应代表“无人授权”，不能代表“允许所有人”。

### 7.2 授权主体

建议 allowlist 使用完整 `clientSessionId`，避免不同平台 ID 碰撞：

```text
feishu:dm:oc_xxx
```

群聊默认禁用。即使群聊要求 mention，也不应自动获得 SSH 权限。

### 7.3 系统隔离

生产部署至少采用：

- 独立 Unix 用户；
- 不授予 sudo；
- systemd `NoNewPrivileges=true`；
- `ProtectSystem=full/strict`；
- 精确 `ReadWritePaths`；
- 可选容器、网络限制和资源限制；
- Secret 只通过受保护配置或环境注入。

### 7.4 日志脱敏

禁止记录：

- App Secret；
- tenant access token；
- Authorization header；
- 完整 Axios request/response；
- 未经净化的敏感文件内容。

只记录：

```text
fileKey=<redacted-or-shortened> status=400 code=99991672
```

---

## 8. 测试计划

### 8.1 `/effort`

- 查询、设置、别名、非法值；
- 无会话、unsupported adapter、RPC failure；
- 模型切换后的动态等级；
- 不隐式创建 Agent 会话；
- SSH 模式中的命令优先级。

### 8.2 Shell

- 首次 cwd、`cd` 后 cwd 持续；
- stdout、stderr、非零退出码；
- 无输出；
- 超时、截断、进程终止；
- cwd 逃逸 allowed roots 时拒绝更新；
- `/agent` 切换后消息恢复到 Agent；
- 未授权聊天和群聊拒绝；
- 同一聊天串行、不同聊天并行。

### 8.3 Upload

- `/upload` 固定当前 cwd；
- txt、srt、png 等多种扩展名；
- 多文件连续上传；
- 文件名路径穿越；
- 同名冲突；
- 超过 100 MiB；
- 下载权限不足的明确提示；
- `/upload-cancel`；
- `/agent` 自动取消；
- 附件未处于 upload 状态时不执行占位文本。

### 8.4 Download

- 相对和绝对单文件；
- 带空格和 Unicode 文件名；
- 目录；
- glob 单匹配和多匹配；
- 无匹配；
- symlink 逃逸；
- 单原文件超过 100 MiB 被跳过；
- archive 超过 100 MiB 不发送；
- 发送成功后删除临时 tar；
- 发送失败后仍删除临时 tar；
- 原文件在所有路径下均保留；
- archive 内无绝对路径和路径穿越。

### 8.5 飞书集成测试

在实际飞书测试：

1. 开通 `im:message:readonly` 应用身份权限；
2. 发布并启用应用新版本；
3. `/ssh`；
4. `pwd`；
5. `/upload`，分别发送 `.srt`、`.txt`、`.png`；
6. `ls -l` 确认保存；
7. `/download <txt>` 确认直接发送；
8. `/download *.srt`；
9. `/download .` 确认 tar 发送；
10. 确认临时 tar 被删除，原文件保留。

---

## 9. 建议提交拆分

为了便于 review 和向上游贡献，建议按以下 commits/PR 拆分：

1. `fix(feishu): make inbound resource downloads reliable and redact errors`
2. `feat(core): add dynamic /effort command and agent capability hooks`
3. `feat(client): add authorized agent/ssh chat mode controller`
4. `feat(client): add upload and download commands to ssh mode`
5. `test: cover shell state, path policy, archive cleanup and Feishu resources`
6. `docs: document remote shell security and Feishu permissions`

其中第 1、2 项较通用，适合单独向上游提交；SSH 和文件管理属于高权限增强，可保留在 enhanced 分支。

---

## 10. 验收标准

实现完成必须满足：

- 不存在 `/file` 模式；
- `/agent` 与 `/ssh` 可按聊天独立切换；
- SSH cwd 跨消息保持；
- `/upload` 将附件保存到调用时的 SSH cwd；
- `/download` 支持相对路径、绝对路径、目录和 glob；
- 单文件直接发送，目录/多匹配打包发送；
- 临时 tar 在发送结束后删除，原文件始终保留；
- 100 MiB 限制生效；
- `/effort` 可查询和切换 Pi 当前模型支持的 thinking level；
- 所有高权限功能默认关闭并受 allowlist 保护；
- 飞书附件权限失败有明确提示；
- 日志不泄露 Authorization token；
- 所有新增逻辑有单元测试，关键飞书流程有端到端测试记录。
