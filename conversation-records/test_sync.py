"""对话归档的过滤、脱敏、幂等及损坏恢复测试；全用虚构记录。"""
import json
from pathlib import Path
import stat
import tempfile
import unittest

import sync


class ConversationExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary.name)
        self.archive = self.workspace / "conversation-records"
        self.source = self.workspace / "rollout-2026-10-30-test.jsonl"
        self.metadata = {"type": "session_meta", "payload": {"id": "test-session", "cwd": str(self.workspace), "timestamp": "2026-10-30T01:00:00Z"}}

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, entries):
        self.source.write_text("\n".join(json.dumps(entry) for entry in [self.metadata, *entries]) + "\n")

    def message(self, role, text, **extra):
        return {"type": "response_item", "timestamp": "2026-10-30T01:00:00Z", "payload": {"type": "message", "role": role, "content": [{"type": "output_text" if role == "assistant" else "input_text", "text": text}], **extra}}

    def output(self, name):
        return (self.archive / "2026-10-30_test-session" / name).read_text()

    def test_visible_order_tools_and_exclusion(self):
        self.write([self.message("user", "hello"), self.message("developer", "private-directive"), {"type": "response_item", "payload": {"type": "reasoning", "text": "private-reasoning"}}, self.message("assistant", "private-analysis", channel="analysis"), {"type": "response_item", "payload": {"type": "function_call", "name": "fixture_tool", "call_id": "call-fixture", "arguments": '{"count":1}'}}, self.message("assistant", "visible-answer", phase="final_answer")])
        manifest = sync.export_session(self.source, self.archive)
        contents = self.output("collaboration.jsonl")
        self.assertEqual(manifest["exported_message_count"], 2)
        self.assertEqual(manifest["exported_tool_record_count"], 1)
        self.assertNotIn("private-directive", contents)
        self.assertNotIn("private-reasoning", contents)
        self.assertNotIn("private-analysis", contents)
        records = [json.loads(line) for line in contents.splitlines()]
        self.assertEqual([entry["type"] for entry in records], ["message", "tool_record", "message"])
        self.assertEqual(records[-1]["source_line"], 7)

    def test_credentials_redacted_in_nested_json_headers_and_assignments(self):
        fake_key = "sk-" + "A" * 32
        payload = {"headers": {"Cookie": "fictional-cookie-secret", "Authorization": "Bearer " + "B" * 32}, "MODEL_API_KEY": fake_key, "password": "fictional-password"}
        self.write([self.message("user", json.dumps(payload)), self.message("assistant", 'SOURCE_COOKIE="another-cookie-secret"\nCookie: separate-cookie-secret\nnext-auth.session-token=session-secret')])
        sync.export_session(self.source, self.archive)
        text = self.output("collaboration.jsonl")
        for secret in [fake_key, "fictional-cookie-secret", "fictional-password", "another-cookie-secret", "separate-cookie-secret", "session-secret", "B" * 32]:
            self.assertNotIn(secret, text)
        self.assertIn("REDACTED", text)

    def test_partial_tail_deferred_and_completed_on_next_sync(self):
        self.write([self.message("user", "first")])
        with self.source.open("a") as handle:
            handle.write('{"type":')
        manifest = sync.export_session(self.source, self.archive)
        self.assertEqual(manifest["truncated_trailing_lines"], [3])
        self.assertEqual(manifest["exported_message_count"], 1)
        self.write([self.message("user", "first"), self.message("assistant", "later-final")])
        manifest = sync.export_session(self.source, self.archive)
        self.assertEqual(manifest["exported_message_count"], 2)
        self.assertIn("later-final", self.output("dialogue.md"))

    def test_declared_private_key_passphrase_and_terminal_input_are_redacted(self):
        declared = "ｆｉｃｔｉｏｎａｌｐａｓｓ"
        repeated = "fictionalpass"
        self.write([
            self.message("user", "密钥密码" + declared),
            self.message("user", repeated),
            {"type": "response_item", "payload": {"type": "custom_tool_call", "name": "functions.exec", "input": 'await tools.write_stdin({session_id: 1, chars: "' + repeated + '\\n"})'}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "write_stdin", "arguments": json.dumps({"session_id": 1, "chars": repeated + "\n"})}},
        ])
        original = self.source.read_bytes()
        sync.export_session(self.source, self.archive)
        for name in ["dialogue.md", "collaboration.jsonl"]:
            exported = self.output(name)
            self.assertNotIn(declared, exported)
            self.assertNotIn(repeated, exported)
        self.assertEqual(self.source.read_bytes(), original)

    def test_corrupt_middle_preserves_prior_export(self):
        self.write([self.message("user", "original")])
        sync.export_session(self.source, self.archive)
        original = self.output("collaboration.jsonl")
        with self.source.open("a") as handle:
            handle.write("invalid-json\n{}\n")
        with self.assertRaises(sync.ExportError):
            sync.export_session(self.source, self.archive)
        self.assertEqual(self.output("collaboration.jsonl"), original)

    def test_repeat_does_not_duplicate_and_files_are_private(self):
        self.write([self.message("user", "repeat")])
        first = sync.export_session(self.source, self.archive)
        second = sync.export_session(self.source, self.archive)
        self.assertEqual(first["artifacts"], second["artifacts"])
        self.assertEqual(second["exported_message_count"], 1)
        self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode), 0o700)
        for path in self.archive.rglob("*"):
            if path.is_file():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_other_workspace_not_exported(self):
        self.metadata["payload"]["cwd"] = "/different-workspace"
        self.write([self.message("user", "not-this-workspace")])
        with self.assertRaises(sync.ExportError):
            sync.export_session(self.source, self.archive)


if __name__ == "__main__":
    unittest.main()
