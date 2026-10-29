# 架构与扩展指南

## 1. 分层

```
┌──────────────────────────────────────────────┐
│ renderer (React)                             │
│   任务列表 / 分片地图 / 设置 / 新建下载        │
└───────────────┬──────────────────────────────┘
                │ window.yunflow (contextBridge)
┌───────────────▼──────────────────────────────┐
│ preload  —— 白名单 IPC，无 Node 能力暴露       │
└───────────────┬──────────────────────────────┘
                │ ipcMain.handle / webContents.send
┌───────────────▼──────────────────────────────┐
│ main                                          │
│  manager.ts   队列 · 持久化 · 250ms 合并广播   │
│  task.ts      worker 池 · 看门狗 · 合并        │
│  engine/*     HTTP · 分片 · 分配器 · 信号量     │
│  resolvers/*  直链解析（可扩展）               │
└──────────────────────────────────────────────┘
```

渲染层不做任何网络或文件操作。所有状态以 `TaskView` 快照单向推送，
命令通过 `tasks:*` 通道下发。这样 UI 可以在没有 Node 权限的沙箱里运行。

## 2. 任务状态机

```
queued ──start()──► probing ──► downloading ──► merging ──► completed
   ▲                    │            │
   │                    │            ├─ pause() ──► paused ──start()──┐
   │                    │            ├─ cancel() ─► canceled          │
   │                    │            └─ error ────► failed ──retry()──┤
   └────────────────────┴─────────────────────────────────────────────┘
```

- `probing`：`Range: bytes=0-0` 探测大小与 Range 能力，同时识别 HTML 拒绝页。
- `downloading`：worker 池运行；`paused` 时保留 `.part` 文件与内存中的计划。
- `merging`：按起点排序逐片校验并写入目标文件。
- `failed`：保留分片，`retry()` 从断点继续而不是从头开始。

## 3. 并发模型

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| 任务队列 | `manager.pump()` | 同时下载的任务数上限（默认 2） |
| worker 池 | `task.workerLoop()` | 每个任务 N 个异步 worker，N = min(用户线程数, 平台 CDN 上限, 运行平台上限) |
| 全局信号量 | `Semaphore` | 限制**所有任务**同时在飞的 Range 请求数 |
| 令牌桶 | `TokenBucket` | 可选的按任务限速，在写入边界施加背压 |
| 看门狗 | `speed-watchdog.ts` | 5 秒采样，判定并抢占慢连接 |

为什么不是 worker_threads：瓶颈是网络与服务端按连接限速，CPU 侧只有哈希和文件写入。
Node 的 HTTP 连接本身就是并行单位，磁盘写入由 libuv 线程池异步执行，
再引入 worker_threads 只会增加 IPC 拷贝和状态同步成本。

## 4. 续传不变量

一个任务的分片区间完全由 `(total, chunkCount, mainCount, chunkSize)` 推导。
因此续传前必须确认这组参数没有变化，否则同名 `.part` 文件会对应错误的字节区间。

```ts
planSignature(plan) = `v1;chunks=..;total=..;main=..;size=..`
```

不一致 → 整个任务目录清空重下。一致 → 每个主池分片按磁盘长度续传。

弹性区分片没有稳定索引（块大小随速度变化），因此：

- 进程内暂停：保留 `ElasticAllocator` 游标与已完成块；
- 进程重启：删除 `e*.part`，从 `elasticStart` 重新分配；
- 进程内继续：从第一个未完成块的位置重建分配器，已完成的前缀保留。

## 5. 失败模式与处理

| 现象 | 检测 | 处理 |
| --- | --- | --- |
| CDN 忽略 Range（200） | 分片请求返回 200 | 立即断开；累计 3 次转单流 |
| 返回 HTML 防盗链页 | `Content-Type: text/html` 且无 `Content-Disposition` | 直接失败，绝不落盘 |
| `Content-Range` 与请求不符 | 严格比对 start/end | 判定失败并重试 |
| 连接被挂住 | 20 秒无字节 | 看门狗 abort，换连接续传 |
| 连接过慢 | 速度 < max(12KB/s, 均速/2) | 同上，受冷却与次数上限约束 |
| 分片写入不足 | `written < expected` | 重试（从新长度续传），不产出空洞文件 |
| 分片摘要不符 | 合并时重算 SHA-256 | 中止合并、删除半成品、保留分片 |

## 6. 添加一个直链解析器

解析器的职责只有一件事：把用户粘贴的内容变成 `https://` 直链 + 可选请求头。

```ts
// src/main/resolvers/my-drive.ts
import type { LinkResolver } from './types';

export const myDriveResolver: LinkResolver = {
  id: 'my-drive',
  name: '我的网盘',
  supports: (url) => url.hostname === 'drive.example.com',
  resolve: async (url) => ({
    url: await callMyApi(url),        // 换成真正的直链
    platformId: 'my-drive',
    headers: { Referer: 'https://drive.example.com/' },
    note: '通过自建解析服务换取直链'
  })
};
```

然后在 `src/main/resolvers/index.ts` 的 `RESOLVERS` 数组里注册，并在
`src/shared/platforms.ts` 增加一条平台预设（并发上限、Referer、强调色）。

注意事项：

- **不要**在解析器里做需要用户账号密码的登录流程；凭证应由用户以 Cookie 形式显式提供。
- **不要**把分享页 HTML 直接返回。`resolveLink` 会对已知分享页路径抛 `ShareLinkError`。
- 解析失败应当抛出可读的错误，UI 会原样展示在新建下载对话框里。
- 新增第三方接口时请确认其服务条款；本项目不附带任何私有接口实现。

## 7. 设置项语义

| 设置 | 默认 | 作用域 | 说明 |
| --- | ---: | --- | --- |
| `defaultThreads` | 8 | 新任务 | 1–512（桌面）/ 1–32（移动），会被平台预设覆盖 |
| `maxConcurrentTasks` | 2 | 全局 | 超出排队 |
| `speedLimitBps` | 0 | 每任务 | 0 = 不限速 |
| `maxInflightChunks` | 512 | 进程 | 信号量容量，8–512 |
| `slowConnectionPreempt` | true | 新任务 | 关闭后只保留超时重试 |
| `autoResumeOnLaunch` | false | 启动 | 自动继续 paused 任务 |

修改 `maxInflightChunks` 会热更新信号量容量；已在飞的请求不会被中断。

## 8. 线程策略

`src/shared/thread-policy.ts` 是唯一入口，主进程的 IPC、设置保存、任务恢复都调用
`resolveThreads()`，UI 只是显示它的结果：

```
runtime ceiling   桌面 512 / 移动 32
platform ceiling  平台 CDN 阈值（迅雷 8，其余继承 512）
user request      1..min(runtime, platform)
```

返回值带 `requested / effective / cap / clamped / reason`，因此界面能解释"为什么我填了 128 变成 8"，
而不是静默改数。引擎侧 `MAX_THREADS = 512` 是最后一道兜底。

内存预算：512 路 × 64 KB 读缓冲 ≈ 32 MB，加上 512 个 socket 与分片文件句柄；
`maxInflightChunks` 的默认值已同步到 512，否则用户选 512 也只会跑出配额那么多路。
