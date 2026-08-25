---
title: SSRF代码级修复方案
date: 2026/08/07
tags:
  - 修复方案
categories:
  - Web安全
---

## 修复SSRF需要考虑的问题

### IP 地址表示形式混淆

**原理：**这类 SSRF 绕过手法属于“格式混淆”类攻击，核心在于**利用 URL 和 IP 地址表示形式的多样性与宽松标准**。RFC 3986 等标准允许 IP  地址以多种合法形式呈现——十进制、八进制、十六进制、整数长整型、省略分段写法等，且各编程语言的标准库和操作系统 Socket  层对这些格式的支持程度和解析规则存在差异。

防护层往往只校验标准点分十进制的 IPv4 地址（如 `10.0.0.1`），而实际发起 TCP 连接的操作系统底层（`inet_aton`、`getaddrinfo` 等）却能正确解析这些“变形”格式，最终将请求发往防护层意图之外的内网地址。如果目标同时开放 IPv6 支持，攻击面会进一步扩大。

**具体方式：**

1. **八进制 IP 地址绕过**
   将内网 IP `10.0.0.1` 改写为带前导零的八进制格式，如 `012.0.0.1`。防护层的黑名单可能只包含 `10.0.0.1` 这种常规写法，而忽略了 `012` 在操作系统网络操作 C 库函数（如 `inet_pton`）中会被解释为八进制数（即十进制 `10`），最终仍解析为 `10.0.0.1`。
   
2. **十六进制 IP 地址绕过**
   同理，将 IP 的某一段或整体转为十六进制，如 `0x0A.0.0.1`（`0x0A` = 10）。防护层黑名单直接匹配会失败，从而放行；而操作系统能正确转换为目标内网 IP。
   
3. **长整型IP 地址绕过**
   将整个 IPv4 地址视为一个 32 位无符号整数，例如 `10.0.0.1` 对应的整数为 `167772161`（计算方式：10×256³ + 0×256² + 0×256 + 1）。防护层因格式不符合点分 IPv4操作系统库函数会自动将其转换为 `10.0.0.1` 并建立连接。此外，其八进制表示形式`01200000001`和十六进制表示形式`0xA000001`同样可以进行绕过
   
4. **IP 地址省略写法绕过**
   利用允许省略尾随零段的语法，如 `127.1` 解析为 `127.0.0.1`，`10.1` 解析为 `10.0.0.1`，`192.168.1` 解析为 `192.168.0.1`。提交 `http://127.1/` 可直接绕过对 `127.0.0.1` 或 `localhost` 的封禁，直达本机回环接口。
   
5. **IPv6 地址及混合格式绕过**
   
   直接提交 `http://[::1]/` 或 `http://[::ffff:127.0.0.1]/`（IPv4 映射的 IPv6 地址），若防护层仅校验 IPv4 内网段（如 RFC 1918 地址），则这些 IPv6 格式会被放过，最终请求到达本地 `127.0.0.1`。

**现代缓解方案：**

- **IP 强制规范化与标准化**：在 SSRF 防护逻辑中，无论用户以何种形式提交（点分十进制、八进制、十六进制、整数、省略格式、IPv6 等），都**必须**使用操作系统或语言内置的解析函数（如 Python 的`socket.inet_pton` ）将其统一转换为标准的点分十进制 IPv4 或规范化的 IPv6 字符串，并在这个规范化后的字符串上进行黑白名单匹配。不过，更常见的做法是使用更加顶层的IP解析函数做统一规范化，通常会摈弃畸形格式，只保留常用的格式和整数形式（如Python的`ipaddress.ip_address`）
- **拒绝畸形格式**：实施“默认拒绝”策略——如果 IP 地址不符合标准的点分四段式 IPv4 格式（每段为 0-255 的十进制无前导零数字），且不是标准的 IPv6 格式（无压缩混淆），则直接拒绝请求，而非尝试解析。
- **网络层出站封堵（纵深防御）**：不依赖应用层字符串校验作为唯一防线，直接在主机层面通过 iptables/nftables 或云服务商的安全组策略，阻断所有出站方向发往 RFC 1918（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、`127.0.0.0/8`、`::1/128` 及 `::ffff:0:0/96` 等内网地址的 TCP/UDP 数据包。无论应用层格式如何混淆，最终 Socket 连接在底层都会被防火墙直接丢弃。
- **禁用 IPv6 或严格限制**：如果业务不需要 IPv6 对外访问，可在系统内核或应用容器中禁用 IPv6 支持，或在 DNS/网络库层面强制仅使用 IPv4，从根本上斩断 IPv6 混淆路径。

### 云元数据服务地址（Metadata Service）

**原理：**云厂商的元数据服务（Metadata Service）为实例提供临时凭证、用户数据等敏感信息，是 **SSRF 攻击的"高价值目标"**。其地址大多落在保留/内网地址段内，但如果防护层只覆盖了经典的 RFC 1918 网段，就可能漏掉部分厂商的特殊地址。

**具体地址（常见）：**

- AWS / GCP / Azure / 华为云：`169.254.169.254`（在 `169.254.0.0/16` 内，通常已被覆盖）
- AWS ECS 任务凭证：`169.254.170.2`
- AWS IPv6 元数据：`fd00:ec2::254`
- 阿里云：`100.100.100.200`，该地址落在 `100.64.0.0/10`（RFC 6598 共享地址段）内，**不在** RFC 1918 黑名单中，是最容易遗漏的地址

**现代缓解方案：**

- **IP地址黑名单**：在 IP 黑名单中显式补充上述网段与地址，同时要注意避免被绕过（见"正确的修复方案"第 3 步）
- **禁用/收敛元数据服务**：更彻底的方案是在实例侧直接禁用/收敛元数据服务：多数云厂商支持关闭元数据服务或要求请求必须携带 token（如 AWS IMDSv2），从源头阻断这类攻击目标

### 伪协议

**原理：**SSRF 漏洞不仅限于 HTTP/HTTPS 协议。许多服务端 HTTP 请求库或 URL 处理函数支持多种 URL 协议，攻击者可以利用这些非 HTTP 协议访问本地文件系统、内网服务或执行任意 TCP 数据发送。常见的危险伪协议包括：`file://`（读取本地文件）、`dict://`（探测内网服务）、`gopher://`（发送任意 TCP 负载，可攻击 Redis、MySQL、SMTP 等内网服务）。

