# Tasks

| 编号 | 名称 | 依赖 | 验证方式 |
| ---- | ---- | ---- | -------- |
| 01 | `command.session.release` 事件 + core 强杀 + 超时路径切换 | - | `npx vitest run src/core src/modules/queue src/modules/schedule` |
| 02 | 清理链重排加固 + queue tick 僵尸对账 | 01（超时路径 dispatch 的是 release） | `npx vitest run src/modules/queue src/modules/schedule` |
