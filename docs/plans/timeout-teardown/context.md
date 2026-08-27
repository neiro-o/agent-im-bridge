# Timeout Teardown & Cleanup Hardening（超时杀进程 + 清理链加固）

## 1. 背景与目标

8/26 midnight-dev 队列事故（`~/project/queues-incident-20260826.md`）暴露的两个 bridge 侧问题：

1. **超时不杀进程**：超时路径 dispatch 的 `command.session.stop` 只 abort 当前 turn。pi 进程
   存活，积压的 silence-probe 消息在 turn 解除阻塞后被当指令消化，"复活"继续干活数小时，
   产出全部被 bridge 按 orphan 丢弃，还与后续任务并发操作同一 worktree。
2. **清理链无自愈**：`#handleTimeout` 的串行链条中删除任务文件失败（被内部 catch 吞成一条
   日志），任务文件僵在 `running` 5 小时，`queue list` 显示 Running 2（workers=1 的假象）。
   只有重启 bridge（`#resetRunningTasks`）才会清理。

**目标**：

- 超时 = 彻底终结该 run 的 agent 会话（进程级 SIGTERM→SIGKILL），queue 和 scheduler 一致。
- 超时清理链对 hang/throw 鲁棒：本地清理不被远程步骤阻塞。
- 僵尸 `running` 任务文件由 tick 对账自愈，无需重启 bridge。

**非目标**：pi 孙子进程（tmux worker 等）的进程组级清理；silence-probe 升级机制；失败重试；
scheduler 侧对账（scheduler 没有磁盘 running 状态，不需要）。

## 2. 方案概要（关键决策）

- **D1 新增 `command.session.release` 事件**（ClientOutputEvent，仅由 controller 合成，IM
  adapter 不产生）：core 收到后走现成的 `#stopRuntime`（abort + `adapter.stop()` =
  SIGTERM→1s 后 SIGKILL + runtime 移除 + state revoke + SF-1 合成 session 记录删除）。
  找不到 runtime → no-op 返回 `{ ok: true }`，**不向 session 投递任何消息**（合成 session
  没人读）。交互 `/stop` 的 `session.stop`（abort-only）语义完全不变。
- **D2 queue/scheduler 超时路径从 `session.stop` 改用 `session.release`**。已知限制写进文档：
  pi 派生的孙子进程（tmux 等）不在进程组内，杀不掉。
- **D3 清理链重排（两个 controller 一致）**：本地 fs 步骤（写 history、queue 删任务文件）
  先做；远程步骤（投递通知、release dispatch）最后做且不阻塞——release 用
  `void #dispatchSafe(...)` 不等待。`#handleTimeout` 整个 body 套顶层 try/catch（消灭
  floating-promise 静默断链）。
- **D4 queue tick 对账自愈**：tick 中某 owned 队列的任务文件为 `running` 但 `#runs` 无对应
  run → 僵尸 → **删除文件** + warn log（不是重置 pending：mid-session 僵尸证明 run 已终结，
  重跑有重复副作用风险；bridge 重启场景仍由 `#resetRunningTasks` 走 at-least-once 重置，
  两者不冲突）。**tombstone 宽限**：`#endRun`/`#handleTimeout` 在内存 Map 记录 run 终结
  时间戳，对账跳过终结时间 < 2×tickMs 的 run（防止与正在进行的正常清理链竞态误删）。
- **D5 文档同步**：event-queue.md / event-queue-spec.md / scheduled-tasks.md 的 timeout 描述
  从 "abort" 更新为 "tear down the run's agent session (process terminated)"；queue 文档补
  对账自愈行为说明。

## 3. 公共上下文（开工前必读）

技术栈：TypeScript，commander v12，vitest（846 测试全绿为基线）。验证：`npx vitest run` /
`npx tsc --noEmit` / `npm run build`。

### 关键文件

| 文件 | 角色 |
| ---- | ---- |
| `src/types.ts` | `ClientOutputEvent` 联合类型（`command.session.*` 各 variant 在此定义） |
| `src/core/gateway-core.ts` | ingress 的 `command.session.*` 分支（:248-277 一带）；`#handleSessionStop`（:439，abort-only）；**`#stopRuntime`（:1174，现成的强杀路径）**；`#isSyntheticClientSession` |
| `src/modules/queue/controller.ts` | `#handleTimeout`（清理链）、`#endRun`、`#tick`、`#resetRunningTasks`（启动时重置，仅 start 跑一次） |
| `src/modules/schedule/scheduler.ts` | `#handleTimeout`（:781 一带，链 = history → target 检查 → dispatchSafe(stop) → deliver） |
| `src/modules/run-completion/history.ts` | `appendRunHistory` 内部 catch，never-throws（已核实） |

### 已有模式

- `#stopRuntime` 是 idle release / bridge cleanup 在用的成熟路径，D1 只是给它接一个事件入口，
  不发明新清理逻辑。
- `#dispatchSafe`（两个 controller 都有）内部 try/catch，但 **防 throw 不防 hang**——这正是
  D3 要求 release dispatch 不 await 的原因。
- queue 的 run id 重启稳定：`queue:<queueName>:<taskId>`，tombstone 可直接用它做 key。
- tick 与 tick 串行（`#scheduleNextTick` 链式），但 `#handleTimeout` 是独立 timer 链，**可以
  与 tick 交错**——tombstone 宽限（D4）就是为这个交错设计的。
- `#fire` 被 tick await 且 `#registerRun` 在任何 await 前同步写入 `#runs`，所以 tick 起点的
  对账看不到 fire 进行中的中间态，无需额外 firing 占位。

### 坑

- `#handleTimeout` 目前是 `void` floating promise——D3 的顶层 try/catch 必须连 timer 回调的
  调用点一起考虑（`.catch` 或内部 try 均可，但要有 error 日志）。
- tombstone Map 要随 tick 修剪（删除过期条目），避免长跑 bridge 的内存缓慢增长。
- queue 对账只处理 `definition.channel === this.#channelName` 的 owned 队列（与 fire 的
  ownership 过滤一致）；disabled/unbound 队列的僵尸留给它们重新 enabled/bound 后的 tick。
- scheduler 的 `#handleTimeout` 没有文件删除步骤，D3 对它意味着：history → deliver →
  void dispatch(release)。

## 4. 端到端验收

完成定义：超时即进程级终结（queue + scheduler），清理链在 dispatch 永久 hang 时仍能完成本地
清理与通知，僵尸 running 文件在对账宽限期后被自动删除。全量测试绿、类型检查与构建通过。

```bash
cd /home/wesley/project/agent-bridge
npx vitest run && npx tsc --noEmit && npm run build
```