**具体方式：**

- **file:// 协议**：提交 `file:///etc/passwd` 或 `file:///C:/Windows/win.ini`，服务端读取并返回本地敏感文件内容
- **dict:// 协议**：提交 `dict://127.0.0.1:6379/info`，探测内网 Redis 服务的版本信息
- **gopher:// 协议**：提交构造好的 Gopher URL（如 `gopher://127.0.0.1:80/_GET / HTTP/1.1...`），向目标内网服务发送任意 TCP 数据包，攻击Redis、MySQL、SMTP等内网服务

**现代缓解方案：**

- **协议白名单**：严格限制仅允许 `http://` 和 `https://` 协议，拒绝所有其他协议

### @注入

**原理：**根据 RFC 3986，URL 的 `authority` 部分允许包含用户认证信息，标准格式为 `scheme://[user:password@]host:port`。许多编程语言的网络库（如 Python `requests`、Java `HttpURLConnection`）都完整支持这一标准，会正确**解析出 `@` 符号之后的部分作为实际目标主机**。然而，大量存在 SSRF 漏洞的应用代码在**自行实现主机名提取**时，往往使用脆弱的正则表达式或简单的字符串截取逻辑（如匹配 `//` 与第一个 `/` 之间的内容、或匹配 `http://` 之后的第一个域名/IP格式），而**没有正确处理 `@` 符号**。防护层可能**在 `@` 前提取出一个“看起来安全”的域名**，从而放行；但实际 HTTP 库却将请求发往 `@` 后的内网 IP 或域名。此外，攻击者还可利用 `#`（片段标识符）和 `?`（查询参数）进一步干扰简单正则的匹配结果，达到类似的效果。

**具体方式：**

- **基础 `@` 绕过**：构造 URL `http://expected-safe-domain.com@192.168.0.1/admin`

  - 脆弱的防护代码（如用正则 `http://([^/]+)` 提取主机名）会提取出 `expected-safe-domain.com@192.168.0.1`，如果只做域名白名单检查（如检查是否包含 `safe-domain.com`），则可能错误地判定为合法

  - 而一般的HTTP请求库（如Python `requests.get(url)` ）会正确解析 `hostname` 为 `192.168.0.1`，实际请求发往内网

- **嵌套 `@` 绕过**：构造 `http://safe.com@evil.com@192.168.0.1/path`

  - 标准解析器取**最后一个** `@` 之后的内容作为主机，即 `192.168.0.1`；但简陋的正则可能取第一个 `@` 之后的部分，即 `evil.com@192.168.0.1`这个整体，从而通过校验

- **结合 `#` 和 `?` 混淆**：构造 `http://192.168.0.1#@expected-safe-domain.com/path` 或 `http://192.168.0.1?@expected-safe-domain.com/`
  - 某些仅用正则匹配 `://` 和 `/` 之间内容的逻辑，会被 `#` 或 `?` 干扰，提取出错误的“安全”主机名（例如，提取@符号后的`expected-safe-domain.com`作为主机名），而标准解析器仍能正确识别真实目标

**现代缓解方案：**

- **使用权威解析器的 `hostname` 属性**：**永远不要**用自建的正则或字符串截取来提取主机名。必须使用语言的官方 URL 解析库，并调用专门获取主机名的方法（如 Python `urllib.parse.urlparse(url).hostname`、Go `url.Parse(u).Hostname()`、Java `java.net.URI(url).getHost()`），这些方法会自动剥离 `userinfo` 部分，只返回纯净的主机名
- **拒绝包含 `@` 的 URL**：如果业务场景确实**不需要**在 URL 中传递用户认证信息，可直接在 SSRF 防护层设置黑名单——检测到 `@` 符号即报错拒绝（注意检测时应先进行彻底的 URL 解码，防止二次编码绕过）

### URL解析器差异

**原理：**SSRF 防护代码和实际发起 HTTP 请求的代码往往使用不同的 URL 解析器。防护层可能使用一个解析器验证 URL 是否安全，而 HTTP 客户端使用另一个解析器来实际解析并发出请求。当**两个解析器对同一个“畸形”URL 的理解不一致**时，攻击者就可以构造一个在防护层被判定为安全但在实际请求层被解析为内网目标的 URL。这种“验证时无效、请求时有效”的差异是此类绕过的核心。

**具体方式：**

- **Angular 双端口案例（CVE-2026-50168）** ：提交 `http://evil.com:80:80/path`

  - 防护层使用严格的 WHATWG URL 解析器：`URL.canParse()` 返回 `false`，跳过主机检查

  - 实际请求层使用宽松的 Domino 解析器：接受该 URL，解析出 `http://evil.com:80`

  - 服务端将后续所有相对路径 API 请求转发到攻击者控制的服务器

- **反斜杠 `\` 与 `@` 的组合边界判定分歧**（CVE-2026-2020 / GHSA-8w7q-q5jp-jvgx）

  - **攻击 URL**：`http://127.0.0.1:6666\@1.1.1.1/`

  - **防御层解析（Python `urllib.parse.urlparse`）** ：将 `\` 视为普通字符，`@` 作为 userinfo 分隔符，提取 `hostname` 为 `1.1.1.1`（公网 IP，通过校验）

    ![image-20260816150803920](SSRF代码级修复方案.assets/image-20260816150803920.png)

  - **请求层解析（Python `requests` 库）** ：将 `\` 视为路径字符，不认为 `@` 是 userinfo 分隔符，实际连接到 `127.0.0.1:6666`（内网)

    ![image-20260816150851182](SSRF代码级修复方案.assets/image-20260816150851182.png)

  - **攻击结果**：请求被发往内网 `127.0.0.1:6666`，防御层校验完全失效

- **URL编码解析差异**：防御层和请求层对于URL编码的解析程度不同，导致实际解析到的域名不同

  - **攻击 URL**：`https://evil.com%2523@normal.com/`

  - **防御层解析**：仅做一次 URL 解码，将 `%2523` 解码为 `%23`（即 `#` 的编码形式），未将其还原为 `#`。解析器认为 hostname 是 `normal.com`（`@` 之后的部分），通过白名单校验

  - **请求层解析**：进行彻底解码（二次解码），将 `%2523` → `%23` → `#`。由于 `#` 是片段标识符（Fragment），`@` 之后的 `normal.com` 被视为片段的一部分，实际 hostname 被解析为 `evil.com`

  - **攻击结果**：请求被发往攻击者控制的 `evil.com`，绕过防御

