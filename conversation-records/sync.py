"""导出本工作区会话的可见消息与工具记录，原始日志只读。"""
from __future__ import annotations

import collections
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata
from datetime import datetime, timezone


SENSITIVE_KEY = re.compile(
    r"^(?:password|passwd|api[-_]?key|MODEL_API_KEY|SOURCE_COOKIE|cookie|set-cookie|"
    r"authorization|access[-_]?token|refresh[-_]?token|session[-_]?token|secret|token)$", re.I
)
REDACTIONS = (
    (re.compile(r"art_v\d+_[A-Za-z0-9_-]+"), "[REDACTED_SITE_CREDENTIAL]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "[REDACTED_API_KEY]"),
    (re.compile(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/-]{16,}"), r"\1[REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "[REDACTED_SESSION_TOKEN]"),
    (re.compile(r'''(?i)(["'](?:password|passwd|api[-_]?key|MODEL_API_KEY|SOURCE_COOKIE|cookie|set-cookie|authorization|access[-_]?token|refresh[-_]?token|secret|token)["']\s*:\s*["'])([^"'\n]+)(["'])'''), r"\1[REDACTED]\3"),
    (re.compile(r"(?im)^(\s*(?:Cookie|Set-Cookie|Authorization)\s*:\s*).+$"), r"\1[REDACTED]"),
    (re.compile(r'''(?im)^(\s*(?:MODEL_API_KEY|SOURCE_COOKIE|PASSWORD|API_KEY)\s*=\s*).+$'''), r"\1[REDACTED]"),
    (re.compile(r'''(?i)\b((?:__Host-|__Secure-)?[A-Za-z0-9_.-]*(?:session|auth|token)[A-Za-z0-9_.-]*)=([^;\s"']+)'''), r"\1=[REDACTED]"),
    (re.compile(r'''((?:密钥密码|密钥口令|私钥密码|私钥口令)\s*(?:为|是|[:：=])?\s*)([^\s"'<>，。；]+)'''), r"\1[REDACTED]"),
    (re.compile(r'''(?i)(["']?chars["']?\s*:\s*["'])([^"'\n]+)(["'])'''), r"\1[REDACTED_STDIN]\3"),
)
DECLARED_CREDENTIAL = re.compile(r'''(?:密钥密码|密钥口令|私钥密码|私钥口令)\s*(?:为|是|[:：=])?\s*([^\s"'<>，。；]+)''')


class ExportError(Exception):
    """源数据不完整或身份不明时保留原导出，不猜测其他会话。"""


class Redactor:
    def __init__(self, declared_credentials=()):
        self.counts = collections.Counter()
        self.declared_credentials = {unicodedata.normalize("NFKC", value) for value in declared_credentials}

    def clean(self, value, key=None):
        if key and SENSITIVE_KEY.fullmatch(key) and value:
            self.counts["credential_field"] += 1
            return "[REDACTED]"
        if isinstance(value, dict):
            return {name: self.clean(child, name) for name, child in value.items()}
        if isinstance(value, list):
            return [self.clean(child) for child in value]
        if not isinstance(value, str):
            return value
        if unicodedata.normalize("NFKC", value.strip()) in self.declared_credentials:
            self.counts["declared_credential"] += 1
            return "[REDACTED]"
        if key == "chars" and value:
            self.counts["terminal_input"] += 1
            return "[REDACTED_STDIN]"
        # 工具输出经常把JSON嵌在字符串中，先解析再按字段脱敏。
        if value.lstrip().startswith(("{", "[")):
            try:
                parsed = json.loads(value)
            except ValueError:
                pass
            else:
                if isinstance(parsed, (dict, list)):
                    return json.dumps(self.clean(parsed), ensure_ascii=False)
        for index, (pattern, replacement) in enumerate(REDACTIONS, 1):
            value, count = pattern.subn(replacement, value)
            self.counts[f"pattern_{index}"] += count
        return value


def atomic_write(path: Path, content: str):
    """同目录原子替换，文件始终只允许本人读取。"""
    fd, name = tempfile.mkstemp(prefix=".sync-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def export_session(source: Path, archive: Path):
    raw = source.read_bytes()
    source_lines = raw.splitlines()
    parsed_lines = []
    truncated = []
    for number, line in enumerate(source_lines, 1):
        try:
            parsed_lines.append((number, json.loads(line)))
        except ValueError as error:
            if number == len(source_lines) and not raw.endswith(b"\n"):
                truncated.append(number)
            else:
                raise ExportError("invalid_source_line_preserved_existing_archive") from error
    metadata = next((entry.get("payload", {}) for _, entry in parsed_lines if entry.get("type") == "session_meta"), None)
    if not metadata or not re.fullmatch(r"[A-Za-z0-9-]+", metadata.get("id", "")):
        raise ExportError("missing_session_identity")
    workspace = archive.parent.resolve()
    cwd = Path(metadata.get("cwd", "/")).resolve()
    if cwd != workspace and workspace not in cwd.parents:
        raise ExportError("session_not_in_workspace")
    date = str(metadata.get("timestamp", ""))[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        date = source.name.removeprefix("rollout-")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ExportError("missing_session_date")
    records, messages = [], []
    excluded = collections.Counter()
    declared_credentials = []
    for _, entry in parsed_lines:
        payload = entry.get("payload", {})
        if entry.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") == "user":
            for part in payload.get("content", []):
                if part.get("type") == "input_text" and isinstance(part.get("text"), str):
                    declared_credentials.extend(DECLARED_CREDENTIAL.findall(part["text"]))
    redactor = Redactor(declared_credentials)
    for number, entry in parsed_lines:
        payload = entry.get("payload", {})
        kind = payload.get("type")
        if entry.get("type") != "response_item":
            excluded[entry.get("type", "unknown")] += 1
            continue
        if kind == "message" and payload.get("role") in ("user", "assistant"):
            if payload.get("channel") == "analysis" or payload.get("phase") not in (None, "commentary", "final", "final_answer"):
                excluded["non_visible_message"] += 1
                continue
            content = [{"type": part["type"], "text": redactor.clean(part["text"])} for part in payload.get("content", []) if part.get("type") in ("input_text", "output_text") and isinstance(part.get("text"), str)]
            if not content:
                excluded["non_text_message"] += 1
                continue
            record = {"source_line": number, "timestamp": entry.get("timestamp"), "type": "message", "role": payload["role"], "phase": payload.get("phase"), "content": content}
            records.append(record)
            messages.append(record)
        elif kind in ("function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"):
            records.append({"source_line": number, "timestamp": entry.get("timestamp"), "type": "tool_record", "payload": redactor.clean({key: payload[key] for key in ("type", "name", "call_id", "input", "arguments", "output") if key in payload})})
        else:
            excluded["response_item:" + str(kind)] += 1
    folder = archive / f"{date}_{metadata['id']}"
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(archive, 0o700)
    os.chmod(folder, 0o700)
    dialogue = ["# 本次对话可读版", "", f"会话：`{metadata['id']}`。按原日志顺序保存可见消息。", "", "工具记录见collaboration.jsonl，过滤脱敏及截取时间见manifest。最终回复发送后才会落盘，下轮开始补齐，不声称实时后台同步。", ""]
    for index, message in enumerate(messages, 1):
        label = "用户" if message["role"] == "user" else "助手"
        dialogue.extend([f"## {index:03d} · {label}", "", f"时间：{message.get('timestamp') or '未记录'}；原日志行：{message['source_line']}。", "", "\n".join(part["text"] for part in message["content"]), "", "---", ""])
    outputs = {"collaboration.jsonl": "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), "dialogue.md": "\n".join(dialogue)}
    manifest = {
        "thread_id": metadata["id"], "source_path": str(source), "exported_at": datetime.now(timezone.utc).isoformat(),
        "source_snapshot_sha256": hashlib.sha256(raw).hexdigest(), "source_snapshot_bytes": len(raw), "source_snapshot_lines": len(source_lines),
        "last_exported_source_line": records[-1]["source_line"] if records else None,
        "exported_message_count": len(messages), "exported_tool_record_count": sum(record["type"] == "tool_record" for record in records),
        "excluded_record_categories": dict(excluded), "truncated_trailing_lines": truncated, "invalid_source_lines": [],
        "credential_redaction_counts": {key: count for key, count in redactor.counts.items() if count},
        "artifacts": {name: hashlib.sha256(content.encode()).hexdigest() for name, content in outputs.items()},
        "limitations": ["仅导出可见文字与工具记录，排除内部上下文、系统/开发者消息和推理记录。", "凭据按字段和模式脱敏，外发前仍须人工复查未识别秘密和个人信息。", "仅截至当前快照，源日志末尾尚未写完整的一行在下一轮补齐。", "最终回复发送后才能进入源日志，下轮开始补齐；未配置后台实时监听。"],
    }
    for name, content in outputs.items():
        atomic_write(folder / name, content)
    atomic_write(folder / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    index = archive / "README.md"
    if index.exists():
        body = index.read_text()
        block = "\n".join([
            "<!-- current-session:start -->",
            f"- [可读对话]({folder.name}/dialogue.md)：用户与助手文字，按原日志排序。",
            f"- [协作记录 JSONL]({folder.name}/collaboration.jsonl)：消息与工具调用及结果。",
            f"- [来源及范围]({folder.name}/manifest.json)：截取时间、计数、摘要、过滤及脱敏范围。",
            "<!-- current-session:end -->",
        ])
        updated = re.sub(r"<!-- current-session:start -->.*?<!-- current-session:end -->", lambda _: block, body, flags=re.S)
        if updated != body:
            atomic_write(index, updated)
    return manifest


def current_source(archive: Path):
    thread = os.environ.get("CODEX_THREAD_ID")
    if thread:
        matches = list((Path.home() / ".codex/sessions").rglob(f"*{thread}*.jsonl"))
        if len(matches) != 1:
            raise ExportError("current_thread_source_not_unique")
        return matches[0]
    manifests = list(archive.glob("*/manifest.json"))
    if len(manifests) != 1:
        raise ExportError("thread_identity_required")
    return Path(json.loads(manifests[0].read_text())["source_path"])


if __name__ == "__main__":
    try:
        archive = Path(__file__).resolve().parent
        manifest = export_session(current_source(archive), archive)
        print(json.dumps({"status": "synced", "messages": manifest["exported_message_count"], "tool_records": manifest["exported_tool_record_count"], "truncated_tail": manifest["truncated_trailing_lines"]}, ensure_ascii=False))
    except (ExportError, OSError, ValueError):
        raise SystemExit("对话同步失败；请检查日志来源、权限或损坏行，不宣称同步成功。")
