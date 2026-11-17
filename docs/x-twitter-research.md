# X（推特）访问能力调研

## 一页白话摘要

**2026-11-17 已确认产品边界：**「其实我们只做能力基座就好了，用户自己想用就是自己填」。CogineBot 只提供接入能力；用户自行创建开发者应用、填写凭据、承担费用，并决定权限与用量。产品不建立官方 X 账号，不统一采购 API 额度，不设置 X 预算，不做自动发帖策略或运营功能。

**结论：现有能力基座已经支持用户自填凭据接入官方远程 X MCP，不需要新增产品代码。** 当前没有专门的 X 产品封装；本调研也没有使用真实 X 账号或 API 验证结果。普通网页搜索与读取不等于 X connector。用户可按[配置说明](#8-用户怎么自己接-x)使用已有通道；写能力的特定缺口留待有需求再做。

- **最直接的只读候选是 X 官方远程 MCP。** 官方提供 `https://api.x.com/mcp?read_only=true`；CogineBot 已支持远程 HTTP MCP 和加密凭据。它仍需要 X 开发者应用及付费 API 额度，不是免费公共搜索。尚未连接或实测。[官方接入说明](https://docs.x.com/tools/mcp)
- **现有 Composio 框架也能承接 Twitter 工具集。** 但 Composio 已取消 Twitter 托管 OAuth，必须自备 X 开发者应用；目录里有工具，不代表部署已配置、账号已授权或有足够额度。[工具集说明](https://docs.composio.dev/toolkits/twitter.md)
- **当前官方 API 已以预付额度、按量付费为主。** 普通推文读取约 $5/千条；普通发帖 $0.015/次，带 URL $0.20/次。旧 Free／Basic／Pro 套餐不能当作新接入报价。[官方价格](https://docs.x.com/x-api/getting-started/pricing)
- **读和写要分开考虑。** 普通发帖、回复、私信是不同权限与政策边界。自助 API 回复有“被原作者提及或引用”的限制，AI 自动回复另需 X 书面批准。[变更记录](https://docs.x.com/changelog)、[自动化规则](https://help.x.com/en/rules-and-policies/x-automation)
- **第三方数据服务读公开内容便宜，但要核实数据授权与持续可用性。** 例如 TwitterAPI.io 的推文标价约 $0.15/千条；其写功能另需账号登录 cookies，不能把便宜的只读服务等同于安全的代发能力。[第三方价格](https://twitterapi.io/pricing)、[写接口](https://docs.twitterapi.io/api-reference/endpoint/create_tweet_v2)
- **不建议把网页自动化或 RSS 抓取作为产品主路径。** X 明确限制非 API 自动化及未经许可的抓取；RSSHub 仍有 Twitter 路由，但需要上游认证，Nitter 还披露收到 X 停运要求。[X 条款](https://x.com/en/tos)、[RSSHub 源码](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/user.ts)、[Nitter 声明](https://github.com/zedeus/nitter#readme)

**接入方向：** 优先复用现有远程 MCP／API 连接与秘密存储，让用户自己填写凭据、选择权限。下文方案比较作为历史研究保留，不构成产品账号、预算或运营方案。

~~需要需求方决定账号、开发者应用、预算、读写范围、读量与频率。~~ **已取消这些产品决策前置项：上述选择均由使用者自行配置。** 配置能力与安全边界仍需产品验证，平台授权或付费资格不能由本地权限选择代替。

---

## 1. 调研范围与证据边界

- 查询日期：**2026-11-16**。金额为美元，未含税、模型、机器、代理或运维成本。公网资料可能变化，实施时需再次核价。
- 代码基线：`2519b5db9452c291846e42bdf41f9d8e3fb8d583`。下文 `文件:行号` 均以此为准，链接相对于本文。
- “X”专指 X.com／Twitter。仓库中的 `coginex`、测试里的“X fixture”以及 Linux 的 X display 都不是 Twitter。
- 检查了原生应用枚举、provider 注册、第三方目录、MCP、插件、技能、HTTP 凭据与浏览器通道；检索 `twitter`、`tweet`、`api.x.com`、`nitter`、`rsshub`。营销页的 Twitter 分享 metadata 不计为集成。
- **未读取运行实例的数据库、秘密或账号配置，也未访问带凭据的外部工具目录。** 因此可以判断仓库实现和公开产品能力，不能断言某个线上实例“一定已连接”或“一定没连接”。当前研究会话的工具也不等于 CogineBot 产品内的工具。
- 2026-11-16 首轮仅调研；2026-11-17 续轮范围已收窄为确认产品边界、补用户配置说明并提交 docs。不写产品代码、不建 card 分支、不开代码 PR；不发真实 X API 请求、不创建开发者账号。本文不包含内部任务链接、真实账号或凭据。

选择 `docs/`：已有 [native-connectors.md](native-connectors.md)、[github-plugins.md](github-plugins.md) 和 [bot-secrets.md](bot-secrets.md)，适合把代码证据和接入方式放在一起；本轮仅补使用说明，不建立运营类 Release feature。

## 2. 现状：每项到底能不能用

### 2.1 用户能力逐项核查

表中“未内置”指没有 X 专用实现，不代表通用通道绝对无法访问。原生 inventory 的共同证据是 [native-connectors.ts](../packages/contracts/src/native-connectors.ts):15、[native-remaining-apps.ts](../packages/contracts/src/native-remaining-apps.ts):3 和 [provider.ts](../packages/adapters/src/native-connectors/provider.ts):74，三者覆盖的应用均无 Twitter。

| 能力 | 当前仓库结论 | 代码／配置出处与限制 |
| --- | --- | --- |
| 按链接或 ID 读帖子 | 未内置 X lookup；公开网页读取可能拿到片段，未验证 X 正文可达性 | [builtin-tools.ts](../packages/adapters/src/builtin-tools.ts):608 的 `web_fetch` 不执行 JavaScript，不带 X 登录态；原生 inventory 见上 |
| 搜索帖子 | 有普通网页搜索，无内置 X 搜索 endpoint | 同文件:591 的 `web_search` 返回公共网页标题、链接、摘要；不是 X recent／archive search。Composio 动态路径见下一表 |
| 看账号、账号帖子和时间线 | 无内置 X 用户查询和时间线；网页可能仅返回部分可见内容 | 同文件:223、235 的导航／快照是通用浏览器能力，不能保证时间线完整、有序或分页；原生 inventory 见上 |
| 发帖 | 无内置 X 发帖 action、账号授权或发布回执 | [provider.ts](../packages/adapters/src/native-connectors/provider.ts):74、443 仅执行已注册应用的 action；通用 MCP／Composio 可扩展，但未提供已配置实例证据 |
| 回复 | 无内置 X reply action 或专门的回复政策验证 | 同上；通用 `browser_act`（[builtin-tools.ts](../packages/adapters/src/builtin-tools.ts):242）能点击网页，但技术可点击不代表允许自动回复 |
| 读取私信 | 无内置 X DM 查询、用户授权或专用隐私处理流程 | 原生 inventory 见上；公开搜索／抓取不能读取账号私信；需要 user-context 授权或登录态 |
| 发送私信 | 无内置 X DM send action、收件人许可验证或专用发送回执 | [provider.ts](../packages/adapters/src/native-connectors/provider.ts):443；外部工具集提供候选，未连接或验证 |

### 2.2 现成框架与候选入口

| 入口 | 仓库已经有什么 | X 的现成程度 |
| --- | --- | --- |
| Composio | [composio-connector.ts](../packages/adapters/src/composio-connector.ts):342 建 session，:442／474 动态取得目录，:653 发起授权；[integration-provider-settings.ts](../packages/adapters/src/integration-provider-settings.ts):95 把平台凭据交给 SecretStore | **已有通用 provider，外部有 Twitter toolkit。** 公共目录列出读、搜索、发帖、回复、DM 工具；但 Twitter 已要求自备 OAuth 应用。代码 `session.authorize` 未显式选择 auth-config ID，能否使用该项目的 custom auth config 需下一轮验证，不能保证零代码 |
| Pipedream | [pipedream-connector.ts](../packages/adapters/src/pipedream-connector.ts):138 动态目录，:161 查健康连接；[worker/index.ts](../apps/worker/src/index.ts):161 提供可选配置 | 有框架；本轮未取得当前 Twitter 可用条目的可靠证据。公开候选 app 页面返回 404；不能把旧教程或 slug 当成当前可用性，也不能据此断言服务永久下线 |
| MCP | [contracts/mcp.ts](../packages/contracts/src/mcp.ts):3 支持 Streamable HTTP、SSE、stdio；[mcp-connector.ts](../packages/adapters/src/mcp-connector.ts):386 工具 allowlist，:794 载入加密材料，:836 区分 stdio／远程连接 | **可配置官方／外部 X MCP，未见内置 X endpoint。** HTTP 方案最贴合现状；stdio 需显式开关和命令白名单，默认不是直接运行任意 npm 包 |
| GitHub 插件 | [plugin-connectors.ts](../packages/adapters/src/plugin-connectors.ts):19、26 和 [github-plugins.md](github-plugins.md):15 | 导入独立 SKILL.md 与远程 HTTP/SSE 定义；不运行仓库代码，不导入 stdio／hook／配套文件。server 安装后禁用且没有工具权限。普通 Twitter MCP 仓库不一定是可直接导入的插件 |
| Skill | [builtin-skills.ts](../packages/adapters/src/builtin-skills.ts):8 仅列通用 review skill；[skill-tools.ts](../packages/adapters/src/skill-tools.ts):14 支持用户／插件 skill | 未发现内置 Twitter skill；skill 是操作说明，不能凭空提供 API 权限、额度或登录态；运行实例可能另装，未检查 |
| 通用 HTTP API／OpenAPI | [installed-connectors.ts](../packages/adapters/src/installed-connectors.ts):78、94 定义 operations，:256 发现 API 工具，:418 限定凭据所有者 | 单 Bearer／API-key 的只读 X 或第三方 API 可利用此通道；需配置 operation schema、分页和权限，不是已有 X integration；签名、多凭据、OAuth 刷新应由 adapter 负责 |
| 受保护的 HTTP 请求 | [bot-secrets.md](bot-secrets.md):19、[builtin-tools.ts](../packages/adapters/src/builtin-tools.ts):408、432 | `request_secret`／`secret_request` 能让后端注入 Bearer 或命名 header，并限制 origin；有凭据后理论上可请求 X，未配置或调用。没有 OAuth 刷新或 OAuth1 签名能力 |
| 浏览器与电脑 | [builtin-tools.ts](../packages/adapters/src/builtin-tools.ts):223、235、242；[computer-runtime.md](computer-runtime.md):19、34、96 | 已有导航、快照、点击、输入，浏览器 profile 可持久化。没有 X 专用流程／selector／测试；容器内 profile 与 Team 共用 OS 边界，不是每个 bot 的强安全隔离 |

Composio 公共工具目录证据：[`TWITTER_RECENT_SEARCH`、`TWITTER_CREATION_OF_A_POST`、`TWITTER_SEND_A_NEW_MESSAGE_TO_A_USER` 等](https://docs.composio.dev/toolkits/twitter.md)。这些是外部声明，不是本仓库添加的工具，也未证明相应 endpoint 已获准使用。

### 2.3 新 connector 应怎样接入

现有调用链是 shared frontend → 后端工具发现与审批 → `ConnectorRegistry` → provider → 远端服务。契约位于 [interfaces.ts](../packages/adapter-kit/src/interfaces.ts):215 的 `ConnectorProvider`；带目录／账号生命周期时用 :243 的 `ManagedConnectorProvider`。工具 schema、`readOnly`、账号 route、`beforeDispatch` 位于 [types.ts](../packages/adapter-kit/src/types.ts):285。注册与 dispatch 在 [composio-connector.ts](../packages/adapters/src/composio-connector.ts):852、920；API 与 worker 的 composition root 分别见 [app.ts](../apps/api/src/app.ts):485 和 [index.ts](../apps/worker/src/index.ts):194。

可复用的层次（均为未来接入说明，本轮未配置）：

1. **配置现有远程 MCP 或 API operations**：不需要先造 provider，后端继续处理凭据与权限。只读优先给明确工具 allowlist；不能因为操作被叫作“search”就把写操作降格。
2. **复用 Composio**：配置现有 integration provider、上游 custom OAuth、成员账号连接与 bot 工具权限；动态目录负责发现。上游认证与当前 SDK 的兼容性需要验证。
3. **增加官方原生 adapter**：沿用 `native-connectors/` 的 app inventory、`NativeAction`、config、OAuth、HTTP client、账号绑定、错误分类与回执。需要扩展共享 contracts 和原生 app 配置，而不是仅在前端加一个按钮；API 与 worker 都须接入。
4. **确定性离线验收**：以 [collaboration-conformance.ts](../packages/adapters/src/native-connectors/collaboration-conformance.ts):120 的冻结 contract／fixture 模式为参考，覆盖 schema、真实协议映射、读写声明、分页、429、token 撤销、账号隔离和写入结果不确定。现成 helper 有 app 类型限制，不能直接假定 X 已受支持。线上授权、价格和审核需另行验收，离线测试不能证明它们。

Web／Electron 共用 web UI；mobile 走同一后端。现有插件 OAuth 在 mobile 需打开 Web 完成并回查状态（[github-plugins.md](github-plugins.md):45）；新增方案需沿用这种明确降级或补原生 flow。不能仅在开发者电脑装 CLI 就声称三端已集成。所有厂商协议留在 adapters，平台密钥用通用连接设置，不能新增产品专用 `TWITTER_*` 环境变量代替配置；外部 server 自身的变量不等于产品配置。

## 3. 官方 X API：当前档位、费用、权限

### 3.1 当前可依赖的报价边界

| 方案／档位 | 能力与限额 | 费用与开通 |
| --- | --- | --- |
| Pay-per-use 自助 | 公共帖子／用户读取、最近 7 天与全历史搜索；有权限的发帖、有限回复、DM。每账期最多 300 万条 Post reads，另有各 endpoint 的速率限制 | 预付 credits、按返回资源或写请求收费；无固定订阅或最低消费承诺。用 X 账号进入开发者控制台、接受协议、描述用途、创建 app，取得凭据及额度 |
| Enterprise | 更大读取量、合同约定访问和限额；不是默认所有能力无限制 | 价格与额度需询价和商务／用途评估；公共页面未给可核实的固定总价或审核时长 |
| 旧 Free／Basic／Pro | 当前主价格页不再给这些档位的新客价目与完整权限表；旧文档、旧账户权益不能外推 | 不将常见历史月费或旧读写配额列作当前可购方案；现存账户只能由其控制台确认，本轮未登录 |
| Public Utility／活动赠额 | 变更记录曾提及公共公益访问与旧用户赠额；不构成普通商业 bot 的自动资格 | 不纳入“免费可用”预算；资格／购买条件以当前页面和控制台为准，本轮不申请 |

来源：[价格](https://docs.x.com/x-api/getting-started/pricing)、[用量与账单](https://docs.x.com/x-api/fundamentals/post-cap)、[开户步骤](https://docs.x.com/x-api/getting-started/getting-access)、[搜索范围](https://docs.x.com/x-api/posts/search/introduction)、[Enterprise 申请入口](https://docs.x.com/forms/enterprise-api-interest)、[历史变更](https://docs.x.com/changelog)。均于 2026-11-16 查询。旧公告说 Basic／Pro 当时仍可用，不等于今天还向新客销售；这里保留该不确定性。

| 本次需求相关项目 | 当前公开单价 |
| --- | --- |
| 普通 Post 读取 | $0.005／条返回资源 |
| 用户资料读取、DM event 读取 | 各 $0.010／资源 |
| 自有数据 Owned Reads（限定 endpoint、认证用户为 app owner） | $0.001／资源，不能套用于任意账号或所有查询 |
| 普通发帖／带 URL 发帖／符合 summoned 条件的回复 | 分别 $0.015／$0.200／$0.010 每请求 |
| 创建 DM interaction | $0.015／请求 |

来源：[官方单价与 Owned Reads 条件](https://docs.x.com/x-api/getting-started/pricing)。读取按返回资源计费，不是“一次搜索只算一次”；扩展用户等资源可能另计。官方说明同一 UTC 日通常会去重，但只是软保证，不能把重复轮询估成永久免费。

示例预算（按上表计算的估算，不是报价）：10,000 条普通帖子约 **$50**；100,000 条约 **$500**；1,000 次普通发帖约 **$15**，1,000 次带 URL 发帖约 **$200**。均不含用户 expansion、DM 和基础设施。自助月读取上限不是预付固定包含量，也不是可任意提高的预算开关。

### 3.2 速率限制与读写差别

| endpoint | 每 App | 每 User |
| --- | --- | --- |
| `GET /2/tweets/:id` | 450／15 分钟 | 900／15 分钟 |
| `GET /2/tweets/search/recent` | 450／15 分钟 | 300／15 分钟 |
| `GET /2/tweets/search/all` | 1／秒，300／15 分钟 | 1／秒 |
| `GET /2/users/:id/tweets` | 10,000／15 分钟 | 900／15 分钟 |
| `POST /2/tweets`（发帖／回复） | 10,000／24 小时 | 100／15 分钟 |
| `GET /2/dm_events` | 不适用 | 15／15 分钟 |
| `POST /2/dm_conversations/with/:participant_id/messages` | 1,440／24 小时 | 15／15 分钟，1,440／24 小时 |

来源：[官方 rate-limits 表](https://docs.x.com/x-api/fundamentals/rate-limits)，查询 2026-11-16；App／User 是对应认证上下文的限制，不能相加。实际还受余额、账号资格、其他上限及响应头约束。429 应尊重 reset／退避，不能换账号规避。

公开读取可用 app-only Bearer；访问受保护内容要有被授权用户的合法访问权，付款不授予私人数据权限。写入与 DM 需要 user-context OAuth；优先 OAuth2 PKCE，读 scopes 从 `tweet.read`／`users.read` 开始，写才加 `tweet.write`，DM 另配 `dm.read`／`dm.write`；长期 refresh 需要 `offline.access`。OAuth1.0a 需要签名和 token secret，通用 Bearer 请求无法替代。[官方凭据说明](https://docs.x.com/x-api/getting-started/getting-access)、[OAuth2 流程](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token)

私信查询只覆盖认证用户可访问的对话，官方 lookup 文档为最近 30 天事件；不是任意账号的全部历史 DM。发送需同时具备 `dm.write`、`dm.read`、`tweet.read`、`users.read`，还会受接收方设置限制。[DM lookup](https://docs.x.com/x-api/direct-messages/lookup/introduction)、[DM 集成指南](https://docs.x.com/x-api/direct-messages/manage/integrate)

自助 API 的回复限于原作者已 @mention 该账号或引用其帖子的 summoned 场景；不能把发帖 endpoint 的存在解读为任意回复。API 付费、OAuth 同意、AI 自动回复书面批准分别是三件事。批量骚扰、非自愿自动 DM 都有政策风险。[官方 2026-02-23 变更](https://docs.x.com/changelog)、[自动化规则](https://help.x.com/en/rules-and-policies/x-automation)

### 3.3 官方 REST 与官方 MCP 的接入成本

**官方远程 MCP（只读首选候选）。** `https://api.x.com/mcp?read_only=true` 是数据 MCP；`https://docs.x.com/mcp` 只搜索开发文档，两者不能混淆。前者支持 app-only Bearer 直连和 Streamable HTTP，适配当前 MCP header 凭据通道；没有标准 MCP OAuth discovery／动态客户端注册，不能指望产品“Sign in”自动完成 X 用户授权。用户上下文官方提供 `xurl mcp` bridge，token 默认缓存于 `~/.xurl`。只读参数在服务端过滤并拒绝写工具，但仍应设本地 allowlist。[官方 MCP](https://docs.x.com/tools/mcp)

- 凭据：app-only token 放 CogineBot 现有加密 MCP credential material，不放 endpoint query、SKILL.md、代码或聊天。bridge 的本地缓存不属于现有 SecretStore；若以后采用，需另做用户隔离、refresh／撤销及主机安全评估，不能共享 worker home 给不同账号。
- 读写：文档确认读取、搜索、用户等；托管 server 的能力清单并非 REST 全量清单。是否有本需求所有发帖／DM 工具必须未来 `tools/list` 后确认，不能按其他 MCP 包的名字补齐。
- 限流／费用／风险：按官方 API 额度与政策执行；未见单独 MCP 加价承诺，预算不能假设免费。只读 app token 不会赋予代发身份，泄露仍会消耗额度。
- 工作量估计：已有开发者 app／额度后，**0.5–2 人日**做只读接入与兼容验证；是待验估计，未证明零代码。stdio bridge 还需运行环境／超时与账号隔离工作，不建议首轮引入。

**官方 REST 原生 adapter。** 公共读可先用已安装 API operations；稳定分页、账户生命周期、预算、退避与写入恢复更适合 native adapter。client secret、access／refresh token 由后端现有 SecretStore 保存，部署所有者配 app，成员另行授权（参见 [native-connectors.md](native-connectors.md):8、46）。OAuth authority、scopes、refresh 和 API 翻译在 adapter 内，frontend 只表达意图。

工作量估计：只读正式 adapter **3–5 人日**；加用户 OAuth、普通文本发帖与结果恢复 **再 3–5 人日**；DM **再 2–4 人日**；含共享配置、离线测试和三端基本验收，不含媒体／stream／事件订阅。所有估计不含 X 审核等待；没有公开承诺的审批 SLA。开户公开步骤未把 X Premium 列为普通读取的前提；不能由此保证任意账号获批或高级内容能力。

## 4. 第三方服务与现成 MCP

### 4.1 Composio：现有框架上的现成工具集

- **认证与存储：** 产品使用 Composio Platform，不是个人 For You。平台 key 已有通用集成设置和加密存储；X app 的 client credentials／用户 token 由 Composio custom auth 配置托管。本地保存绑定后的 connection reference。额外增加一方能接触数据与凭据。[现有实现](../packages/adapters/src/integration-provider-settings.ts):78、95、[授权入口](../packages/adapters/src/composio-connector.ts):653
- **能力：** Twitter 目录提供读帖、近期搜索、用户、发帖／回复、DM 等工具；2026 年 2 月起不再提供托管 Twitter OAuth，需自备 X app。工具存在不保证账号权限、政策资格或当前 API 全部可用。[官方 toolkit](https://docs.composio.dev/toolkits/twitter.md)
- **限额费用：** Platform 当前 Hobby $0、100,000 tool calls／月，Pro $29／月并有用量／附加项；公开 RPM 为 Hobby 2,000、Pro 10,000。它们是 Composio 平台限制，X 的收费和限额仍然另算，免费工具调用不等于免费推文。[Platform 价格](https://composio.dev/pricing/platform)
- **风险和接法：** 复用现有 provider；先检查 custom auth 能否由当前 `session.authorize` 选中、只读／写效果声明是否正确、账号选择与撤销。政策风险基本继承官方 API，另有厂商处理、停服与工具版本变化风险。**1–3 人日**做只读／普通发帖接入验证；若 custom auth 选择或 effect 映射需改动，额外 **2–4 人日**。DM 的权限、隐私和恢复另按需求估算。

### 4.2 TwitterAPI.io：便宜的公开数据与风险更高的写接口

- **认证与存储：** 公开数据接口使用 `X-API-Key`，不要求把真实 X 账号交给它。可放现有 API connector 的加密 credential，按固定 origin 注入命名 header。[文档](https://docs.twitterapi.io/introduction)
- **读写分界：** 搜索、帖子 ID、用户、时间线、回复等公开数据可读。它另有发帖／回复／发 DM v2，但需要登录 cookies；登录接口接受账号、邮箱、密码、TOTP secret 与代理信息。这扩大了凭据与账号风险，本轮没有登录。[登录契约](https://docs.twitterapi.io/api-reference/endpoint/user_login_v2)、[发帖](https://docs.twitterapi.io/api-reference/endpoint/create_tweet_v2)、[DM](https://docs.twitterapi.io/api-reference/endpoint/send_dm_v2)。不能据此声称有完整 DM 收件箱读取。
- **费用：** 推文 $0.15／千条，空结果请求也有 $0.00015 最低费；用户资料价格随批量而变（批量可从 $0.01／千用户起，普通 profile 文档标 $0.18／千用户），不能把最低批量价用于所有查询。10,000／100,000 条推文的基础估算约 **$1.50／$15**，未含轮询、空结果、资料或订阅。[价格页](https://twitterapi.io/pricing)
- **写费用：** 文档标登录 10,000 credits（约 $0.10）、发帖／回复与发 DM 各 60 credits（约 $0.0006／次），还可能有代理和账号维护成本。这是该厂商报价，不是 X 官方 API 优惠授权。[登录](https://docs.twitterapi.io/api-reference/endpoint/user_login_v2)、[发帖](https://docs.twitterapi.io/api-reference/endpoint/create_tweet_v2)、[DM](https://docs.twitterapi.io/api-reference/endpoint/send_dm_v2)
- **限流：** 专门 rate-limit 页：未充值账号每 5 秒 1 请求；充值后及 Starter／Builder／Pro 20 RPS；Scale 50、Business 500，上调需联系厂商。简介“默认 20”有省略，预算应采用细则。[限流](https://docs.twitterapi.io/rate-limits)
- **合规风险：** 本轮公开资料没有证明其具有覆盖本用途的 X 数据再许可，不能因为“公开数据”就视为可以任意抓取／存储／再分发；需确认来源、授权、删除同步、DPA 与 SLA。只读不交 X 账号可减少本方账号暴露，但仍有数据供应中断和合同风险。cookie 写入沿用非 API 自动化的高风险，应单独评估，不能靠换小号或代理绕开条款。[X 条款](https://x.com/en/tos)
- **接法与工作量：** 可走现有 InstalledConnectorProvider 的 REST operations／OpenAPI，或薄的可替换 adapter；不让 skill 把 key 拼进 shell。只读配置验证 **1–2 人日**，补分页、退避、归一化与离线验收共 **3–5 人日**。cookie 写路径至少 **再 3–5 人日**且有持续维护成本；工时不能消除授权与封号风险，不列为推荐落地路径。

### 4.3 开源 MCP：协议包装不是数据授权

| 候选 | 认证、能力和费用 | 如何接入／风险／估计 |
| --- | --- | --- |
| [官方 xdevplatform/xmcp](https://github.com/xdevplatform/xmcp) 自托管 | 基于 X OpenAPI 暴露工具；文档列读取、`createPosts`、DM 等，排除流／webhook。仍需 X 开发者 app、Bearer／OAuth credentials；费用和限额继承 API，再加托管 | 可部署为受认证的远程 MCP，经现有 HTTP 通道接入。其 README 有 debug／打印 token 选项，生产不得照抄，凭据仅由运行秘密管理注入；不能共享一个 OAuth 身份给所有成员。固定版本、安全审阅、工具裁剪、离线验收约 **2–4 人日**，完整多用户 token 生命周期另计 |
| [EnesCinr/twitter-mcp](https://github.com/EnesCinr/twitter-mcp) | README 提供 `post_tweet`（含回复）、`search_tweets`、`get_home_timeline`；OAuth1 API key／secret、用户 token／secret。没有据此确认 DM；API 收费／限额仍在 | 文档主要是本地 npm stdio。CogineBot 的 stdio 默认关闭；显式开启并白名单，或安全封装为远程服务。插件 importer 不会运行这个 npm command。凭据放加密 env material／server vault，不放受版本控制的配置。维护、依赖和旧 API 兼容风险；约 **2–4 人日**验证，不假定维护活跃度或上游政策兼容 |

上述项目没有在本轮安装、启动或授权；仓库公开并不代表可直接用于多租户产品。官方托管 MCP 与官方开源 server 是不同部署选择，不能互相借用工具清单作实测证据。

## 5. 登录态浏览器自动化

- **认证／凭据在哪：** 用户手动登录后 cookies 留在 bot computer 的 Chrome profile；保存网页登录可复用后端保护卡和 `fill_secret`，密码加密但会话 cookies 属于浏览器工作区，不等于 SecretStore 中的 API token。备份／迁移会携带 profile，需纳入访问与撤销边界。[bot-secrets.md](bot-secrets.md):70、[computer-runtime.md](computer-runtime.md):19、34、96
- **读写差别：** 技术上可操作登录用户能看到的帖子、搜索、时间线、发帖、回复和 DM；受页面、账号权限、挑战和风控影响。没有 X 专用自动化代码或真实验收；不能把登录网页描述成完整、稳定的 API。发送超时后盲目重试可能重复发帖或私信。
- **限流与费用：** 无稳定的公开“网页自动化调用额度”；UI 本身仍有账号限制、动态风控。虽无每次 API 费用，仍有模型 token、电脑运行、页面适配、人工处理 2FA／验证码和会话失效成本。不能用 API 的 RPM 表当作网页安全速率。
- **条款与封号：** X 自动化规则直接禁止非 API 的网页脚本自动化，可能永久封号；服务条款对未经书面许可抓取另有限制。用户拥有账号、能手动点击、操作频率很低或只读，都不自动形成平台许可。这里的风险来自明文规则，不只是“容易被检测”。[自动化规则](https://help.x.com/en/rules-and-policies/x-automation)、[服务条款](https://x.com/en/tos)
- **接入方式／工作量：** 当前已经是 browser builtin，而不是 X connector。若未来有足够授权，只需通过既有 browser tools 与受控流程工作；需要可重复的产品操作才考虑 adapter。单流程技术验证 **1–2 人日**，读写／异常恢复初步可靠化 **5–10 人日以上**，后续持续适配；不含授权和人工风控处理。**研究上不建议作为主路线，本轮不登录或演示。**

## 6. 只读抓取、RSS 与公开索引

| 做法 | 认证／凭据 | 能力、限额与费用 | 风险、接入和工作量 |
| --- | --- | --- | --- |
| 普通 HTML fetch／搜索引擎索引 | 通常无需 X 凭据；如用搜索商，key 走现有通用设置 | 已有 `web_search`／`web_fetch` 可查公开索引或片段；无 JS，无法保证 X 帖子全文、新鲜度、搜索全集或完整时间线；不能写或读私信。服务／IP 限流，无可承诺吞吐 | 偶尔辅助查线索，不算 X connector；遵守网站访问条款，不能绕登录墙／验证码。核对既有返回边界约 **0.5–1 人日**；无法通过增加工时保证完整性 |
| RSSHub 的 Twitter 路由 | 当前 [user.ts](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/user.ts) 声明 `TWITTER_AUTH_TOKEN`、consumer key／secret，以及可选第三方 API；实际取决于上游模式，不是无认证 RSS。凭据只应在独立 RSSHub secret store | 路由能生成公开账号 feed；只读，非 X 官方 feed。上游仍有配额、会话失效或第三方费用；自托管还需服务与缓存，不能保证免费公共实例 | Repo 路由存在不等于线上可用。本轮 docs 页面 403，未用账号实测。可用现有 HTTP/RSS 读取或未来薄 adapter，做增量 cursor／缓存去重；上游抓取风险仍存在。服务与只读验证 **2–4 人日**，后续运维另计 |
| Nitter 的 RSS | 读 feed 的客户端可无 X 登录；上游实例仍依赖非官方接口／session 资源，不能视为不需要认证基础设施。自托管 session 不进入产品 repo | 开源前端可读公开内容；RSS 依实例，README 说经常因滥用关闭；无写、无 DM，无稳定公开 SLA／统一限额。自托管有机器、缓存与维护成本 | [README](https://github.com/zedeus/nitter#readme) 披露 2026-08-24 收到 X 要求永久停运实例与仓库的信函，10-10 寻求法律协助。技术存在，连续性与法律风险高。仅技术部署评估 **2–4 人日**，不建议接成产品依赖 |

RSS 只是输出格式，不改变上游抓取的合法性、数据权利或账号风险。此次没有发现可据以承诺“免费、免账号、长期稳定读取任意 X 账号”的官方 RSS 路径。

## 7. 已确认的能力基座边界

2026-11-17 已确认：「其实我们只做能力基座就好了，用户自己想用就是自己填」。只交付连接能力，开发者应用、凭据、费用、账号与用量归使用者自行选择；不提供产品运营账号或预算，不做自动发帖策略、运营功能，也不代用户申请 API。

原来列给需求方的事项均不再是产品待定项：

| 已取消的产品决策前置项 | 现在的归属 |
| --- | --- |
| ~~开发者 app 由谁持有，操作哪个账号~~ | 使用者自备 app 和账号 |
| ~~是否付费、最多多少、是否自动充值~~ | 使用者承担费用并在上游自行管理额度；产品不设置 X 预算 |
| ~~是否需要写~~ | 使用者选择只读或所需读写工具；仍受上游 scopes、账号资格与平台政策限制 |
| ~~读取范围、读量、历史范围与频率~~ | 使用者按自己的用途和上游额度决定；不建立产品统一读量计划 |
| ~~数据与托管边界的运营方案~~ | 使用者选择连接目标与数据用途；产品继续执行既有凭据隔离、工具审批和安全网络边界 |

现有 MCP／API 基座已经具备自填凭据、安全保存、工具权限与失败反馈。本轮只补说明，不新增预置模板、专用 X connector、OAuth flow 或运营逻辑。Composio 和 installed API operations 也能承接用户自备应用／凭据；这不等于每个用户当前已授权或具备上游资格。

## 8. 用户怎么自己接 X

### 8.1 官方只读 MCP：具体填法

用户自行准备 X 开发者应用、其 **App-only Bearer token** 和可用 API 额度。API key、API key secret、OAuth client ID 不是 Bearer token，不能混填。产品不代办账号、不提供 token、不承担费用或设定预算。

Web／Electron 打开 **MCP servers** 的 **Add server** 表单（不是仅填写 URL 的简化连接入口），按下表填写；当前无需 X 专用模板：

| 表单项 | 填写内容 |
| --- | --- |
| Server name | `X read-only`（可自行命名） |
| Transport | `HTTP`，对应 `streamable_http`；不选 SSE／STDIO |
| Server URL | `https://api.x.com/mcp?read_only=true`；保留只读参数，URL 内不放凭据 |
| Advanced → Access token (optional) | 填自己的 App-only Bearer token；可只填 token，后端会加 `Bearer ` 前缀 |
| Advanced → Header name／Header value | 上面已填 Access token 时留空；另一种等价填法是 Access token 留空，Header name 为 `Authorization`、Header value 为 `Bearer <YOUR_APP_ONLY_BEARER_TOKEN>` |
| Share all tools with this space | 保持关闭；按下一节配置最小 allowlist |

两种凭据填法二选一。不要同时填两份 Authorization：后端的 Access token 会覆盖同名 header。占位符只用于说明，真实 token 仅填在受保护的表单内，不填聊天、文档、仓库文件、URL 或终端命令。保存通过现有 SecretStore 加密 credential material；“credential saved”只证明已保存，不保证 X 账号资格、额度或工具调用成功。

此只读路径不需要 **Connect OAuth**，也不用安装 xurl bridge。X 的普通数据 MCP 不提供标准 MCP OAuth discovery，点击通用 OAuth 按钮不能自动完成 X 用户授权；`https://docs.x.com/mcp` 则只查开发文档，不是读推文的服务。

代码依据：[McpServersOverlay.tsx](../apps/web/src/pages/McpServersOverlay.tsx):96、[MCP 配置契约](../packages/contracts/src/domain.ts):815、[mcp-material.ts](../apps/api/src/mcp-material.ts):64、[mcp-connector.ts](../packages/adapters/src/mcp-connector.ts):870。官方字段和只读模式说明于 2026-11-17 复核：[X MCP](https://docs.x.com/tools/mcp)。

### 8.2 建议的工具 allowlist

保存后打开该 server 的 **Tool access**，关闭 **Share all tools with this space**。在 **Tool names, one per line** 中填实际工具名，一行一个；保存后，再按现有连接／Bot 权限流程授权给需要使用它的 Bot。只保存 server 不会自动授权全部工具。

建议起步只允许以下三类中的必要项：

| 建议允许的能力 | 核对上游工具描述时的范围 |
| --- | --- |
| 按 ID 读公开帖子 | GET Post lookup，不允许创建、编辑或删除帖子 |
| 搜索公开帖子 | 官方 MCP 当前提供的只读 post search；先避免一次返回大量结果 |
| 按 handle／ID 查用户、读其公开帖子 | GET User lookup／user posts；不开放私信、书签、粉丝批量读取或其他无关能力 |

**allowlist 填工具名，不填上表的能力中文名或 API 路径。当前 Web UI 不展示上游发现的工具名清单**，工具权限编辑器只编辑已保存的名称。请从上游 server 的文档取得准确工具名后逐一填写；不要猜名字、使用 `*` 或直接允许所有工具。托管 MCP 与开源 xmcp 的名字可能不同，本轮没有调用真实服务的 `tools/list`，因此不提供冒充已验证的固定名称列表。若上游文档也未提供准确名称，保持 allowlist 为空（不授予 Bot 工具），不要通过开启全部工具来排障；空 allowlist 不会阻止后端发现工具或连接上游。

URL 的 `read_only=true` 是上游写工具过滤，本地 allowlist 是更小的权限范围，App-only token 则没有用户写身份，三者不能互相替代。只读仍可能按返回资源收费；额度、查询范围与用量由用户在 X 自行管理。

工具权限依据：[McpToolAccess.tsx](../apps/web/src/components/integrations/McpToolAccess.tsx):63、[mcp-connector.ts](../packages/adapters/src/mcp-connector.ts):386。mobile 的 **MCP servers** 可编辑现有连接的工具权限；创建 server／填写初始凭据在 Web 完成，通过 **Open web app** 返回同一部署配置，随后回 mobile 刷新。不要求 mobile 另外保存一份 token（[mobile/mcp.tsx](<../apps/mobile/app/(settings)/mcp.tsx>):113）。

### 8.3 配置后没有工具或报错时

| 现象 | 用户核对项 |
| --- | --- |
| 401／认证失败 | 是否误填 API key、Bearer 格式是否正确、token 是否已撤销；此界面不能编辑现有 server 的凭据，按下文步骤重建，勿把 token 附在报错截图或讨论里 |
| 403／权限不足 | app 是否具备目标 endpoint 资格、是否试图用 app-only token 做 user-context 操作；本地 allowlist 不能扩大 X 权限 |
| 429／额度相关错误 | 查看 X 控制台的限流／余额／资格；不要通过反复重试或换账号规避，也不要误认为“只读免费” |
| 保存成功但 Bot 无工具 | server 是否启用，allowlist 是否有准确名称、连接／Bot 是否已授权；空 allowlist 默认不给工具 |
| OAuth 没有打开登录或不支持 | 此处用静态 Bearer 认证；不要用 OAuth 按钮代替填写 Bearer token |
| 工具清单变了 | 重新核对上游的具体工具定义，再调整 allowlist；不要开启全部工具绕过权限复核 |

**更换 token 的现有 UI 路径：** MCP servers 的凭据表单只用于 **Add server**，不能修改已保存 server 的 token。先记录该连接的名称、URL、HTTP 类型和允许的工具名称（不抄录旧 token），再对旧连接选择 **Delete → Confirm delete**；按第 8.1 节用新 token 重新添加。新连接默认没有工具权限，须重新填写最小 allowlist，并在需要使用它的 Bot 上重新选择／授权新连接；新 server ID 不会自动继承旧连接绑定。不要把新 token 放入截图、日志或讨论。

这些是对现有通用配置和上游错误的说明，不新增 X 专用错误提示；也没有宣称真实服务验收已通过。本轮只校对文档字段、源码与官方公开说明，不向 X API 发请求。

### 8.4 写能力：以后有需求再做

- **X 用户 OAuth：** App-only Bearer 不能代用户发帖、回复或发 DM。已有通用 API operations 可使用用户提供的有效 token，但专门的 X OAuth app 配置、用户授权、refresh／撤销生命周期和各写工具的覆盖尚未验证／补齐。官方 xurl bridge 是另一部署方式，不能当作当前产品已提供的原生用户授权流程。**以后有需求再做。**
- **Composio custom auth 选择：** 现有平台设置和加密存储可接用户自己的 Composio 项目；Twitter 需自备 X OAuth app 并在 Composio 配 custom auth。当前 `session.authorize` 未显式传入 auth-config ID，能否正确选择该项目的 custom auth 仍需验证。**以后有需求再做。**
- **现有 installed API operations：** 适合用户自备的 Bearer／命名 header 请求；不因能保存 key 就自动实现 OAuth1 签名、多凭据或 OAuth2 refresh。这里不增加任何签名或刷新代码。

选择写工具仍需上游 scopes、账号资格和平台政策允许；取消只读参数不会赋予这些权限。本轮不接真实写工具、不做自动发帖策略、不补运营功能，也不为这些未来需求设产品账号或预算。

## 9. 资料核验说明

方案研究的外部链接于 2026-11-16 查询；第 8 节的官方 MCP 配置说明于 2026-11-17 复核。研究以运营方文档／定价与项目源码为主要证据。X 套餐页与历史公告不一致处采用当前价格页，并保留旧账户待核实；Composio 按 Platform 而非 For You 报价；TwitterAPI.io 限速按专门细则而非简介，写能力按对应 endpoint 说明；RSSHub 采用可读源码，不把访问失败当作服务已下线。

公开文档只能证明公开声明；账号实际可用性、控制台专属报价、商业授权范围、审批时长、第三方数据许可与 OAuth 兼容性仍未验证。交付保留这些空白，避免把调研建议当成上线结论。
