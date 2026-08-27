# T01: `command.session.release` 事件 + core 强杀 + 超时路径切换

## 目标

给 core 增加一个"彻底终结会话"的入口：新事件 `command.session.release` 走现成的
`#stopRuntime`（abort + adapter.stop SIGTERM→SIGKILL + runtime 移除 + state revoke + 合成
session 记录删除）。queue/scheduler 的超时路径从 `session.stop`（只 abort turn）切换为
`session.release`，超时即进程级终结。交互 `/stop` 语义不变。

## 上下文

- context.md §1 问题 1、§2 D1/D2/D5、§3「关键文件」「已有模式」「坑」
- `src/types.ts`（ClientOutputEvent 联合类型）
- `src/core/gateway-core.ts`（`command.session.*` 分支、`#handleSessionStop`、`#stopRuntime`、
  `#isSyntheticClientSession`）
- `src/modules/queue/controller.ts` 的 `#handleTimeout`、scheduler 的 `#handleTimeout`
- 现有测试：core 的 session stop 测试、queue/scheduler 的超时测试

## 边界

允许修改：

- `src/types.ts`
- `src/core/gateway-core.ts` 及其测试
- `src/modules/queue/controller.ts` / `controller.test.ts`（仅超时路径的 dispatch 类型与断言）
- `src/modules/schedule/scheduler.ts` / 其测试（同上）
- `docs/event-queue.md`、`docs/event-queue-spec.md`、`docs/scheduled-tasks.md`（timeout 描述从
  abort 改为进程级终结 + 孙子进程限制说明）

不改：slash-commands.ts（`/stop` 保持 abort-only）、IM adapters（不产生 release 事件）。

要点：

- release 找不到 runtime → `{ ok: true }` no-op + debug log，不向 session 投递消息（合成
  session 没人读，与 stop 的 "noActiveSessionToStop" 回复路径刻意不同）。
- core 对 release 的处理不限于合成 session（事件类型层面通用；今天只有 controller 会发）。
- 超时测试断言 dispatch 出去的是 `command.session.release` 而非 `session.stop`。

## 验收

```bash
npx vitest run src/core src/modules/queue src/modules/schedule   # 全绿
npx tsc --noEmit
```

新增用例至少覆盖：release → adapter.stop 被调、runtime 从注册表移除、合成 session 记录被删；
release 未知 session → ok no-op；queue 超时 dispatch release；scheduler 超时 dispatch release。

## 依赖

无。
