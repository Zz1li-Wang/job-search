# AI 求职助手

面向大学生的 AI 求职助手，基于从职点迷津获取的岗位数据，提供持续求职咨询、简历解析、画像确认、岗位查询与资格核验，以及收藏和手动投递进度管理。项目使用 Codex coding agent 辅助完成，实际投入时间为 **8 小时**。

**网站地址：[https://47.95.166.110](https://47.95.166.110)**。可使用用户名、密码和图片验证码自行注册，再登录体验，无需邮箱或手机号。

本仓库包含应用源码、考题原文、设计与验证材料，以及脱敏后的 coding agent 协作记录。完整的可信性说明、数据范围、线上版本和未完成事项见[项目提交说明](career-assistant/README.md)。

## 评审入口

| 材料         | 位置与说明                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在线网站     | [公网入口](https://47.95.166.110)，注册后即可使用                                                                                                                                                                                           |
| 项目说明     | [career-assistant/README.md](career-assistant/README.md)，包含可信性证据、投入时间、已知问题和交付缺口                                                                                                                                      |
| 应用源码     | [career-assistant/](career-assistant/)，TypeScript Monorepo                                                                                                                                                                                 |
| 本地运行     | [本地开发与验证](career-assistant/docs/local-development.md)                                                                                                                                                                                |
| 岗位数据     | [最新 36 条岗位 JSON](career-assistant/docs/delivery/ingestion-expansion/source-data.json)、[本轮采集范围](career-assistant/docs/delivery/ingestion-expansion/README.md)及[历史岗位 JSON](career-assistant/docs/ingestion/source-data.json) |
| 发布与测试   | [服务器交付](career-assistant/docs/delivery/server-release/README.md)，含镜像、迁移、测试及公网验证记录                                                                                                                                     |
| 原始协作记录 | [conversation-records/](conversation-records/)，逐会话提供对话、工具记录、来源摘要和脱敏范围                                                                                                                                                |
| 考题原文     | [职点迷津全栈工程师实战考题](职点迷津-全栈工程师实战考题.pdf)                                                                                                                                                                               |

## 功能与使用流程

1. 注册登录后进入“求职咨询”，介绍背景和目标，持续追问方向、岗位、简历或面试问题。
2. 在咨询页上传文本 PDF、DOCX、TXT，或粘贴简历文字；核对模型生成的画像草稿，修改并明确确认。
3. 浏览岗位详情和来源，按正式画像核验报名条件，查看符合、不符合或待核验的原因。
4. 收藏岗位，手动记录投递状态、日期和备注；在隐私入口清除个人数据或删除账号。

简历草稿未确认前不作为正式画像；条件缺失、来源冲突或证据过期时保持待核验。报名资格由后端规则计算，Agent 通过受限 MCP 工具读取业务结果。系统不自动执行外部报名或投递。

## 仓库结构

```text
job-search/
├── README.md                     仓库总览与评审入口
├── career-assistant/             AI 求职助手应用
│   ├── apps/
│   │   ├── web/                  React 前端
│   │   ├── api/                  业务 API 与内部 MCP
│   │   ├── agent/                独立 Agent 服务
│   │   └── worker/               采集、解析与补偿任务
│   ├── packages/                 契约、领域、Agent Core 等共享包
│   ├── tests/                    单元、集成及 E2E 测试
│   ├── deploy/                   容器、HTTPS、备份恢复配置
│   └── docs/                     需求、方案、验证与交付材料
├── conversation-records/         脱敏协作日志及范围清单
└── 职点迷津-全栈工程师实战考题.pdf
```

主要技术栈为 TypeScript、pnpm workspace、React、Vite、NestJS、Zod、PostgreSQL、Prisma 和 MCP。模型配置为 deepseek-v4-pro，部署使用 Docker Compose 与 Caddy。架构和接口边界见[运行契约](career-assistant/docs/design/runtime-contracts.md)。

## 本地运行与验证

需要 Node.js 24、pnpm 12.4.2 和 PostgreSQL；自动化数据库测试使用 Docker，浏览器测试需要 Playwright Chromium。先按 `career-assistant/.env.example` 配置本地环境，完整步骤见[本地开发与验证](career-assistant/docs/local-development.md)。

```sh
cd career-assistant
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm dev
```

默认前端地址为 `http://127.0.0.1:5173`。完整质量检查命令为：

```sh
pnpm check
```

首次服务器交付归档记录为 **281 项测试通过**，包括 60 项单元、126 项真实 PostgreSQL 集成、18 项浏览器或进程 E2E，以及 77 项历史工具回归；另有 17 项质量门禁和 12 项生产容器检查。自动回归的模型和来源网络使用可控替身，真实外部调用证据单独归档，具体时间及边界见[服务器交付报告](career-assistant/docs/delivery/server-release/README.md)。

## 当前范围与未完成事项

以下状态以 2026 年 10 月 31 日发布及最新服务器扩量采集记录为准：

- 线上已取得正文的真实岗位从 10 条扩充到 **36 条：33 校招、1 社招、2 类型未知**，另有 4 条仅发现链接。完整人工条件核验仍为 0，尚不足以证明真实岗位的可报名推荐效果。当前服务器的 36 条岗位及版本观察已导出；跨历史环境资料的最终统一合并仍待补齐。
- 网站已完成首次公网部署；代码更新后自动上线尚未接通，连续 7 天可用及首次证书续签尚未完成实测。
- 来源新增额度已耗尽，相关采集任务暂停；尚未实现全站覆盖和长期实时更新验证。
- 本仓库收录源码及文档快照。原应用工程的完整 Git 历史包另行保留，尚需作为附件交付；原线上应用提交和镜像对应关系见[发布清单](career-assistant/docs/delivery/server-release/release-manifest.json)。
- 扫描件不做 OCR；暂无密码找回；部分历史列表有数量上限；数据说明页的网络状态提示存在已记录的显示问题。

协作日志是过滤、脱敏后的真实记录，排除内部上下文和推理内容，不包含凭据。各会话的截止时间、过滤及缺失范围以对应 `manifest.json` 为准，详见[协作记录说明](conversation-records/README.md)。