**现代缓解方案：**

- **统一解析器**：防护层与实际请求层使用完全相同的 URL 解析器和标准化逻辑
- **域名统一标准化**：当防御层统一标准化解析得到协议、域名、路径、参数等信息并校验无风险后，可以进行标准化拼接并用于后续请求，从而避免前后解析不一致的风险

### HTTP重定向

**原理：**许多 HTTP 客户端（如 Go 的 `http.Get`、Python 的 `requests`、`aiohttp`等）**默认会自动跟随 HTTP 重定向**（301/302/307 等），而 SSRF 防护逻辑通常只验证用户最初提交的 URL，不会对重定向链中的每一个中间跳转目标进行重新验证。攻击者可以利用这个缺口，提交一个通过验证的公网 URL，该 URL 返回一个 302 重定向指向内网敏感服务，服务端自动跟随后便访问了内网资源。

**具体步骤：**

1. 攻击者在可控服务器上部署一个返回 302 重定向的端点，`Location` 头指向内网目标（如 `http://169.254.169.254/latest/meta-data/`）
2. 攻击者将公网重定向 URL 提交给被攻击的服务端
3. 服务端的 SSRF 防护**仅验证初始 URL**——域名是公网 IP，协议是 HTTPS/HTTP，全部通过
4. 服务端 HTTP 客户端**自动跟随 302 重定向**，直接请求内网目标
5. 内网服务的响应被返回给攻击者

**现代缓解方案：**

- **禁用自动重定向，针对URL逐个校验**

  1. 禁用自动重定向：设置禁用自动重定向，针对每一个重定向响应进行处理

  2. 每跳重新验证：在手动跟随重定向时，对每个 `Location` 头中的目标 URL 重新执行完整的 SSRF 安全检查

  3. 限制重定向链深度：设置最大重定向次数（如 3-5 次），防止深度链式攻击

### 特殊域名解析到内网（魔法域名）

**原理：**某些"魔法域名"的解析结果固定指向回环地址或任意指定 IP，可用于绕过"只校验域名、不校验解析结果"的防护，或作为携带目标 IP 的载体。

**常见魔法域名：**

- `localhost`、`*.localhost`（如 `foo.localhost`）→ 解析到 `127.0.0.1` / `::1`
- `localtest.me` → 解析到 `127.0.0.1`
- `nip.io`、`sslip.io`、`xip.io`（如 `10.0.0.1.nip.io`）→ 解析到前缀中嵌入的任意 IP（含内网 IP）
- 攻击者也可在自控域名中直接配置一条 A 记录指向内网 IP（TTL 可设得很短）

**现代缓解方案：**

- **IP黑名单校验**：校验不能止步于"域名是否在白名单"，**必须**把域名解析出的**所有** A/AAAA 记录逐一进行 IP 黑名单校验（见"正确的修复方案"第 3、4 步）
- **更严格的域名白名单**：域名白名单应使用精确匹配（而非后缀包含匹配），避免绕过

### DNS投毒

**原理：**DNS递归器的缓存是"被动学习"的，它信任收到的任何响应。如果攻击者能抢先在合法响应到达之前注入伪造响应，递归器就会缓存假记录，后续所有用户都会收到错误结果。

**具体步骤：**

1. 攻击者向递归器大量查询随机子域名(如 `rand1234.abc.xyz`)
2. 递归器被迫向权威 NS 发出查询
3. 攻击者在响应窗口内（几百毫秒）疯狂发送伪造响应包伪造的响应包含：
   - Transaction ID 猜测（16bit = 65536种可能）
   - 源端口猜测（如果未做端口随机化，容易受到攻击）
   - 额外附加记录：把 NS 记录也篡改为攻击者控制的 `ns.attacker.com`服务器的IP
4. 命中后，缓存被污染，有效期 = TTL

**现代缓解方案：**

- 源端口随机化（增加猜测难度 16bit×16bit=32bit，理论可能从65536变成4294967296，难度直线飙升）
- 0x20 编码（利用域名大小写变化携带额外熵）
- DNSSEC（密码学签名，伪造响应无法通过签名验证）
- 缩短缓存时间（减小影响窗口）

### DNS Rebinding

**原理：**DNS Rebinding 利用的是 SSRF 防护中“检查时间”与“使用时间”之间的竞态条件（TOCTOU）。攻击者通过控制一个自定义 DNS 服务器，**将某个域名的 TTL 设为 0，让服务端无法缓存解析结果，在两次解析之间返回不同的 IP 地址**。进而，实现第一次解析域名进行IP检查时使用合法的公网IP，第二次解析时（也就是真正发起请求）使用的却是内网IP，以此达到绕过普通IP检查的目的。

**具体步骤：**

1. 攻击者注册一个可控域名（如 `attacker.evil`），并配置自建 DNS 服务器（TTL配置为0）
2. 攻击者将 DNS 服务器设置为：第一次解析返回公网 IP（如 `8.8.8.8`），后续解析返回内网目标 IP（如 `169.254.169.254` 或 `127.0.0.1`）
3. 攻击者将恶意 URL（`http://attacker.evil`）提交给存在 SSRF 漏洞的服务端
4. 服务端的安全检查函数解析域名，得到公网 IP，通过验证
5. 服务端的 HTTP 客户端实际发起请求时，再次解析同一域名，得到内网 IP
6. 请求被发往内网目标，攻击者成功绕过 SSRF 防护

**现代缓解方案：**

- **DNS Pinning（连接固化）** ：自行解析域名后，将解析得到的 IP 地址固化，后续所有请求直接使用该 IP 而非重新解析域名
- **在 Dial 层拦截**：在 TCP 连接建立时验证目标 IP，而非仅在 URL 解析阶段验证
- **白名单机制**：仅允许访问预先批准的公网域名/IP 范围，从根本上限制可达目标

### 提示词注入（Prompt Injection）

**原理：**传统的 SSRF 防护假设恶意请求来源于开发者可控的应用逻辑参数——一个可以验证的输入、一个可以阻断的重定向。但在 AI Agent 系统中，LLM（大语言模型）会主动检索外部内容（网页、PDF、RSS 源等）并按其指令执行操作。攻击者可以在这些外部内容中嵌入恶意指令，诱导 LLM 向内网发起 HTTP 请求。由于请求来自合法、已认证的 AI 进程，传统安全工具难以区分正常 AI 活动与恶意 SSRF。

