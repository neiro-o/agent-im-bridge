# T03: CLI 与文档 —— add wizard prompt、insert `--directory`、queue 文档

## 目标

把两级 directory 暴露给用户：`queue add` wizard 增加工作目录 prompt（可选，blank = 不落盘），
`queue insert <name>` 增加 `--directory <path>` 选项；同步更新 queue 的两份文档。按 D4，CLI
侧一律不做文件系统校验，原样落盘。

## 上下文

- context.md §2 D2/D4、§3「已有模式」（wizard 惯例、cli.test.ts 的 mock 坑）
- `src/cli.ts`（`addQueue` :471、`insertQueueCommand` :518、commander 注册 :850 附近）
- `src/i18n/index.ts`（queue wizard 文案 key：`cli.queueNamePrompt`/`workersPrompt`/`modelPrompt`，
  en+zh 双语）
- `docs/event-queue.md`（定义示例、Fields 表、「How a task runs」/ fire 段落）
- `docs/event-queue-spec.md`（定义示例、字段清单）

## 边界

只允许修改：

- `src/cli.ts`、`src/cli.test.ts`
- `src/i18n/index.ts`（及 `src/i18n/index.test.ts` 若新 key 需要断言）
- `docs/event-queue.md`、`docs/event-queue-spec.md`

不改 queue-file.ts / controller.ts（T01/T02 已提供实现）。

要点：

- `queue add` wizard：新增 i18n key（如 `cli.queueDirectoryPrompt`，en+zh），blank 则不写
  `directory:` 行（与 `model` 惯例一致）；落盘走 T01 扩展后的 `writeQueueDefinition`。
- `queue insert`：commander 加 `.option("--directory <path>", ...)`；`insertQueueCommand` 把它
  透传给 T01 扩展后的 `insertQueueTask`；不传则行为与现状完全一致。
- 文档：event-queue.md 的 Fields 表加 `directory` 行（说明三级回退与 fire-time 校验）、定义示例
  加注释行、fire 段落说明无效目录的行为（定义级跳过 / 任务级 fail-and-drop）；spec 同步。
- cli.test.ts：add wizard 回答 directory 时写入定义文件；insert 带/不带 `--directory` 两种路径
  （注意该文件对 task-file 模块的 vi.mock 提升坑，照抄现有写法）。

## 验收

```bash
npx vitest run src/cli.test.ts src/i18n   # 全绿
npx tsc --noEmit && npm run build         # 类型与构建通过
node dist/agent-bridge.js queue insert --help   # 能看到 --directory 选项
```

## 依赖

T01（`writeQueueDefinition` / `insertQueueTask` 的新签名）。不依赖 T02（CLI 只落盘，不点火）。
