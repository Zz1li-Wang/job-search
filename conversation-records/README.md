# 对话与协作记录

此目录专门保存本项目对话流程，位于正式代码仓库 `career-assistant/` 外。

## 当前会话

<!-- current-session:start -->
- [可读对话](2026-10-31_01a1903e-ecd7-7410-9ce9-a5c40d497694/dialogue.md)：用户与助手文字，按原日志排序。
- [协作记录 JSONL](2026-10-31_01a1903e-ecd7-7410-9ce9-a5c40d497694/collaboration.jsonl)：消息与工具调用及结果。
- [来源及范围](2026-10-31_01a1903e-ecd7-7410-9ce9-a5c40d497694/manifest.json)：截取时间、计数、摘要、过滤及脱敏范围。
<!-- current-session:end -->

## 保存原则

- 这是源日志的过滤、脱敏导出，不用事后总结代替真实消息。
- 不复制内部运行上下文、系统/开发者消息或推理记录；仅保存用户/助手文字与工具记录。
- 凭据按规则脱敏，目录仅当前用户可读写；对外提交前仍需人工复查个人信息和未识别秘密。
- 按用户要求，每轮开始和最终回复前运行 `python3 /home/ayanami/job-search/conversation-records/sync.py`，更新快照及manifest。没有后台监听：本轮最后一条回复要发送后才落盘，下轮开始补齐，不能承诺当前快照包含尚未发送的内容。
- 原始来源位置保存在 manifest 中，尚未删除或修改源日志。
- 本目录默认不进入 Git。需要对外提交时，单独准备复查后的副本并明确脱敏或缺失范围。
- 业务方案及验收状态仍以 `career-assistant/docs/plan.md` 为准，保存对话不代表推进开发。

## 同步工具检查

`sync.py`只读当前会话，不读取私有env，不复制其他会话；未能唯一确定会话或中间行损坏时报告失败。文件末尾尚未写完整的一行记录为待补齐。工具按字段及模式脱敏，但外发前仍需人工复查。

归档工具回归检查：`python3 -m unittest discover -s /home/ayanami/job-search/conversation-records -p test_sync.py`。该工具独立于业务工程，不代表业务接口或当前开发步骤通过验收。
