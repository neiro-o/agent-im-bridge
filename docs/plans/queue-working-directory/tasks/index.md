# Tasks

| 编号 | 名称 | 依赖 | 验证方式 |
| ---- | ---- | ---- | -------- |
| 01 | 存储层：定义/任务的 `directory` 字段解析与写盘 | - | `npx vitest run src/modules/queue/queue-file.test.ts` |
| 02 | 运行时：`#fire` 三级回退解析 + fire-time 目录校验 | 01（`QueueDefinition.directory` / `QueueTask.directory` 字段） | `npx vitest run src/modules/queue/controller.test.ts` |
| 03 | CLI 与文档：add wizard prompt、insert `--directory`、queue 文档 | 01（`writeQueueDefinition` / `insertQueueTask` 新签名） | `npx vitest run src/cli.test.ts` |
