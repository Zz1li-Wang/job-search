# 工作区入口

每轮开始和最终回复前运行：

```sh
python3 /home/ayanami/job-search/conversation-records/sync.py
```

开始时补齐上轮最终回复，结束前同步已落盘的本轮消息和工具记录。当前最终回复尚未发送，须下一轮补齐；不宣称后台实时监听。同步失败必须如实说明。不得将密钥、密码或Cookie写入对话导出，不修改原始日志。

项目任务先读取 `career-assistant/AGENT.md` 和 `career-assistant/docs/plan.md`。具体模块方案先经用户确认，实现后逐步交付检查；日志维护不代表推进业务步骤。
