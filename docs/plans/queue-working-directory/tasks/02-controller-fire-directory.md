# T02: 运行时 —— `#fire` 三级回退解析 + fire-time 目录校验

## 目标

让队列点火真正用上工作目录：`task.directory ?? definition.directory ?? process.cwd()`，并在
dispatch 前用 `validateWorkingDirectory` 校验（照抄 scheduler.ts:464-477 的模式），实现
context.md D3 的两种失败行为：定义级无效 → 该 tick 跳过整个队列 + warn log（任务保留 pending）；
任务级无效 → 该任务 fail-and-drop + 投递错误到 target。

## 上下文

- context.md §2 D1/D3/D5、§3「坑」（canonical 值传递、`#failFire`/SF-2 的复用要求）
- `src/modules/queue/controller.ts`（重点：`#tick`、`#fire`、`#failFire`、controller.test.ts 的
  `createHarness` 模式）
- `src/modules/schedule/scheduler.ts:455-495`（照抄模板：校验 → 失败投递 → return）
- `src/modules/client/utils/working-directory.ts`（`validateWorkingDirectory` 签名与返回）

## 边界

只允许修改：

- `src/modules/queue/controller.ts`
- `src/modules/queue/controller.test.ts`

不改 queue-file.ts（T01 已提供字段）、CLI、i18n、文档。

要点：

- 传给 `command.session.new.workingDirectory` 的是校验返回的 **canonical 路径**；
  `workingDirectorySource` 保持 `"default"`（D5）。
- 校验发生时机：定义级在 tick/逐任务 fire 前的公共路径做（避免同一定义对每个任务重复校验+逐条
  投递）；任务级在 `#fire` 内 dispatch 前做。
- 任务级失败走既有的 fire-failure 通路（fail-and-drop + 通知），不要手写状态/删除逻辑，注意
  SF-2 stale-fire guard 已有约束。
- 定义级无效时跳过该队列本 tick，**不投递**（对齐 unbound/disabled 的静默堆积语义；定义修好后
  下个 tick 自动消化）。

## 验收

```bash
npx vitest run src/modules/queue/controller.test.ts   # 全绿，含新增用例
npx tsc --noEmit
```

新增用例至少覆盖：三级回退各档（仅任务级 / 仅队列级 / 都有时任务级胜出 / 都没有退回 cwd）；
任务级目录无效 → 任务被 drop 且 target 收到错误；定义级目录无效 → 无 dispatch、任务仍为
pending、有 warn log。

## 依赖

T01（消费其 `QueueDefinition.directory` / `QueueTask.directory` 字段）。
