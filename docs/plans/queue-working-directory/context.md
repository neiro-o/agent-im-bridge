# Queue Working Directory（队列工作目录）

## 1. 背景与目标

8/26 midnight-dev 队列事故（`~/project/queues-incident-20260826.md`）的根因之一：队列点火硬编码
`workingDirectory: process.cwd()`（`src/modules/queue/controller.ts:340`），pi 落在 bridge 启动
目录（当时是 home），为找任务书执行了 4 条全盘 `find ~`，踩进挂死容器整夜无声。

对比：scheduled task 早就有 `directory:` front matter 字段（fire 时校验，spec D6），queue 没有。

**目标**：给 queue 引入两级工作目录配置，优先级从高到低：

1. `queue insert --directory <path>` 写入任务文件 front matter 的 `directory:`（任务级，最高优先级）
2. 队列定义 front matter 的 `directory:`（队列级）
3. 都未配置 → 退回现状 `process.cwd()`（bridge 启动目录）

**非目标**（一句话边界）：

- 不改 channel 级默认目录、不动 scheduler（它已有 `directory:`）。
- 不做失败重试、不动 timeout/silence 语义、不做超时杀进程（事故修复的 Bug 3 是独立工作）。
- 不改 front matter 解析器本身（flat `key: value` 子集，无 YAML 依赖）。

## 2. 方案概要（关键决策）

- **D1 字段名统一为 `directory`**：定义与任务两级都叫 `directory`，与 scheduled task 的既有字段
  同名同语义（`nonEmptyString` 解析；`~` 扩展、相对路径解析、存在性校验全部推迟到 fire 时由
  `validateWorkingDirectory` 完成 —— spec D6，存储层不碰文件系统）。用户口语里的 "workspace"
  只是需求描述，落地字段不引入新词。
- **D2 任务级 directory 存在任务文件 front matter**：`queues/<name>.tasks/<taskId>.md` 新增可选
  key `directory:`。`queue insert --directory <path>` 写入；文件系统即 API，手写/手改同样生效。
- **D3 无效目录的两种行为**（对齐既有语义，不发明新失败模式）：
  - 定义级目录无效（fire 时校验失败）→ **该 tick 跳过整个队列 + warn log**，任务保留在 pending
    （与 unbound/disabled 队列“任务堆积、修好自动消化”语义一致）。
  - 任务级目录无效 → **该任务 fail-and-drop**：删任务文件 + 投递错误到 target
    （对齐 queue 既有 fire 失败语义）。
- **D4 CLI 不做文件系统预检**：`queue add` / `queue insert --directory` 均原样落盘，理由照抄
  schedule add —— "the bridge may run elsewhere (spec D6, fire-time validation only)"。
- **D5 `workingDirectorySource` 保持 `"default"`**：队列定义/任务文件是操作者本地配置（文件系统
  即 API），与 schedule task 的 `directory` 同为 trusted configuration，不进 user-path allowlist
  （`docs/command-system.md:184`）。

## 3. 公共上下文（开工前必读）

技术栈：TypeScript，commander v12，vitest（833 测试全绿为基线）。构建 `npm run build`，
类型检查 `npx tsc --noEmit`。

### 关键文件

| 文件 | 角色 |
| ---- | ---- |
| `src/modules/queue/queue-file.ts` | 队列存储层：定义/任务 front matter 解析（`KNOWN_DEFINITION_KEYS`、`KNOWN_TASK_KEYS`）、`writeQueueDefinition`、`insertQueueTask` |
| `src/modules/queue/controller.ts` | 运行时：`#fire`（controller.ts:310-375）构造 `command.session.new`，cwd 硬编码在 :340 |
| `src/cli.ts` | `queue add` wizard（:471，`addQueue`，走 i18n）、`queue insert`（:518，`insertQueueCommand`；commander 注册在 :850 附近） |
| `src/i18n/index.ts` | queue wizard 文案走 i18n（`cli.queueNamePrompt` 等，en+zh 双语） |
| `src/modules/client/utils/working-directory.ts` | `validateWorkingDirectory`：`~` 扩展 + 相对路径解析 + realpath + 存在性校验 |
| `src/modules/schedule/scheduler.ts:464-477` | **照抄模板**：scheduler 的 fire-time 目录校验 + 失败投递 |
| `src/modules/schedule/task-file.ts:43,60-61,172` | **照抄模板**：schedule task `directory` 的解析方式 |

### 已有模式（照抄即可）

- schedule task 的 `directory` 解析就是 `nonEmptyString(fields.directory)`，definition 侧照抄；
  任务侧同理（任务 front matter 目前只有 `state`/`enqueuedAt` 两个合法 key）。
- `queue add` wizard 目前只写 `workers` + `model`（`writeQueueDefinition({name, workers, model})`），
  新增 directory 时保持"blank 则不写该行"的惯例。
- `insertQueueTask(name, prompt, queuesRoot)` 当前第三参已是 `queuesRoot`——扩展签名时注意不要
  破坏测试里传临时目录的调用方式。
- queue 的 fire 失败 = **fail-and-drop**（删任务文件 + 通知），这与 scheduler 的 skip-and-keep
  （周期性任务）不同，实现 D3 时务必分清。

### 坑

- `#fire` 里 `setQueueTaskState(running)` 在 dispatch 之前；若目录校验放在 dispatch 前，失败路径
  必须走 `#failFire`（它会处理 SF-2 stale-fire guard），不要手写删除。
- `validateWorkingDirectory` 返回 canonical 路径（realpath 后），应把**校验后的 canonical 值**
  传给 `command.session.new.workingDirectory`，与 scheduler 一致。
- CLI 测试 `src/cli.test.ts` 对 task-file 模块用了 `vi.mock`（runtime 导入真实常量会触发 mock
  提升冲突），新增断言照抄现有写法。

## 4. 端到端验收

完成定义：三级回退（task > queue > cwd）按 D1-D5 实现，全部测试绿、类型检查与构建通过。

```bash
cd /home/wesley/project/agent-bridge
npx vitest run            # 833 + 新增测试全绿
npx tsc --noEmit          # 无类型错误
npm run build             # 构建成功
```

手动冒烟（可选）：`npm run dev` 起 bridge → `queue add` 时填一个存在的目录 → `queue insert
<name> --prompt "pwd 输出当前目录" --directory /tmp` → 绑定 `/queue-here` 后观察日志
`starting agent instance (bin=pi cwd=<insert 指定的 /tmp>)`。
