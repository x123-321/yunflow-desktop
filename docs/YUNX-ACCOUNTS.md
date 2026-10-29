# YunX 的账号层是怎么做的

> 分析对象：[`CYQawa/YunX`](https://github.com/CYQawa/YunX)，AGPL-3.0，Copyright (C) 2026 CYQawa。
> 本文只讲"登录 → 账号/容量 → 文件列表 → 取直链 → 转存"这一层，下载引擎见 [YUNX-ANALYSIS.md](./YUNX-ANALYSIS.md)。

## 0. 一句话

它没有接入任何"开放平台"，而是把每一家网盘**网页版/客户端在用的私有接口**抓下来，
做成 **每个平台一套客户端 + 一套仓库**。六家网盘 = 六份互不相同的鉴权方式、字段名和签名规则。

```
ui/login/*.kt                每家一个登录界面（WebView 或表单）
        │  凭证
        ▼
data/db/*AccountEntity.kt    Room 表，一家一张（支持多账号）
        │
        ▼
data/network/*Api.kt         每家一个 API 客户端：容量 / 文件列表 / 取链 / 转存
        │
        ▼
data/repository/*Repository  每家一个业务编排：AccountRepository + ResolveRepository
        │
        ▼
ui/viewmodel/DriveQuotaViewModel.kt   并发拉所有已登录平台的容量
ui/screens/DriveScreen.kt             账号卡片 + 容量条 + 文件浏览器
```

规模感：`QuarkApi.kt` 752 行、`UCApi.kt` 876 行、`XunleiApi.kt` 1175 行、`Pan123Api.kt` 759 行、
`C139Api.kt` 804 行。**光是五家的网络层就有 4300 多行**，还不含登录界面与仓库。

## 1. 登录：三条完全不同的路线

### A. WebView + CookieManager（夸克 / UC / 百度 / 139 / 115）

打开官网登录页，让用户在官方页面完成扫码/密码/短信，然后从 Android 的 `CookieManager` 把整串 Cookie 读出来：

```kotlin
// ui/login/QuarkLoginScreen.kt:134
sampleCredential = { CookieManager.getInstance().getCookie(QuarkConstants.COOKIE_DOMAIN).orEmpty() }
```

`WebLoginAutoDetect.kt` 负责在页面跳转后判断"是不是登录成功了"（URL 特征 / 页面元素），
成功后自动抓取并落库。这是最省事、也最稳的一条路，因为验证码、风控全由官方页面处理。

### B. 表单 + 私有登录接口（123 云盘）

```kotlin
// data/network/Pan123Api.kt:104
// POST https://user.123pan.cn/api/user/sign_in  →  data.token（authorToken）
```

请求要带 `platform: web`、`app-version`、`loginuuid` 等头部。项目还写了
`Pan123LoginSupport.kt` 专门做**错误归类**：HTTP 429 / 业务 429 / 文案含"频繁" → 提示稍后重试；
含"验证码/滑块" → 直接引导去网页登录（网页通道不受这套风控限制）；账号冻结 → 提示去官方客户端检查。
服务端文案只用于分类，**一个字都不回显**（可能把账号甚至密码回显出来）。

### C. 验证码盾 + 密码 + 短信（迅雷）

`XunleiApi.kt` 里是一条完整的状态机：

```
captcha/init（带 captcha_sign：10-salt 算法 + 真实 user_id）
   → v3/login（密码，可能返回 review_panel 1007 要求短信）
   → sendsms（拿 creditkey / token）
   → smslogin
   → v1/auth/token（access_token + refresh_token）
```

之后每个 pan 请求都要带 `access_token`、`device_id`、`X-Captcha-Token`；401 时用 refresh_token 自动续期。
captcha token 只有 300 秒，还得按设备号缓存——不同账号的 captcha 不能串用。

## 2. 凭证怎么存

- 一家一张 Room 表（`QuarkAccountEntity`、`BaiduAccountEntity`…），支持同一平台存多个账号。
- 早期用 AndroidKeyStore 做 AES 加密（`SecureAccountDaos` 的注释里能看到迁移逻辑），
  2026-10 起改为**明文直通**（`PlaintextCredentialCipher`），只保留旧密文的兼容读取。
- 另有 `AuthBackupManager` + `AuthCrypto`：导出认证备份时用「用户口令派生密钥 + AES-GCM」加密成 JSON。

## 3. 账号昵称与容量：每家一个接口，字段各不相同

| 平台 | 接口 | 字段 |
| --- | --- | --- |
| 夸克 | `GET drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc` | `use_capacity` / `total_capacity` |
| 百度 | `GET yun.baidu.com/api/quota?clienttype=0&app_id=…` | `used` / `total`（另需 `X-Requested-With`、Referer） |
| 迅雷 | `GET /drive/v1/about` | `quota.usage` / `quota.limit` / `usage_in_trash` |
| 123 | `GET /b/api/user/info` | `SpaceUsed` / `SpacePermanent` / `SpaceTemp`，昵称 `Nickname` |
| 百度昵称 | `GET pan.baidu.com/api/gettemplatevariable?fields=["username"]` | `username` |
| 115 昵称 | `GET /user/info` | 见 `Pan115Api.fetchNickname` |

`DriveQuotaViewModel` 的做法很直接：`coroutineScope { launch { … } }` 并发拉八家，
未登录的平台跳过，单家失败 `runCatching` 置空，不阻塞其他平台。

**注意**：没有统一标准。字段名、鉴权方式（Cookie / token / token+设备号+验证码头）、
错误码全都不一样，这就是"账号层"贵的原因。

## 4. 文件列表

以夸克为例（`QuarkApi.listCloudFiles`）：

```
GET /1/clouddrive/file/sort
    ?pdir_fid=0            ← 目录 id，0 是根
    &_page=1&_size=100
    &_fetch_total=1&_fetch_sub_dirs=0
    &_sort=file_type:asc,updated_at:desc
```

响应 `data.list[]`：`fid` / `file_name` / `size` / `dir`（是否目录）/ `pdir_fid` / `updated_at`。
项目自己做了翻页（单页满 100 继续，封顶 100 页防死循环）。

界面上的"进目录"就是换 `pdir_fid` 再请求一次；"面包屑"是维护一条 `pdir_fid` 栈。
点文件 → `getDownloadLink(fid, cookie)` 换直链 → 交给分片引擎。

## 5. 分享链接：转存到自己的网盘再下载

这是"手机版很方便"的关键链路（`QuarkResolveRepository`）：

```
分享页 → getShareFiles(pwd_id, stoken, pdir_fid)   拿到分享里的文件列表
       → saveShareFile(...)                        转存，返回 task_id（异步任务）
       → 轮询 /1/clouddrive/task 直到完成            拿到转存后的新 fid
       → getDownloadLink(新 fid)                    换直链
       → 下载完成后 deleteFile(临时目录)             取链即删
```

几个真实的坑（都写在代码注释里）：

- 转存是**异步任务**，不轮询就拿不到新 fid；
- 转存后 **fid 会变**，必须用新 fid 取链，否则 `404 code:21001`；
- 二次转存会命中"已删除的 fid"，所以每次转存都放到
  `YunX临时转存/tr_<时间戳>_<随机>` 的唯一子目录里；
- 还有一条"免转存取链"路径：直接把分享凭证（pwd_id / stoken / fids / share_fid_token）
  交给 `file/download`，省掉建目录→转存→轮询→删除整条链路（部分分享类型不支持）。

## 6. 多账号与多源下载

一家一张表、可存多个账号；下载时可以把同一文件的多条直链（不同账号）按分片序号轮转，
每条直链带自己账号的请求头——这就是 `DownloadManager` 里的"多源分片"。

## 7. 维护成本

原项目的注释本身就是一部踩坑史：token 300 秒过期、风控降级 token、二次转存 fid 失效、
网页接口形态变化（3xx）、CDN 并发阈值……这些都不是"写一次就完"的代码，而是**跟着平台更新持续修**。

## 8. 与 YunFlow 的差距

| 层 | YunX | YunFlow 现状 |
| --- | --- | --- |
| 登录 | 每家一个登录页（WebView / 表单 / 短信） | 统一的内嵌官方登录页，抓 Cookie |
| 凭证存储 | Room，早期加密、后期明文 | `safeStorage` 加密（DPAPI/Keychain/libsecret） |
| 账号昵称/容量 | 每家一个接口 | **未实现**（缺平台适配器） |
| 文件列表 | 每家一个接口 + 翻页 + 面包屑 | **未实现** |
| 分享转存 | 每家一套 | **未实现** |
| 取直链 | 每家一套 | 用户手动粘贴直链 |
| 分片下载 | 自研引擎 | 已对齐（512/32 路、看门狗、摘要校验） |

也就是说：**下载引擎这一半已经对齐，账号层只完成了"登录态"这一层**。
剩下的是六份 API 适配器——技术上可行，但必须逐平台抓包、逐字段验证，且需要真实账号。

## 9. 如果要移植

1. 选一个平台，登录后抓 `user/info` 与 `file/list` 的返回；
2. 在 `src/main/adapters/<platform>.ts` 实现 `getProfile()` / `listFiles()` / `getDownloadUrl()`；
3. UI 复用「网盘账号」卡片，加容量条与文件列表抽屉；
4. 每加一家重复一次，签名/字段变化时只改那一个适配器。

许可提醒：YunX 是 AGPL-3.0。直接移植它的接口实现（而不只是参考字段）属于衍生作品，
本项目同为 AGPL-3.0，需保留版权与许可声明，并在 `NOTICE` 中注明来源。
