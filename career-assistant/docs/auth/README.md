# 第五步：账号认证交付检查

状态：第五步已验收。用户在本地提交faf9dd9交付后回复“继续”，记录为通过；第六步仅准备采集方案，实现尚未开始。

## 本步功能

- /register：用户名、密码、确认密码和真实PNG验证码；注册成功进入登录页，不自动登录。
- /login：一次性浏览器绑定验证码、账号密码验证、数据库限流及失败冷却；成功通过HttpOnly Cookie建立7天固定会话。
- /settings：本人账号、修改密码和退出；刷新页面通过me恢复登录，改密撤销全部设备旧会话。
- 对应6个HTTP接口：captcha、register、login、logout、me、password。公开DTO只返回id/username/createdAt/csrfToken等约定字段，令牌不进入payload。
- PostgreSQL新增User、Session、CaptchaChallenge、AuthAttempt、AuthRateBucket；规范化用户名与会话摘要唯一，计数/版本非负，外键约束真实生效。
- 密码使用Node异步scrypt及随机盐，计算并发2、等待队列16；在事务外计算，提交前复查账号版本，避免旧密码运算补建会话或覆盖新密码。
- 验证码首次校验尝试原子消费，答错也不能复用；其他浏览器不能消费挑战。请求限流和冷却由数据库保证多进程一致。
- API负责Origin、CSRF、身份上下文和协议映射；Entity负责状态判断，Service只编排，Repository/Mapper封闭Prisma和SQL。

## 接口与覆盖

| 操作       | 方法和路径                 | 契约及测试                                                |
| ---------- | -------------------------- | --------------------------------------------------------- |
| 获取验证码 | GET /api/v1/auth/captcha   | PNG可显示、浏览器绑定、刷新、到期、30次/分钟限制          |
| 注册       | POST /api/v1/auth/register | 201且不登录、唯一冲突、额外身份字段拒绝、CSRF/Origin      |
| 登录       | POST /api/v1/auth/login    | 安全Cookie、统一错误、验证码重放、5次失败后15分钟冷却     |
| 退出       | POST /api/v1/auth/logout   | 撤销当前设备、重复/空Cookie204、CSRF/Origin、其他设备保留 |
| 本人资料   | GET /api/v1/auth/me        | 只返回本人安全字段、到期/撤销401、伪造userId拒绝          |
| 修改密码   | PUT /api/v1/auth/password  | 原密码核验、密码版本条件更新、全部会话撤销、并发及回滚    |

接口均已登记在[机器清单](../../tests/interface-registry.json)。新增认证表缺失时API的ready为503、live仍200，Agent通过业务API健康检查同步降级，不请求模型。

## 检查结果

[最终检查](checks.json)共16项全部退出0，区间2026-10-30T09:24:16.195Z至2026-10-30T09:26:22.984Z。总计136个测试：

| 测试                 | 结果   | 证据                                                                                                |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| 单元及基础接口       | 27通过 | [JSON](unit-tests.json)；包含DTO、领域、真实scrypt/PNG、计算门、日志和4个健康接口                   |
| PostgreSQL及认证HTTP | 27通过 | [JSON](integration-tests.json)；6个认证接口、双连接并发、迁移无漂移、数据库约束、状态竞争及失败补偿 |
| 浏览器及实际进程     | 5通过  | [JSON](e2e-tests.json)；2条账号完整场景和3条原工程E2E                                               |
| 原验证工具回归       | 77通过 | 沿用独立工具入口，真实模型/来源请求账本摘要不变                                                     |

浏览器场景包含真实PNG、生产参数scrypt和真实PostgreSQL，覆盖注册不登录、正确登录、刷新恢复、第二设备、改密后两个旧会话失效、新密码重登、重复退出、错误验证码、重放、CSRF和冷却恢复。测试随机源与Clock只在测试专用进程中通过代码注入；生产main不读取测试答案或跳过开关。

[密码运行样本](crypto-profile.json)：N=131072、r=8、p=1，单次哈希668ms，测试进程观测最大RSS 278676KiB。该值包含测试进程和已加载库，不是单个哈希的精确峰值，也不代表其他机器或高负载性能。

## 发现并修正的问题

1. 限流Repository最初把包含额外字段的Entity快照直接作为Prisma复合键，导致验证接口503；已改为显式映射三个键字段，真实接口回归通过。
2. SQL迁移的外键ON UPDATE与Prisma默认规则不一致；独立差异核对发现后修正为CASCADE，并加入真实迁移无漂移测试。Prisma差异工具不覆盖全部自定义CHECK，另用实际非法写入验证非负计数和外键约束。
3. 清理预算改为三个表合计最多100条，跳过锁定记录；测试验证总上限及有效挑战保留。
4. 业务拒绝在验证码消费/失败计数提交后返回，防止抛异常回滚掉一次性状态。会话创建及改密撤销失败时则整体回滚当前账号事务。
5. 浏览器账号服务503显示重试提示，不伪装为未登录；过期或版本冲突才清前端身份。中文截图复查发现测试环境缺字库，已在/tmp补齐Noto CJK字体，未修改系统。

## 本地运行与限制

按[根README](../../README.md)启动数据库、迁移、API和前端，打开http://127.0.0.1:5173/register自行创建账号。没有预设可用于生产的账号或固定验证码。

本地.env已追加独立随机AUTH_TOKEN_PEPPER/AUTH_CSRF_SECRET和AUTH_PUBLIC_ORIGIN，秘密未打印或纳入Git。生产要求HTTPS和安全Cookie，拒绝空秘密、相同秘密和模板值。跨域Origin/代理范围需由服务器配置，默认不信任X-Forwarded-For。

浏览器测试所需运行库位于/tmp/career-browser-deps，Noto CJK位于/tmp/career-browser-fonts。若精简环境需要这些临时配置，可用：

```sh
FONTCONFIG_FILE=/tmp/career-browser-fonts/fonts.conf \
LD_LIBRARY_PATH=/tmp/career-browser-deps/usr/lib/x86_64-linux-gnu pnpm check
```

正常具备Chromium系统库和中文字体的环境不需要上述变量；临时依赖不随Git交付。获取字体采用apt-get download fonts-noto-cjk后解压，字体配置指向临时目录。

本轮未调用DeepSeek或来源网站，预算保持模型5次、来源26次；未操作已有pgsql-local数据库、未执行远端推送或部署。生产任务、求职岗位和对话模块仍未实现。交付当时停止等待第五步验收；随后用户“继续”通过，当前状态见本文开头。
