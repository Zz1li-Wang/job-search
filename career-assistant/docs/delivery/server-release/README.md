# 首次服务器交付

入口：[https://47.95.166.110](https://47.95.166.110)。请使用原账号重新登录；浏览器不会把localhost的Cookie自动发送到服务器IP。原简历仍解析成功，原画像草稿保持未确认，没有自动覆盖正式画像。发布完成，等待用户检查。

## 本次执行与证据

- 用户明确授权完整迁移、IP入口、开启采集并追加10次请求，SSH口令仅在本机终端输入。方案见[服务器发布方案](../../design/server-release.md)。
- 独立目录`/opt/career-assistant/releases/server-20261031`，当前入口`/opt/career-assistant/current`；Compose项目`career-assistant-server`。既有三个飞书容器保持运行，未覆盖已有端口、镜像或数据。
- 本地应用停止写入后生成一致快照。35张表逐表行数和排序行摘要一致，15个私有文件SHA256一致；原账号、会话、简历、草稿、画像、岗位及历史任务均恢复。见[迁移核对](migration-check.json)。本地原PG容器、私有文件和受保护备份保留，本地Web/API/Agent/Worker保持停止，避免两端继续处理同一数据。
- HTTPS公网证书由Let's Encrypt签发，SAN包含服务器IP，验证未忽略证书错误；HTTP308跳转到HTTPS。证书自动续签及证书卷已配置，实际证书到期时间见[公网检查](public-check.json)。尚未经历首次续签和连续7天运行，不把配置当作长期在线实测。
- 原来源预算39/40保留。本次独立预算`server-20261031-approved-10`已用10/10，累计新增10个任务成功、1个任务因`SOURCE_BUDGET_EXHAUSTED`暂停，新增9次HTTP200详情观察；现有10个岗位，没有宣称新增10个岗位。Worker继续运行以处理对话/简历任务，来源网络等待新增授权额度。见[线上状态](online-status.json)。
- 模型仍为deepseek-v4-pro，生产Agent读取现有配置；服务器模型列表检查HTTP200且包含该模型，本轮新增模型推理0次。原简历真实解析修复证据仍属于[前次修复](../resume-parse-fix/README.md)，不冒充本轮再次解析。
- 公网真实浏览器通过注册、登录、刷新会话、Secure/HttpOnly、岗位浏览、统一咨询/简历入口、内部路径404与删除后会话撤销，见[浏览器检查](browser-check.json)。临时账号按正式流程删除，保留删除审计/屏障；首次验证脚本过早截图旧验证码而失败，修正为重新加载登录页面后通过，未改生产认证代码。
- 重建API/Worker并重启Caddy后，原简历、画像草稿及对话的内容摘要未变，HTTPS、预算和健康检查正常。Docker已启用开机启动，五个常驻容器配置unless-stopped，见[持久化复查](persistence-check.json)。仅80/443映射公网；API、Agent、PG保持私网。认证只信任本项目私有网络172.20.0.0/16中代理的转发头，重建网络时须重新核对该CIDR。

## 测试与范围

[17项质量门禁](checks.json)全部通过；60单元、126真实PG集成、18浏览器/进程E2E、77历史工具回归，共281项。浏览器首次缺少libnspr4，按项目已有`LD_LIBRARY_PATH`和字体配置重跑E2E后通过；其他已通过检查沿用本轮结果。报告见[单元](unit.json)、[集成](integration.json)、[E2E](e2e.json)。检查时间是实际测试区间，不代表全部开发工时。

[12项生产容器检查](container-check.json)通过，覆盖HTTPS、真实PDF/DOCX、共享持久卷、重启、备份恢复及服务器恢复后保持业务停止的门禁，模型/来源使用离线配置。另有[服务器覆盖配置检查](config-check.json)及上述公网真实验证，不能互相替代。未做新的生产简历解析或收费咨询，未替用户确认画像，未进行全站岗位覆盖或完整人工条件核验。数据说明页仍有将API自身网络关闭状态当作Worker状态的既有文案问题，应以实际预算与任务状态为准。

## 运维命令

SSH进入服务器后，在当前发布目录执行。覆盖文件必须贯穿启动、状态、备份和恢复，不能只使用默认Compose，否则会关闭来源网络或退回默认证书策略。

```sh
cd /opt/career-assistant/current
export CAREER_COMPOSE_OVERRIDE=deploy/compose.server.yml
sh deploy/compose.sh ps
sh deploy/compose.sh logs --tail 50 api agent worker web
```

私有配置位于`deploy/.env.production`和`deploy/.env.source`，均0600；Cookie文件属UID1000，仅Worker只读挂载。外层应用目录0700，密钥不在源码包、Git或公开报告中。不在控制台展开配置或打印env。模型密钥仅传入Agent，来源Cookie仅传入Worker。

初始一致备份在`/opt/career-assistant/backups/initial-20261031/`，包含`database.dump`、`files.tar.gz`及摘要清单；原本机备份在项目被忽略的`.artifacts/server-private/migration/`。配置须另行受控保管，备份包含个人资料，不能公开分享。维护窗口新增一致备份：

```sh
sh deploy/compose.sh stop web worker agent api
sh deploy/backup.sh /opt/career-assistant/backups/manual-YYYYMMDD
sh deploy/compose.sh up -d --no-build --wait --wait-timeout 120
```

备份失败时先排查并保留日志，不把不完整备份当作恢复点；恢复业务用最后一条启动命令。不要在有在途模型任务时直接停止并自动重试，以免重复计费。

需要恢复时先确认目标仍是本次项目、备份通过隔离验证且接受覆盖该备份点之后的数据，再执行：

```sh
sh deploy/restore.sh /opt/career-assistant/backups/initial-20261031/database.dump /opt/career-assistant/backups/initial-20261031/files.tar.gz
```

恢复会替换当前项目数据，不能在未确认丢弃后续写入时直接执行。使用服务器覆盖文件时，脚本恢复后保持业务停止；旧备份可能恢复已删除资料或已用额度，必须先重放删除记录并把来源预算对账到至少实际已用值，然后才能显式启动业务，不能恢复后再次获得同一10次额度。首次发布没有旧线上版本；失败回退应停止本项目流量，保留原本机恢复点，不操作飞书容器。后续应用回退先检查schema兼容性。

不可变镜像标识及源码归档见[发布清单](release-manifest.json)。本轮只创建中文本地提交，未推送Git远端。服务器配置、镜像与备份通过SSH单独传送，首次发布和重新启动已实测，长期续签及7天在线仍待后续实际观察。
