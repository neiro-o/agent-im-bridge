# T02: 清理链重排加固 + queue tick 僵尸对账

## 目标

让超时清理链对 hang/throw 鲁棒，并让僵尸 `running` 任务文件无需重启即可自愈：

1. **重排（两个 controller 一致）**：本地 fs 步骤（写 history、queue 删任务文件）先做；远程
   步骤（投递通知、release dispatch）最后做且不阻塞（`void #dispatchSafe(...)`）。
2. **顶层 try/catch**：`#handleTimeout` 整个 body 包住，意外 throw 至少留 error 日志，不再
   静默断链（floating promise）。
3. **tick 对账（仅 queue）**：owned 队列中 `state: running` 但 `#runs` 无对应 run 的任务文件
   → 删除 + warn log；tombstone 宽限（`#endRun`/`#handleTimeout` 记录终结时间戳，2×tickMs 内
   的对账跳过）防止与正常清理链竞态。

## 上下文

- context.md §1 问题 2、§2 D3/D4、§3「已有模式」「坑」（tick 与 timeout 链可交错、对账
  ownership 过滤、tombstone 修剪）
- `src/modules/queue/controller.ts`（`#handleTimeout`、`#endRun`、`#tick`、`#resetRunningTasks`）
- `src/modules/schedule/scheduler.ts` 的 `#handleTimeout`（无文件删除，重排后 = history →
  deliver → void dispatch）

## 边界

允许修改：

- `src/modules/queue/controller.ts` / `controller.test.ts`
- `src/modules/schedule/scheduler.ts` / 其测试（仅 `#handleTimeout` 重排 + 顶层防御）
- `docs/event-queue.md`、`docs/event-queue-spec.md`（对账自愈行为说明；scheduler 链行为变化
  如值得提则同步 `docs/scheduled-tasks.md`）

不改：types.ts、core（T01 已完成）、queue-file.ts。

要点：

- 对账**删除**而非重置 pending（mid-session 僵尸 = run 已终结；重启场景仍由
  `#resetRunningTasks` 负责 at-least-once 重置）。
- 对账仅处理 `definition.channel === this.#channelName` 的 owned 队列；disabled/unbound 队列
  的僵尸等它们重新可用后的 tick 自然处理。
- tombstone Map 每 tick 修剪过期条目。
- 注意 `controller.stop()` 清空 `#runs` 时**不**记 tombstone（那些 run 是"在飞被忘"，文件
  留给下次 start 重置，不是僵尸）。

## 验收

```bash
npx vitest run src/modules/queue src/modules/schedule   # 全绿
npx tsc --noEmit
```

新增用例至少覆盖：dispatch 永久 hang（dispatchClientEvent 永不 resolve）时 queue 的任务文件
照删、通知照发；scheduler 的通知照发；僵尸 running 文件在宽限期后的 tick 被删除且有 warn；
宽限期内的正常清理不被对账误删；在飞 run 的任务文件不被误删。

## 依赖

T01（`#handleTimeout` dispatch 的已是 `session.release`；重排在它之上进行）。