**具体步骤：**

1. 攻击者在 LLM 将会检索的内容中植入恶意指令（如一个被污染的文档页面、一个被入侵的威胁情报源、或一个攻击者控制的网站）
2. LLM 在正常工作中获取并解析该内容，将嵌入的指令解释为合法的任务指令
3. LLM 的 HTTP 客户端按指令向内网目标发起请求（如 AWS 元数据服务 `169.254.169.254`、内网 Kubernetes API、相邻微服务等）
4. 内网服务的响应被返回给 LLM，进而可能通过模型输出、Webhook 或后续指令被攻击者获取

**现代缓解方案：**

- **网络出口管控**：在 AI Agent 运行环境配置严格的网络 egress 策略，从网络层阻断对内网IP和私有地址的访问
- **内容安全过滤**：在将外部内容输入 LLM 前，进行提示词注入检测和清洗
- **工具调用权限最小化**：为 AI 工具的 URL 获取功能配置白名单域名，禁止访问未授权的外部资源
- **凭证最小化**：运行 AI Agent 的服务使用最低权限的 IAM 角色，即使 SSRF 成功访问元数据服务，获取的凭证也无高危权限

## 通过Burpsuite官方靶场更直观了解SSRF

先了解怎么攻击，才能更清楚如何防御，在看这篇文章的你不妨也试试。

