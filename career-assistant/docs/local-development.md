# 本地开发与验证

本地安装、运行和自动检查方法如下，命令在项目根目录执行。项目介绍、线上状态及考题交付内容见[项目 README](../README.md)。

## 本地启动

需要Node 24、pnpm 12.4.2、PostgreSQL；测试和自带数据库使用Docker。已有私有配置请保留，不要覆盖或提交`.env`。全新环境按`.env.example`配置数据库、独立随机认证秘密和服务令牌，文件权限0600。

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm dev
```

如果使用工程自带的本地数据库，先执行`docker compose -p career-assistant-dev up -d postgres`，确认`.env`的DATABASE_URL与POSTGRES_PASSWORD、POSTGRES_PORT一致；已配置现有数据库则使用现有实例。停止该本地库用同一项目名的`docker compose ... stop postgres`，不要随意删除持久卷。

默认Web为`http://127.0.0.1:5173`，API 3001、Agent 3002。`pnpm dev`启动四个应用，Ctrl+C一起停止；也可分别使用`dev:api`、`dev:agent`、`dev:worker`、`dev:web`。前端Origin必须与AUTH_PUBLIC_ORIGIN一致，改变API端口时同步API_INTERNAL_URL。

模型使用deepseek-v4-pro。Agent启动器兼容已有`tools/verification/.env.verification`，缺失时才补该文件配置；无需在聊天发送密钥。API/Worker不读取此模型私有文件。健康检查不调用模型，咨询和简历解析会使用配置的模型服务。持续来源网络默认关闭，Cookie只供明确启用网络的来源Worker读取，不作为本应用登录凭据。

## 使用路径

- `/register`、`/login`：用户名、密码和服务端PNG验证码；无需邮箱/手机，改密撤销所有旧会话，无密码找回。
- `/chat?resumes=open`、`/profile`：咨询页上传PDF/DOCX/TXT或粘贴→本地文字定位→模型草稿→核对、修改和明确确认；旧`/resumes`自动跳转。实习与正式工作分开，未确认资料不生效。
- `/chat`：多轮方向分析、岗位与资格解释、简历建议、面试准备；流式回放、取消和显式重试，假设不自动写入真实画像。
- `/jobs`：校招/社招筛选、详情、原文证据、更新请求和三态核验。应届生按条件判断社招，未知或过期不当作满足。
- `/favorites`、`/applications`：收藏、手动投递状态/日期/备注及历史；不代投，不因聊天自动推进状态。
- `/trust`、`/privacy`、`/settings`：实际覆盖与限制、清空画像/个人数据、账号删除和密码管理；访问撤销与文件物理清理分开显示。

业务库不会自动填充虚构岗位或个人资料。原采集交付为4校招+1社招，后经用户授权启用本地Worker，首批10条实际岗位已入库，完整人工条件核验仍0，见[当前本机运行记录](ingestion/local-worker.md)。原历史模型5次、来源53次属于旧验证；后续按用户授权新增来源12次、简历模型诊断7次，真实简历已生成待确认草稿，见[修复复验](delivery/resume-parse-fix/real-verification.json)。自动回归只使用本地模型及来源替身。

## 架构与接口

`web → API/MCP → DTO → Service → Entity → Repository → Prisma/PostgreSQL`。Prisma与SQL只在持久化基础设施内部；Agent Core不依赖业务DB，通过受限MCP使用8个工具。正式画像、资格依赖、幂等、版本冲突、运行租约和删除屏障均由后端维护；外部网络和文件I/O在业务事务之外。

API公开健康入口；Agent同路径要求服务凭据。MCP和`/internal/*`只供内部访问，生产Caddy拒绝公网转发。具体契约、首版容量限制与相对提案的调整见[运行契约](design/runtime-contracts.md)，每个操作对应可执行测试：60个HTTP操作、8个MCP工具及4个维护命令。

## 验证与部署

```sh
pnpm check
```

完整门禁包含生成、构建、格式、Lint、类型、分层、接口/维护清单、单元、真实PG集成、浏览器/进程E2E、77项历史工具回归和Git空白检查。全新环境先安装Playwright Chromium及系统库，历史工具按[环境说明](../tools/verification/README.md)安装隔离依赖。测试数据库自动创建并清理，不连接现有pgsql-local或业务库，不调用真实模型和来源。

精简Linux本轮使用临时浏览器库和字体，其他环境安装系统依赖后不需要：

```sh
FONTCONFIG_FILE=/tmp/career-browser-fonts/fonts.conf LD_LIBRARY_PATH=/tmp/career-browser-deps/usr/lib/x86_64-linux-gnu pnpm check
```

Docker/HTTPS/持久卷、迁移门禁、备份恢复、CI及手动发布包已准备；本地生产容器演练有独立报告。当前已完成首次公网发布；远端推送与连续 7 天在线验证仍未完成，当前线上状态见[服务器交付](delivery/server-release/README.md)，运维方法见[部署手册](delivery/deployment.md)。开发规范见[AGENT.md](../AGENT.md)；对话导出由工作区外conversation-records维护，不加入本仓库。
