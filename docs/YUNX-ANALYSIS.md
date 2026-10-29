# YunX（云析）下载引擎源码分析

> 分析对象：[`CYQawa/YunX`](https://github.com/CYQawa/YunX)，Kotlin / Jetpack Compose 实现的 Android 网盘解析下载器，
> 许可证 **GNU AGPL-3.0**，Copyright (C) 2026 CYQawa。
>
> 分析基线：仓库 `main` 分支（commit 以克隆当日为准），核心文件
> `app/src/main/kotlin/com/yunx/app/data/download/{DownloadManager,ChunkDownloader,HttpRangePolicy}.kt`。
> 本文只讨论**传输层如何把单连接限速变成多连接叠加**，不涉及分享页解析接口。

---

## 1. 一句话结论

云析的加速不来自任何"破解"或私有协议，而来自一个工程事实：

> **网盘 CDN 的限速是按 TCP 连接施加的，且不同边缘节点的单连接速率差异极大。**
> 因此把文件切成远多于线程数的分片、用多条 HTTP Range 连接并发拉取、并在运行中不断把慢连接换成新连接，
> 总吞吐就能接近链路带宽上限，而不是被单连接 100 KB/s 卡死。

围绕这一条，项目做了五件事，缺一不可：**探测 → 规划 → 调度 → 治理 → 校验合并**。

---

## 2. 代码地图

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `data/download/HttpRangePolicy.kt` | 40 | `Content-Range` 解析与"响应区间是否等于请求区间"的判定 |
| `data/download/ChunkDownloader.kt` | 486 | 单个分片的 Range 请求、续传、写入、重试、摘要、抢占响应 |
| `data/download/DownloadManager.kt` | 2619 | 尺寸探测、分片规划、worker 池、弹性分配器、看门狗、合并、持久化 |
| `data/download/DownloadSaver.kt` | 469 | 落盘到公共目录、命名与路径策略 |
| `data/gopeed/GopeedEngine.kt` | 714 | 可选的内嵌 Gopeed（Go）引擎，用于 BT/ed2k 等协议；**不是** HTTP 加速主路径 |

需要先排除一个误解：`GopeedEngine` 虽然也支持多连接下载，但它是一个可选的、由用户导入 `.so` 才启用的独立引擎
（`libgojni.so` 约 56 MB）。HTTP 网盘下载走的是 Kotlin 自己实现的 `ChunkDownloader` + `DownloadManager`。

---

## 3. 主流程

```
① 探测      GET + Range: bytes=0-0
             ├─ 206 + Content-Range: bytes 0-0/N  → 支持分片，总大小 N
             ├─ 200                                → CDN 忽略 Range，转单流
             └─ Content-Type: text/html            → 防盗链/过期页，直接报错
② 规划      chunkCount = clamp(max(bySize, threads×8), total/256KB, 512)
            chunkSize  = ceil(total / chunkCount)
            mainCount  = round(chunkCount × 0.7)        // 定长主池
            elasticStart = mainCount × chunkSize        // 弹性区起点
            写 plan.txt 记录 (chunks, total, main) 作为续传签名
③ 调度      N 个 worker（N = min(线程数, 安全上限, 在飞配额)）
            阶段 1：按序号领取主池分片
            阶段 2：主池取空 → 向 ElasticAllocator 领取弹性块
            阶段 3：领取失败重试队列
④ 治理      看门狗每 5 s 采样每路瞬时速度
            低于 max(12 KB/s, 本任务单路均速/2) 且满足年龄/冷却/剩余量条件 → 断开换连接
⑤ 校验      每片写入时增量算 SHA-256；合并时逐片重算比对
⑥ 合并      按起点顺序流式写入目标文件，写一片删一片
⑦ 续传      分片文件按索引命名，区间由 plan 推导；plan 变化则整目录清空
```

---

## 4. 核心技术点

### 4.1 尺寸探测：只信 206 和 Content-Range

`ChunkDownloader.getTotalSize()` 先用 `Range: bytes=0-0` 探测：

```kotlin
if (response.code != 206) return@use null
val range = HttpRangePolicy.parse(response.header("Content-Range")) ?: return@use null
if (range.start != 0L || range.end != 0L) return@use null
range.total
```

只有"206 + 区间恰好是 0-0 + 总大小可解析"才认为支持分片。否则退回无 Range 的 `Content-Length`。
同时任何 `Content-Type: text/html` 且无 `Content-Disposition` 的响应都判定为防盗链/过期页，
**绝不以 HTML 页面冒充文件落盘**。

这一步决定了后面所有策略：不支持 Range 的链接只能单流，硬切片只会把文件写坏。

### 4.2 分片规划：分片数必须是线程数的数倍

```kotlin
val bySize = when {
    total < 5MB   -> 1
    total < 50MB  -> 8
    total < 500MB -> 32
    else          -> 64
}
val want = maxOf(bySize, threads * 8)          // 每线程 8 片盈余
return minOf(want, (total / 256KB).toInt(), 512)
```

两个刻意为之的选择：

- **盈余分片（threads × 8）**：如果分片数 == 线程数，某一片卡住时它的 worker 只能干等，尾部必然塌缩。
  分片远多于 worker 后，慢片的 worker 可以去领新片，等于实现了"工作窃取"。
- **单片下限 256 KB（不是 1 MB）**：早期用 1 MB，33.7 MB 的文件只能切出约 34 片，在单连接 10 KB/s 的平台上
  一片要跑 100 秒，尾部空转极严重。降到 256 KB 后同样文件能切出 4–8 倍于线程数的片。

上限 512 片是对文件句柄与内存的折中：每路在飞约 2 个 FD + 一份 64 KB 读缓冲。

### 4.3 主池 70% + 弹性区 30%

前 70% 的分片是定长的，worker 按序号领取，行为可预测、连接复用友好。
后 30% 交给 `ElasticAllocator`，按字节顺序发块，块大小动态变化：

```kotlin
val base = (recentSpeedBps / workers * TARGET_SECONDS)   // 单 worker 5 秒的量
    .coerceIn(256KB, 4MB)
val block = if (remaining <= workers * base) {
    (remaining / workers).coerceIn(64KB, base)           // 尾部收缩
} else base
```

- **快则大块**：单路 5 MB/s 时一块约 4 MB，减少 Range 往返开销。
- **慢则小块**：单路 100 KB/s 时一块 256 KB，避免一个大块拖死收尾。
- **尾部收缩**：剩余量不足 `workers × base` 时把块压到 `remaining / workers`，让**全部连接同时冲最后一段**，
  而不是"其他人都下完了，只剩最后一个线程慢慢爬"。

块按字节顺序发放（物理相邻），而不是从中点不断二分。中点劈分会破坏连接复用，实测中后段掉速。

### 4.4 并发模型：worker 池 + 全进程信号量 + 专用线程池

三层限制，各司其职：

1. **单任务 worker 数** = `min(设置线程数, 安全上限, 在飞配额)`。
   迅雷 CDN 对单文件并发 Range 有阈值（约 8 路），超过会把多余请求降级成 200 整文件，
   因此 `isXunlei` 时用 `RANGE_WORKERS_CAP = 8` 封顶。
2. **全进程在飞分片配额** `MAX_INFLIGHT_CHUNKS`：

   ```kotlin
   fun inflightChunksFor(maxHeap: Long, bufferSize: Int = 64 * 1024) =
       (maxHeap / 8 / bufferSize).toInt().coerceIn(8, 512)
   ```

   由 `Semaphore` 承载。无论用户把线程数调到 256、同时开几个任务，同时在飞的请求数都不会超过它 —— 这是 OOM 的根治手段。
3. **专用 IO 线程池**：不能用 `Dispatchers.IO`，它的并行度被钉在 `max(64, CPU 核数)`，
   超出的 worker 只会在队列里干等，于是"设置 256 线程"永远只跑出 64 路。
   项目改为自定义 `ThreadPoolExecutor(core = max = MAX_INFLIGHT_CHUNKS, 30s 回收)`。

另有**错峰建连**：第 i 个分片首次请求前延迟 `min(i, 8) × 25 ms`，把 TCP/TLS 握手突发摊平，
只影响首请求，不影响稳态并发。

### 4.5 单个分片：续传、截断、校验、回退

`ChunkDownloader.downloadChunk()` 的契约非常严格：

```kotlin
val existing = partFile.length()
val from = start + existing
val expected = end - start + 1
// 已经下满 → 直接成功
if (existing >= expected) return ChunkResult.OK
// 请求 bytes=from-end
// 206 且 Content-Range 必须精确等于 (from, end)
// 写入后必须 written == expected - existing，否则视为失败
```

四个关键判断：

| 情况 | 处理 | 原因 |
| --- | --- | --- |
| 206，`Content-Range` 与请求不一致 | 失败 | 防止 CDN 返回错位区间导致文件错乱 |
| 200（忽略 Range） | 返回 `RANGE_IGNORED`，**立刻断开** | 绝不能把整个文件写进一个分片 |
| 写入字节 < 预期 | 失败并重试 | 防止"空洞文件"，长度对但内容是洞 |
| 服务器多发字节 | `min(read, expected - written)` 截断 | 防止文件膨胀 |

重试策略：`CHUNK_RETRIES = 3` 次 IO 重试 + `RANGE_RETRIES = 4` 次 Range 重试，
退避 `500 ms × 尝试次数`，上限 3 s。`RANGE_IGNORED` 不在片内退避（会占着信号量配额造成全局停顿），
而是立刻返回让上层释放配额；累计 3 次才判定整任务回退单流（`RANGE_IGNORED_TOLERANCE = 3`），
因为偶发 200 可能只是 CDN 限流的中间态。

### 4.6 慢连接抢占：整套实现里最"反直觉"的一段

网盘 CDN 按连接限速，且单条连接可能落到慢节点。真机日志（70.6 MB 文件）实测：
多数连接 40–80 KB/s，个别只有 3–7 KB/s。慢分片如果正好是收尾时唯一在跑的那几路，
总速会塌到 KB 级 —— 日志里出现过 **64 路里 61 路空转 37 秒，只为等最后 500 KB**。

看门狗（每 5 s）判定条件：

```kotlin
floor = max(PREEMPT_MIN_BPS /*12KB/s*/, 本任务单路均速 / 2)
慢 = 瞬时速度 < floor  或  连续 20 s 一个字节都没收到
且  已跑 >= 15 s（收尾时 >= 3 s）
且  距上次抢占 >= 10 s 冷却
且  剩余 >= 128 KB
且  该片被抢占次数 < 3
且  每轮最多抢占 2 路
```

命中后做的事不是"标记失败重试"，而是：

1. 置位 `preempt` 标志；
2. **主动 `call.cancel()` 掐断这条连接**；
3. 已写入字节全部保留，下一次请求从 `partFile.length()` 续传；
4. 不退避、不计失败次数 —— 语义是"换一条路"，不是"这一片坏了"。

为什么必须主动 cancel：标志位只在读循环里检查，而连接被 CDN 挂住时 `input.read()` 会一直阻塞到读超时，
循环根本没机会跑。项目在 2026-10-23 的用户反馈里踩过这个坑（"点重连没用"），
之后才补上 `activeChunkCalls: Map<chunkKey, Call>` 逐分片登记、直接 cancel。

### 4.7 暂停/删除：同样靠 cancel

每个任务的所有 `Call` 登记在 `activeCalls[taskId]`，暂停/删除时逐个 `cancel()`，
让阻塞中的 `read()` 立刻抛 `IOException`。同时协程 `Job.invokeOnCompletion { call.cancel() }` 兜底。
等待任务退出的上限是 10 s —— 阻塞式 IO 不响应协程取消，不能无限等，否则按钮"点不动"。

### 4.8 分片级 SHA-256 与流式合并

- 写入分片时把字节增量喂给 `MessageDigest`，**不额外读盘**；
- 断点续传时先把已有前缀读一遍喂进摘要，保证摘要是"整个 part"的；
- 合并时逐片重算并与下载时记录的摘要比对，不一致直接抛错，**不产出损坏文件**；
- 合并是流式的：写一片、删一片，峰值占用 ≈ 文件大小 + 一个分片。
  早期"先合并成完整副本、再复制到公共目录"的实现在 6 GB 文件上会因峰值 3 份副本而 ENOSPC。

### 4.9 续传的安全边界：计划签名

分片文件按索引命名（`part_0`, `part_1`…），但它们的**字节区间是从 chunkCount 和 total 推导出来的**。
如果用户中途改了线程数，或者服务器探测到的大小变了，旧 part 的区间就会错位，续传会拼出损坏文件。

项目用 `plan.txt` 记录 `chunks=… total=… main=…`，不一致时整目录清空重下。
同时每次启动都用磁盘真实长度回写进度（双向校正），避免历史版本写入的虚高进度让任务永远停在 100%。

### 4.10 多源分片（实验性）

同一文件的多条直链（不同账号）按分片序号轮转分配，每条直链带自己的请求头。
分片规划一个字节都不动，因此与单源共用同一套断点续传。

---

## 5. 关键常量速查

| 常量 | 值 | 作用 |
| --- | ---: | --- |
| `BUFFER_SIZE` | 64 KB | 单路读缓冲；曾用 256 KB，是 Java 堆被打满的主因 |
| `MIN_CHUNK_BYTES` | 256 KB | 分片数下限约束，小文件也能切出盈余片 |
| 分片数上限 | 512 | FD 与内存折中 |
| `RANGE_WORKERS_CAP` | 8 | 迅雷类 CDN 的并发 Range 阈值 |
| `STAGGER_MS` | 25 ms | 错峰建连，最多叠 8 个 |
| `PREEMPT_TICK_MS` | 5 s | 看门狗采样周期 |
| `PREEMPT_MIN_BPS` | 12 KB/s | 慢连接绝对下限 |
| `PREEMPT_MIN_AGE_MS` | 15 s | 避开 TCP 爬坡 |
| `PREEMPT_COOLDOWN_MS` | 10 s | 同一片两次抢占的间隔 |
| `PREEMPT_MAX` | 3 | 单片的换连接上限，防重连风暴 |
| `PREEMPT_MIN_REMAIN` | 128 KB | 剩余太少不值得换 |
| `CHUNK_RETRIES` / `RANGE_RETRIES` | 3 / 4 | IO 重试 / Range 重试 |
| `RANGE_IGNORED_TOLERANCE` | 3 | 偶发 200 的容忍次数 |
| 主池占比 | 70% | 剩余 30% 交给弹性分配器 |
| 弹性块 | 256 KB–4 MB | 单 worker 5 秒的量，尾部可缩到 64 KB |

---

## 6. 三个反直觉的设计取舍

1. **线程不是越多越好。** 超过 CDN 的单文件并发阈值后，多余请求会被降级成 200 整文件，
   反而触发整任务回退单流，速度暴跌。所以迅雷被硬限制在 8 路。
2. **慢连接不是"失败"，是"路由问题"。** 按失败重试会退避、会计入失败次数、可能耗尽重试额度；
   正确的语义是"立刻换一条连接，从已收字节继续"。
3. **分片不是越大越好，也不是越小越好。** 大块减少请求开销但拖长收尾；小块并行充分但请求爆炸。
   解法不是选一个固定值，而是让块大小跟随实测速度，并在尾部按剩余量均分。

---

## 7. 局限与风险

- **账号风控**：百度等平台对第三方直链下载敏感，高并发可能触发限流甚至封禁。原项目 README 明确建议不要用主力账号。
- **解析层易失效**：分享页换取直链的接口是私有的、随时会变。这是本项目（YunFlow）不内置解析器的原因。
- **不是"破解"**：加速只作用于服务端本身支持 Range 的资源；不支持 Range 的链接只能单流。
- **合规**：工具不改变内容版权归属，只改变传输方式。

---

## 8. YunFlow 的对应实现

| 云析（Kotlin） | YunFlow（TypeScript / Node） | 说明 |
| --- | --- | --- |
| `HttpRangePolicy` | `engine/http.ts` `parseContentRange` / `contentRangeMatches` | 同样的严格校验 |
| `getTotalSize` | `probeResource` | 0-0 探测 + HTML 拒绝 + 200 回退 |
| `chunkCountFor` | `chunk-plan.ts` `chunkCountFor` | 同样的阈值与 256 KB / 512 上限 |
| `ElasticAllocator` | `elastic-allocator.ts` | 速度自适应 + 尾部收缩 |
| `inflightLimiter` Semaphore | `util.ts` `Semaphore` | 进程级在飞配额，可在设置中调整 |
| `ThreadPoolExecutor` | Node HTTP 连接 + libuv 线程池 | 并发单位是连接；磁盘写入异步下发 |
| `downloadChunk` | `chunk-downloader.ts` | 续传、截断、三态返回、退避 |
| 看门狗 + `call.cancel()` | `speed-watchdog.ts` + `AbortController` | 主动 abort 是唯一可靠的中断手段 |
| `mergeChunksToStream` | `task.ts` `mergeRanged` | 逐片摘要校验 + 边写边删 |
| `plan.txt` | `plan.json` | 计划签名，变更即清空 |
| `DownloadService` | `manager.ts` + IPC | 队列、持久化、广播 |

差异（必须说明）：

- 云析是 Android 应用，解析层内置六家网盘；YunFlow 是桌面应用，**只做传输加速**，
  直链由用户在网页端获取或通过插件式解析器接入（见 README「支持范围」）。
- 云析用协程 + 独立线程池；Node 的并发单位是 HTTP 连接，磁盘 IO 由 libuv 线程池异步完成，
  因此没有等价的"256 个线程"概念，但连接级并发的加速效果一致。
- YunFlow 增加了分片地图可视化、每路实时速度、以及可配置的看门狗参数。

---

## 9. 许可

YunX 以 **AGPL-3.0** 发布，Copyright (C) 2026 CYQawa。
YunFlow 是对其设计的研究与重新实现，同样以 **AGPL-3.0-or-later** 发布，
并在每个源文件头部与 `NOTICE` 中保留原项目的版权与许可声明。若通过网络使用本软件，
依据 AGPL-3.0 第 13 条，用户有权获得对应源代码。
