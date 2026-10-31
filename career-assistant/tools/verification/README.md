# 独立外部能力验证工具

此目录只属于第三步已确认的验证方案，不是第四步正式monorepo或业务服务。无数据库、账号、业务API或部署。

## 复现环境

本次使用Node 24.19.0、npm 11.17.0；实际依赖锁定在 `runtime/package-lock.json`。不要把临时依赖目录、密钥或真实简历提交Git。

从本目录运行：

```sh
mkdir -p /tmp/career-verification-runtime
cp runtime/package.json /tmp/career-verification-runtime/package.json
cp runtime/package-lock.json /tmp/career-verification-runtime/package-lock.json
npm ci --prefix /tmp/career-verification-runtime --ignore-scripts --no-audit --no-fund
ln -s /tmp/career-verification-runtime/node_modules node_modules
```

`node_modules`若已有正确链接，无需再次创建；不要覆盖陌生目录。依赖仅安装到/tmp，不创建正式workspace。临时目录删除后需按锁文件重装。

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
node cli.ts --kind document --run-id <新的UUID> --output ../../docs/verification
node cli.ts --kind model --run-id <新的UUID> --output ../../docs/verification
```

`source`和`all`会访问真实来源，需要在获批预算内运行；不可因报告blocked无限重试。公开探测累计22次（含关联核验4次），后续会话预留4次，来源累计26次本轮额度已用完，不再运行新的来源探测；公开探测入口的每次上限20不代表全局剩余额度。

## DeepSeek 本地配置

用户已指定 `deepseek-v4-pro`，API Key由用户自行配置。默认采用DeepSeek官方Chat Completions协议，地址为 `https://api.deepseek.com`，接口为 `/chat/completions`；官方文档列出该模型及JSON、工具调用支持：[模型说明](https://api-docs.deepseek.com/quick_start/pricing/)、[接口文档](https://api-docs.deepseek.com/api/create-chat-completion/)。文档支持不等于已经完成真实联通验证。

同目录 `.env.verification` 已准备模型名、地址和协议，密钥留空；用户只需在本地填写 `MODEL_API_KEY=`。该文件由 `.gitignore` 排除，权限仅本人可读写；可提交的模板是 `.env.verification.example`。其他网关地址由用户明确配置，不能自动替换模型。

Node需显式加载本地配置：`node --env-file=.env.verification cli.ts ...`。仅填写文件不会自动请求；**显式执行model/all会调用真实模型**，请求前写持久化账本，跨runId合计最多5次，禁止自动重试和重定向。此次真实额度已经用完，不能删除账本后偷偷再次验证。

真实验证使用非思考模式，JSON模式、SSE及函数工具调用各自校验。官方规则见[JSON输出](https://api-docs.deepseek.com/guides/json_mode/)、[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[思考模式开关](https://api-docs.deepseek.com/guides/thinking_mode/)。思考模式下的工具回传未验证，也不保存推理内容。

复查已完成报告不会再次请求，可运行：

```sh
node --env-file=.env.verification cli.ts --kind model --run-id 736bf63c-45ce-4a7e-b51e-1950a57d8147 --output ../../docs/verification
```

## 来源会话准备

需要登录才能继续验证分页时，优先使用用户已登录同站请求的Cookie，账号密码不一定能处理验证码或短信。私有文件为同目录 `.env.source`，只需填写 `SOURCE_COOKIE`：完整Cookie值（`name=value; name2=value2`），不含 `Cookie:` 前缀，不填写响应头 `Set-Cookie`，也不要复制无关站点Cookie。可从浏览器开发者工具Network里已登录同站请求的Request Headers取得。

Cookie会过期，且有些站点还校验其他会话条件；是否能读第2页必须实际验证，不保证仅注册就有全部访问权限。不要将Cookie或密码发进聊天。该文件被Git忽略、权限0600；模板为 `.env.source.example`。

用户配置Cookie后已授权同页对照及缺陷修复复测，最新匿名提示登录、认证第2页可见10个岗位标识。会话复测阶段累计22次额度已用完，后续按“继续验证”补充4次公开关联请求，当前累计26次，不自动登录、注册或追加请求。只读重放已完成结果：

```sh
node --env-file=.env.source session-cli.ts --run-id 137f250f-39a1-4f80-b226-045fdc155974 --output ../../docs/verification
```

同runId直接读取脱敏报告，不联网；其他runId仍受跨运行累计账本限制。认证HTML不保存。

## 入口及状态

- `--kind`：source / document / model / all。
- `--run-id`：UUID；完成后同ID回放报告，无新外部请求；改kind或预算为冲突。
- `--output`：报告父目录；每次独立子目录。
- `--limit`：来源请求数1—20，默认20，重定向同样计数。
- 退出0：请求能力均通过；退出2：报告完整但存在blocked/failed/not_run；退出1：输入、运行锁或其他执行失败。退出2不是“所有能力完成”。

报告写入前持有文件排他锁，进程/保存失败保留锁，防止未知外部副作用被悄悄重做。需要人工核对后再恢复，不自动抢占。

## 范围和已知限制

- 来源使用Node原生fetch，检查robots、首页、列表、公开岗位与公告，HTML仅做验证所需的有限提取，不是完整生产爬虫。当前匿名分页被登录限制阻塞，不绕过。
- 原始快照包含公开来源内容，不保存Cookie、认证头或私人登录资料；两个校招岗位与公告双向关联已核对，其他岗位和外站原文仍未验证。
- PDF.js只提取文字层；DOCX先校验解压规模；TXT仅UTF-8。无OCR；模型字段理解由独立model验证入口验证，未实现完整业务简历解析。
- PDF正例为英文；TXT/DOCX包含中文。中文复杂字体PDF、多栏简历、负载和完整恶意文档隔离尚未验证。
- model入口已接入DeepSeek V4 Pro，真实5次请求验证通过；固定虚构样本不能证明任意简历零幻觉，也不代表业务Agent/MCP模块已完成。配置检查inspectModelConfiguration本身仍不发请求。
- 自动回归不加载私有env、不请求真实站点或收费模型；模型完整编排通过注入替身回归。实际CLI真实模型验证已另存报告，不能用替身报告顶替。

报告和逐项检查结果见 [第三步记录](../../docs/verification/README.md)。本步未完成Git初始化，不创建提交或推送；后续获批工程步骤纳入本地历史并注明原始来源。