- [Lab: Basic SSRF against the local server](https://portswigger.net/web-security/ssrf/lab-basic-ssrf-against-localhost )：最基础的SSRF，通过修改Body参数指向特定链接，让服务端访问链接进行特定操作
- [Lab: Basic SSRF against another back-end system](https://portswigger.net/web-security/ssrf/lab-basic-ssrf-against-backend-system )：内网SSRF，使用Intruder模块探测得到真实内网IP即可，得到IP后，剩下的操作与上一个实验没有区别

![image-20260813083733944](SSRF代码级修复方案.assets/image-20260813083733944.png)

- [Lab: Blind SSRF with out-of-band detection](https://portswigger.net/web-security/ssrf/blind/lab-out-of-band-detection )：带外盲注。这个实验的主要目的是让我们了解到何为带外盲注，此处使用了Burpsuite的Collaborator作验证

![image-20260814082212174](SSRF代码级修复方案.assets/image-20260814082212174.png)

- [Lab: SSRF with blacklist-based input filter](https://portswigger.net/web-security/ssrf/lab-ssrf-with-blacklist-filter )：基于黑名单，使用IP地址转整数地址+URL二次编码绕过

简单的IP绕过，但是有个坑，就是除了IP绕过外，`/admin`接口也需要绕过，可以用URL二次编码，也可以直接大小写绕过即可

![image-20260814084346013](SSRF代码级修复方案.assets/image-20260814084346013.png)

- [Lab: SSRF with filter bypass via open redirection vulnerability](https://portswigger.net/web-security/ssrf/lab-ssrf-filter-bypass-via-open-redirection)：理论上限制了本地访问，使用本地重定向漏洞注入。这个实验的stock接口会把用户输入拼接域名地址，类似`String url = "https://abc.web-security-academy.net" + userInput`（然而实际上使用`@`注入绕过也没问题）。实验给了另外一个nextProduct接口用于重定向，可以实现stock接口的参数填写nextProduct接口，stock接口拼接后调用的实际上是nexProduct接口，而nextProduct接口指向的目的地址是由我们控制的，就可以让其指向管理地址`http://192.168.0.12:8080/admin`，从而实现SSRF

![image-20260814224943786](SSRF代码级修复方案.assets/image-20260814224943786.png)

- [Lab: Blind SSRF with Shellshock exploitation](https://portswigger.net/web-security/ssrf/blind/lab-shellshock-exploitation)：利用Referer和User-Agent进行shellshock注入。shellshock是一个CVE漏洞，并非通用的SSRF面临的问题，这里不做展开
- [Lab: SSRF with whitelist-based input filter](https://portswigger.net/web-security/ssrf/lab-ssrf-with-whitelist-filter )：URL解析差异绕过

正常的情况下，`@`后面的域名才是真正访问的域名，`@`之前的会被当做`username:password`来对待，这是URL的标准格式使然。因此，很多组件现在都会解析`@`后面的部分作为域名。因此，当我们用`http://stock.weliketoshop.net:8080@localhost`的时候发现行不通。那么，可以考虑利用`#`、`?`二次编码绕过，将`#`编码为`%23`，组成的URL为`http://localhost%23@stock.weliketoshop.net:8080`，在此基础上再进行一次URL编码，最终为`http%3a%2f%2flocalhost%2523%40stock.weliketoshop.net%3a8080`，访问成功。这次攻击能正常，主要原因是检查域名与实际访问时的URL解析不同。检查域名时没有进行彻底的URL解码，导致解析到的URL结果中，把`localhost%23`作为username，而真正的host解析为`stock.weliketoshop.net`。与此不同的是，真正进行请求时进行了彻底的URL解码，最终得到的URL是`http://localhost#@stock.weliketoshop.net:8080`，因此将`#`后面部分与第一个`/`之间的部分舍弃，最终通过URL在域名校验和请求的解析差异，成功完成本次攻击

![image-20260814232412864](SSRF代码级修复方案.assets/image-20260814232412864.png)

## 正确的修复方案

我们一步步走，从入口开始向内，看看都需要做什么来防护。整个SSRF的防护流程可以概括如下：

接口输入 -> 统一解析URL -> 校验协议、域名 -> 校验IP -> DNS Pinning -> 提取标准化URL -> 发起请求（出现重定向时，对每一个重定向的URL再完成使用前面步骤检查一遍）

> 对于提示词注入导致的SSRF，除了大模型的Tool的入参URL需要按照以上方式检查之外，需要按照"提示词注入"一节中介绍的缓解方案进一步针对性防御

### 1. 统一解析URL

最稳妥的方式是校验和请求时使用相同的解析库。如果使用难以保障校验和请求时使用相同的解析库或者存在使用多个请求库的情况，也可以**统一规范化解析和提取URL，再进行校验和请求**。

### 2. 校验协议、域名

- 校验**协议白名单**基本上是必选的，且一般是设置为只允许HTTP/HTTPS协议
- 校验**域名白名单**是可选的，需要根据实际业务场景决定。通常来说，使用域名白名单已经可以挡住绝大部分的攻击了。除非攻击者通过DNS投毒或其他手段控制了域名/DNS结果，或者能篡改白名单配置
  - 对于**无法使用域名/IP白名单**的情况，应根据实际业务情况采取更多的消减措施达成纵深防御。例如，某工单系统存在配置回调地址的功能，当工单审批通过后，自动回调该工单对应配置的回调地址（例如审批权限申请的工单回调权限中心的接口），请求时会带上机机账号的API Key/Token等信息，往往拥有目标业务系统的高权限。如果回调地址的域名动态性特别强，无法通过白名单进行限制，那么就可以考虑通过以下手段进行纵深防御
    - **提升回调地址配置权限**：提高配置回调地址所需权限，最好只有系统管理员级别才能操作
    - **最小化业务权限**：机机账号的权限要约束在其回调能力范围之内，否则就可能导致通过一个API Key/Token控制整个业务系统的严重后果
    - **引入“HMAC 签名校验”**：发送的API Key/Token，改为ticket_id/data + HMAC签名值，这种情况下，即使HMAC被窃取了也只对于这个工单有效，危害完全在可控范围内
    - **mTLS认证**：引入mTLS认证，除了客户端（工单系统）检查服务端（业务系统）的证书外，服务端（业务系统）也检查客户端（工单系统）的证书，确保外部攻击者无法访问到系统。这种mTLS认证通常是在企业内部业务系统群中使用
  - 若使用域名白名单，需意识到 **DNS 投毒** 的风险：白名单域名本身的解析结果可能被污染。DNS 投毒的根治在基础设施层（DNSSEC、源端口随机化、0x20 编码等，见"DNS投毒"一节），应用层无法单独根治，只能通过"白名单域名 + 解析结果再次做 IP 校验 + DNS Pinning"来减小影响

### 3. 校验IP

通常来说我们没办法做IP白名单校验，只能是黑名单校验，这也是最开始的SSRF的标准防护措施。后来随着云基础设施的发展，`169.254.0.0/16`和`100.64.0.0/10`这两个网段重要性凸显。以下是需要作为黑名单的相关IP网段。

```
192.168.0.0/16 => 192.168.0.0 ~ 192.168.255.255
10.0.0.0/8 => 10.0.0.0 ~ 10.255.255.255
172.16.0.0/12 => 172.16.0.0 ~ 172.31.255.255
127.0.0.1/8 => 127.0.0.0 ~ 127.255.255.255
0.0.0.0/8 => 0.0.0.0 ~ 0.255.255.255
169.254.0.0/16 => 169.254.0.0 ~ 169.254.255.255
100.64.0.0/10 => 100.64.0.0 ~ 100.127.255.255
```

若目标系统支持 IPv6，还需补充以下网段：

```
::1/128 => 本机回环
::/128 => 未指定地址
::ffff:0:0/96 => IPv4 映射地址（应先归一化为 IPv4 再用上面的 IPv4 黑名单校验）
fc00::/7 => IPv6 私有地址（ULA）
fe80::/10 => 链路本地地址
fd00:ec2::254 => AWS IPv6 元数据（已包含在fc00::/7网段覆盖范围之中）
```

> 注意：
>
> - 此处不特殊考虑x.x.x.0和x.x.x.255这种特殊IP，统一做防护即可
> - 局域网IP网段只是标准定义，实际上也可能存在乱配其他网段作为局域网IP的情况，只是几乎没有这种情况

需要注意存在多个绕过方法：

- 利用八进制IP地址绕过
- 利用十六进制IP地址绕过
- 利用IP地址数字形式绕过（八进制、十进制、十六进制数字皆可行）
- 利用IP地址的省略写法绕过
- 如果目标系统支持IPv6地址，还涉及利用IPv6地址绕过。特别地，还能通过`[::ffff:127.0.0.1]`将IPv6映射到IPv4的`127.0.0.1`

校验时有几个要点：

- **解析所有记录**：域名可能同时解析出公网与内网多个 A/AAAA 记录，必须把**全部记录逐一校验**，只要有一条命中黑名单就拒绝，不能只校验第一条
- **IP 字面量规范化**：直接以 IP 形式提交的主机（如 `127.1`、`0xA000001`、`012.0.0.1`），必须要求是规范的点分十进制 IPv4 / 标准 IPv6 形式，**非规范形式默认拒绝**（拒绝畸形格式），尽量不要尝试交给底层 Socket 去解析。或者，使用标准的IP解析库解析，并在后续的校验和请求中使用解析后的结果而非原始输入
- **错误信息脱敏**：校验失败或连接失败时，对用户返回统一的脱敏错误，不暴露"目标是否可达 / 内网 IP / 端口状态"等信息（防盲 SSRF 探测）

### 4. DNS Pinning

这一步的目的是解决DNS Rebinding，其原理是：

1. **主动解析 (Resolve)**：代码主动进行一次 DNS 解析。

2. **安全验证 (Validate)**：验证解析出的 IP 是否合法（非内网、非保留地址等）。

3. **钉住IP (Pin)**：验证通过后，**直接使用该 IP 地址建立连接**，而非再次使用域名。这从根本上杜绝了第二次恶意 DNS 解析的发生，可以解决DNS Rebinding、国际化域名等情况的绕过

> 补充：
>
> - 为什么不直接拼接IP进行请求访问呢？原因是现代网络架构中，域名解析到的IP通常是WAF、负载均衡等安全或流量设备的IP，并非服务真实IP，因此直接访问是会失败的
>
> - 解析时应取回**全部记录**（如 Java `InetAddress.getAllByName`、Python `socket.getaddrinfo`），逐一校验通过后，Pinning 使用通过校验的 IP 建立连接
> - 为降低DNS投毒对白名单域名解析结果的影响，应优先选用支持并默认开启DNSSEC验证的递归解析器（如Cloudflare、Quad9），同时建议配置DoH/DoT加密传输通道，以防止链路篡改

### 5. 提取标准化URL

这一步的目的是解决URL解析器差异的问题。该问题的产生根因是防护层和实际请求时使用的解析器有差异，而如果我们统一解析并提取标准化URL的话，就能屏蔽这种差异。

### 6. 发起请求

正式发起请求。发起请求时，注意要禁用HTTP自动重定向，要么手动实现一个重定向能力，要么或者是根据具体请求库提供的一些Hook方法实现。具体要求是：

- 检查重定向的域名/IP是否符合要求，也就是针对重定向的每一个域名/IP，重新走第1-6步
- 重定向的 `Location` 如果是相对路径，需要基于原 URL 拼接后再解析；每个跳转都要重新校验协议、域名、IP
- 进行重定向次数计数，达到上限则拒绝访问
- 设置请求超时（连接 + 读取）与 URL 长度限制，防止被用作内网端口扫描器造成资源消耗

## 代码级修复方案

### Java

**方案说明：**使用 JDK 11+ 自带的 `java.net.http.HttpClient`，无第三方依赖。DNS Pinning 通过 JDK 18+ 新增的 `InetAddressResolverProvider` SPI 实现：发出请求前把"域名 → 已校验通过的固定 IP"写入解析器，HttpClient 解析域名时直接得到该固定 IP，而 Host 头、SNI、TLS 证书校验仍按 URL 中的域名进行，因此 HTTP 与 HTTPS 都能正确处理。

实现分 3 个部分：

1. `SsrfSafeClient.java` —— 完整六步校验流程 + 手动重定向
2. `PinningResolverProvider.java` —— DNS Pinning 的解析器 SPI 实现
3. `META-INF/services/java.net.spi.InetAddressResolverProvider` —— SPI 注册文件（内容只有一行：`PinningResolverProvider`）

**几个实现要点：**

- `new URI(url)` 解析即"默认拒绝"：反斜杠 `\`、非法字符直接抛 `URISyntaxException` 被拒绝（天然封死 CVE-2026-2020 那类 `\` + `@` 的解析器分歧）；`@` 之前的部分自动剥离为 userinfo，嵌套 `@` 时 `getHost()` 返回 `null` 直接拒绝
- `ALLOWED_DOMAINS`（域名白名单）与 `BLOCKLIST`（IP 黑名单）是配置点：白名单为空时退化为纯黑名单模式；白名单非空时 IP 字面量直连一律拒绝
- IP 字面量强制规范形式：八进制、十六进制、整数、省略写法等一律拒绝（拒绝畸形格式）
- `InetAddress.getAllByName` 取回**全部** A/AAAA 记录逐一校验
- 所有校验/连接失败均返回脱敏后的统一错误信息，不暴露内网可达性

`SsrfSafeClient.java`：

```java
import java.io.IOException;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

public class SsrfSafeClient {

    private static final Set<String> ALLOWED_SCHEMES = Set.of("http", "https");
    static Set<String> ALLOWED_DOMAINS = Set.of("api.example.com");
    static List<Cidr> BLOCKLIST = List.of(
            Cidr.of("0.0.0.0/8"), Cidr.of("10.0.0.0/8"), Cidr.of("127.0.0.0/8"),
            Cidr.of("169.254.0.0/16"), Cidr.of("172.16.0.0/12"), Cidr.of("192.168.0.0/16"),
            Cidr.of("100.64.0.0/10"),
            Cidr.of("::/128"), Cidr.of("::1/128"), Cidr.of("::ffff:0:0/96"),
            Cidr.of("fc00::/7"), Cidr.of("fe80::/10"));
    private static final int MAX_REDIRECTS = 3;
    private static final Duration TIMEOUT = Duration.ofSeconds(5);
    private static final Pattern IPV4_CANONICAL = Pattern.compile(
            "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}");

    private final HttpClient client;

    public SsrfSafeClient() {
        this.client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(TIMEOUT)
                .build();
    }

    public String fetch(String url) throws IOException, InterruptedException {
        return fetch(url, 0);
    }

    private String fetch(String url, int hop) throws IOException, InterruptedException {
        if (hop > MAX_REDIRECTS) {
            throw new SecurityException("too many redirects");
        }

        URI uri = parse(url);

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!ALLOWED_SCHEMES.contains(scheme)) {
            throw new SecurityException("scheme not allowed");
        }

        String host = uri.getHost();
        if (host == null) {
            throw new SecurityException("invalid host");
        }
        host = host.toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) {
            host = host.substring(1, host.length() - 1);
        }

        InetAddress pinned = resolveTarget(host);

        PinningResolverProvider.pin(host, pinned.getAddress());
        try {
            HttpRequest request = HttpRequest.newBuilder(uri)
                    .timeout(TIMEOUT)
                    .GET()
                    .build();
            HttpResponse<String> response;
            try {
                response = client.send(request, HttpResponse.BodyHandlers.ofString());
            } catch (IOException e) {
                throw new SecurityException("connection failed");
            }
            if (isRedirect(response.statusCode())) {
                String location = response.headers().firstValue("Location")
                        .orElseThrow(() -> new SecurityException("redirect without Location"));
                URI next;
                try {
                    next = uri.resolve(location);
                } catch (IllegalArgumentException e) {
                    throw new SecurityException("invalid redirect target");
                }
                return fetch(next.toString(), hop + 1);
            }
            return response.body();
        } finally {
            PinningResolverProvider.unpin(host);
        }
    }

    private InetAddress resolveTarget(String host) throws SecurityException {
        InetAddress literal = parseLiteral(host);
        if (literal != null) {
            if (!ALLOWED_DOMAINS.isEmpty()) {
                throw new SecurityException("IP literal not allowed with domain whitelist");
            }
            checkIp(literal);
            return literal;
        }
        if (!ALLOWED_DOMAINS.isEmpty() && !ALLOWED_DOMAINS.contains(host)) {
            throw new SecurityException("domain not allowed");
        }
        try {
            InetAddress[] addrs = InetAddress.getAllByName(host);
            InetAddress first = null;
            for (InetAddress addr : addrs) {
                checkIp(addr);
                if (first == null) {
                    first = addr;
                }
            }
            if (first == null) {
                throw new SecurityException("no address resolved");
            }
            return first;
        } catch (UnknownHostException e) {
            throw new SecurityException("DNS resolution failed");
        }
    }

    private static InetAddress parseLiteral(String host) throws SecurityException {
        String h = host;
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1);
        }
        if (h.indexOf(':') >= 0) {
            try {
                return InetAddress.getByName(h);
            } catch (UnknownHostException e) {
                throw new SecurityException("invalid IPv6 literal");
            }
        }
        if (h.toLowerCase(Locale.ROOT).startsWith("0x")) {
            throw new SecurityException("non-canonical IP format");
        }
        if (h.matches("[0-9.]+")) {
            if (!IPV4_CANONICAL.matcher(h).matches()) {
                throw new SecurityException("non-canonical IPv4 format");
            }
            String[] parts = h.split("\\.");
            byte[] bytes = new byte[4];
            for (int i = 0; i < 4; i++) {
                bytes[i] = (byte) Integer.parseInt(parts[i]);
            }
            try {
                return InetAddress.getByAddress(bytes);
            } catch (UnknownHostException e) {
                throw new IllegalStateException(e);
            }
        }
        return null;
    }

    private static void checkIp(InetAddress addr) throws SecurityException {
        for (Cidr cidr : BLOCKLIST) {
            if (cidr.contains(addr)) {
                throw new SecurityException("target IP is blocked");
            }
        }
    }

    private static InetAddress normalize(InetAddress addr) {
        if (addr instanceof Inet6Address) {
            byte[] b = addr.getAddress();
            boolean mapped = true;
            for (int i = 0; i < 10; i++) {
                if (b[i] != 0) {
                    mapped = false;
                    break;
                }
            }
            if (mapped && b[10] == (byte) 0xff && b[11] == (byte) 0xff) {
                try {
                    return InetAddress.getByAddress(Arrays.copyOfRange(b, 12, 16));
                } catch (UnknownHostException ignored) {
                }
            }
        }
        return addr;
    }

    private static URI parse(String url) throws SecurityException {
        try {
            return new URI(url);
        } catch (URISyntaxException e) {
            throw new SecurityException("malformed URL");
        }
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    static final class Cidr {
        private final InetAddress network;
        private final int prefixLength;

        private Cidr(InetAddress network, int prefixLength) {
            this.network = network;
            this.prefixLength = prefixLength;
        }

        static Cidr of(String spec) {
            String[] parts = spec.split("/");
            try {
                return new Cidr(InetAddress.getByName(parts[0]), Integer.parseInt(parts[1]));
            } catch (UnknownHostException e) {
                throw new IllegalArgumentException("bad CIDR: " + spec, e);
            }
        }

        boolean contains(InetAddress addr) {
            byte[] a = normalize(addr).getAddress();
            byte[] n = network.getAddress();
            if (a.length != n.length) {
                return false;
            }
            int bits = prefixLength;
            for (int i = 0; i < a.length && bits > 0; i++) {
                int consume = Math.min(8, bits);
                int mask = (0xff << (8 - consume)) & 0xff;
                if ((a[i] & mask) != (n[i] & mask)) {
                    return false;
                }
                bits -= consume;
            }
            return true;
        }

        @Override
        public String toString() {
            return network.getHostAddress() + "/" + prefixLength;
        }
    }
}
```

`PinningResolverProvider.java`：

```java
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.net.spi.InetAddressResolver;
import java.net.spi.InetAddressResolverProvider;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

public final class PinningResolverProvider extends InetAddressResolverProvider {

    private static final Map<String, byte[]> PINS = new ConcurrentHashMap<>();

    public static void pin(String host, byte[] address) {
        PINS.put(normalize(host), address);
    }

    public static void unpin(String host) {
        PINS.remove(normalize(host));
    }

    private static String normalize(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1);
        }
        return h;
    }

    @Override
    public String name() {
        return "pinning-resolver";
    }

    @Override
    public InetAddressResolver get(Configuration configuration) {
        return new InetAddressResolver() {
            @Override
            public Stream<InetAddress> lookupByName(String host, LookupPolicy lookupPolicy)
                    throws UnknownHostException {
                byte[] pinned = PINS.get(normalize(host));
                if (pinned != null) {
                    return Stream.of(InetAddress.getByAddress(host, pinned));
                }
                return configuration.builtinResolver().lookupByName(host, lookupPolicy);
            }

            @Override
            public String lookupByAddress(byte[] addr) throws UnknownHostException {
                return configuration.builtinResolver().lookupByAddress(addr);
            }
        };
    }
}
```

`META-INF/services/java.net.spi.InetAddressResolverProvider` 注册文件（把 `PinningResolverProvider` 放入 classpath 的 `META-INF/services` 目录下，使 SPI 全局生效）：

```
PinningResolverProvider
```

**使用与注意：**

- 解析器 SPI 是 JVM 全局的：注册后所有 `InetAddress` 查询都会先经过 `lookupByName`，未 pin 的 host 委托给内置解析器，对业务透明；每个请求只在"发送前 → 发送后 finally"窗口内写入 pin
- 关键点：pin 时用 `InetAddress.getByAddress(host, pinned)` 把原始 hostname 附着在地址上，否则 JDK 会拿解析出的 IP 做 TLS 证书校验/SNI，导致 HTTPS 对虚拟主机失效
- 若目标环境是 JDK 11-17（无 `InetAddressResolverProvider`），可用 OkHttp 的 `Dns` 接口实现等效 Pinning；纯 JDK 方案下 HTTPS 需 JDK 18+
- 白名单域名建议同时做 IDN → Punycode 规范化（`java.net.IDN`）后再匹配
- 高并发场景下，全局 `PINS` 按 host 读写：同一 host 并发 fetch 到不同 IP 时可能存在短窗口覆盖，若需严格隔离可改为按 host 加锁

### Python

**方案说明：**基于 `requests`（底层 urllib3 2.x）。Pinning 通过自定义 urllib3 连接类实现：拨号时把 `_dns_host` 临时替换为固定 IP，而 `host`（Host 头、SNI、TLS 证书校验）全程保持原始域名，因此 HTTP/HTTPS 均正确。解析用标准库 `urllib.parse.urlsplit`，但在解析前**先拒绝反斜杠与控制字符**，封死 `\` + `@` 类的解析器分歧。

**几个实现要点：**

- IP 字面量强制规范形式；解析出的**全部** getaddrinfo 记录逐一校验
- `_PinnedConnMixin._new_conn` 只在拨号瞬间切换 `_dns_host`（try/finally 恢复），`self.host` 不变，所以 Host 头与 TLS 校验仍用域名
- 每次 fetch 使用独立 Session 并设置 `trust_env = False`，忽略系统代理（防止代理被用作绕过手段）
- `allow_redirects=False` 手动重定向，每个跳转重新走完整校验
- 域名白名单启用时拒绝 IP 字面量直连；所有失败统一抛 `SSRFError`（脱敏）

```python
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.poolmanager import PoolManager


class SSRFError(Exception):
    pass


IPV4_CANONICAL = re.compile(
    r"^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
    r"(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$"
)

ALLOWED_SCHEMES = ("http", "https")
ALLOWED_DOMAINS = {"api.example.com"}
BLOCKLIST = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("::ffff:0:0/96"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]
MAX_REDIRECTS = 3
TIMEOUT = 5


class _PinnedConnMixin:
    _pinned_ip = None

    def _new_conn(self):
        if not self._pinned_ip:
            return super()._new_conn()
        original = self._dns_host
        self._dns_host = self._pinned_ip
        try:
            return super()._new_conn()
        finally:
            self._dns_host = original


class _PinnedHTTPConnection(_PinnedConnMixin, HTTPConnection):
    pass


class _PinnedHTTPSConnection(_PinnedConnMixin, HTTPSConnection):
    pass


class _PinnedHTTPConnectionPool(HTTPConnectionPool):
    ConnectionCls = _PinnedHTTPConnection
    _pinned_ip = None

    def _new_conn(self):
        conn = super()._new_conn()
        conn._pinned_ip = self._pinned_ip
        return conn


class _PinnedHTTPSConnectionPool(HTTPSConnectionPool):
    ConnectionCls = _PinnedHTTPSConnection
    _pinned_ip = None

    def _new_conn(self):
        conn = super()._new_conn()
        conn._pinned_ip = self._pinned_ip
        return conn


class _PinnedPoolManager(PoolManager):
    def __init__(self, pinned_ip, **kwargs):
        self._pinned_ip = pinned_ip
        super().__init__(**kwargs)
        self.pool_classes_by_scheme = {
            "http": _PinnedHTTPConnectionPool,
            "https": _PinnedHTTPSConnectionPool,
        }

    def _new_pool(self, scheme, host, port, request_context=None):
        pool = super()._new_pool(scheme, host, port, request_context)
        pool._pinned_ip = self._pinned_ip
        return pool


class _PinnedAdapter(HTTPAdapter):
    def __init__(self, pinned_ip):
        self._pinned_ip = pinned_ip
        super().__init__()

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        self.poolmanager = _PinnedPoolManager(
            self._pinned_ip,
            num_pools=connections,
            maxsize=maxsize,
            block=block,
            **pool_kwargs,
        )


class SSRFHttpClient:
    def fetch(self, url):
        return self._fetch(url, 0)

    def _fetch(self, url, hop):
        if hop > MAX_REDIRECTS:
            raise SSRFError("too many redirects")

        parsed = self._parse(url)
        scheme = parsed.scheme.lower()
        host = parsed.hostname.lower()
        port = parsed.port
        literal = self._resolve_literal_or_domain(host)
        if literal is not None:
            if ALLOWED_DOMAINS:
                raise SSRFError("IP literal not allowed with domain whitelist")
            self._check_ip(literal)
            pinned = str(literal)
        else:
            if ALLOWED_DOMAINS and host not in ALLOWED_DOMAINS:
                raise SSRFError("domain not allowed")
            addrs = self._resolve_all(host, scheme, port)
            for ip in addrs:
                self._check_ip(ip)
            pinned = str(addrs[0])

        canonical = urlunsplit(
            (scheme, _format_netloc(host, port), parsed.path or "/", parsed.query, parsed.fragment)
        )

        session = requests.Session()
        session.trust_env = False
        adapter = _PinnedAdapter(pinned)
        session.mount("http://", adapter)
        session.mount("https://", adapter)

        try:
            resp = session.get(canonical, allow_redirects=False, timeout=TIMEOUT)
        except Exception:
            raise SSRFError("connection failed")

        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            if not location:
                raise SSRFError("redirect without Location")
            return self._fetch(urljoin(url, location), hop + 1)

        return resp

    def _parse(self, url):
        if not isinstance(url, str) or len(url) > 2048:
            raise SSRFError("invalid URL")
        if re.search(r"[\\\x00-\x1f\x7f]", url):
            raise SSRFError("invalid URL")
        parsed = urlsplit(url)
        if not parsed.scheme or not parsed.hostname:
            raise SSRFError("invalid URL")
        if parsed.scheme.lower() not in ALLOWED_SCHEMES:
            raise SSRFError("scheme not allowed")
        try:
            parsed.port
        except ValueError:
            raise SSRFError("invalid port")
        return parsed

    def _resolve_literal_or_domain(self, host):
        if ":" in host:
            try:
                return ipaddress.ip_address(host)
            except ValueError:
                raise SSRFError("invalid IP literal")
        if IPV4_CANONICAL.match(host):
            return ipaddress.ip_address(host)
        if re.match(r"^[0-9.]+$", host) or "0x" in host.lower():
            raise SSRFError("non-canonical IP format")
        return None

    def _resolve_all(self, host, scheme, port):
        if port is None:
            port = 443 if scheme == "https" else 80
        try:
            infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror:
            raise SSRFError("DNS resolution failed")
        addrs = []
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if ip not in addrs:
                addrs.append(ip)
        if not addrs:
            raise SSRFError("no address resolved")
        return addrs

    def _check_ip(self, ip):
        if isinstance(ip, ipaddress.IPv6Address):
            try:
                mapped = ip.ipv4_mapped
            except ValueError:
                mapped = None
            if mapped is not None:
                ip = mapped
        for net in BLOCKLIST:
            if ip in net:
                raise SSRFError("target IP is blocked")

    @staticmethod
    def _format_netloc(host, port):
        if ":" in host:
            host = "[%s]" % host
        if port is not None:
            host = "%s:%s" % (host, port)
        return host
```

**使用与注意：**

- 需要 `requests>=2` 且底层 `urllib3>=2.0`（`_dns_host` 仅在 urllib3 2.x 存在）
- 白名单域名建议先做 IDN → Punycode 规范化（`idna` 库）再匹配
- 生产环境如需自定义 CA（如企业内网 CA），可把 `session.verify` 配置为 CA 路径
- `urlsplit` 对 IP 字面量的解析不参与实际拨号：实际连接永远走 `_pinned_ip`，域名与解析结果解耦，DNS Rebinding 无法生效

## 为什么SSRF面临的问题那么多，但却很少感知到？

