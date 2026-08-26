# T01: 存储层 —— 定义/任务的 `directory` 字段解析与写盘

## 目标

给 queue 存储层加两级 `directory` 字段：队列定义 front matter 和任务文件 front matter 各一个，
均为可选、解析规则与 scheduled task 的 `directory` 完全一致（`nonEmptyString`，存储层不碰文件
系统）。这是整个特性的数据基础，后续运行时和 CLI 都建立在这两个字段上。不写任何消费逻辑
（`#fire` 的用法是 T02，CLI 接线是 T03）。

## 上下文

- context.md §2 D1/D2、§3「已有模式」
- `src/modules/queue/queue-file.ts`（全部；重点：`KNOWN_DEFINITION_KEYS`/`KNOWN_TASK_KEYS`、
  `parseQueueDefinition`、`parseQueueTaskFile`、`insertQueueTask`、`writeQueueDefinition` 及其 options 接口）
- `src/modules/schedule/task-file.ts:43,60-61,172`（照抄模板）

## 边界

只允许修改：

- `src/modules/queue/queue-file.ts`
- `src/modules/queue/queue-file.test.ts`

不改 controller、CLI、i18n、文档。

要点：

- `KNOWN_DEFINITION_KEYS` 和 `KNOWN_TASK_KEYS` 各加 `"directory"`；`QueueDefinition.directory` /
  `QueueTask.directory` 均为 `string | undefined`。
- `insertQueueTask` 支持把 `directory` 写进任务 front matter（仅当指定时写该行；注意第三参已是
  `queuesRoot`，签名扩展保持向后兼容，测试里大量传临时目录的调用不能破）。
- `writeQueueDefinition` 的 options 加可选 `directory`，blank/undefined 不写该行（与 `model`
  的现有惯例一致）。
- 更新 queue-file.ts 顶部模块注释里对 front matter 合法 key 的列举。

## 验收

```bash
npx vitest run src/modules/queue/queue-file.test.ts   # 全绿，含新增用例
npx tsc --noEmit                                      # 无类型错误
```

新增用例至少覆盖：定义缺失/空串/正常三种 `directory` 解析；任务缺失/正常 `directory` 解析；
`insertQueueTask` 带与不带 directory 的落盘内容；`writeQueueDefinition` 带 directory 的落盘内容。

## 依赖

无。
