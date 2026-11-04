"""Offline protocol/error regressions for the live browser helper."""
import base64
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

loader = importlib.machinery.SourceFileLoader("page_browser", str(Path(__file__).with_name("rakazo-page-browser")))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


def ref(name="node"):
    value = json.dumps(["tab", "frame", "loader", name.ljust(32, "x")])
    return "r2." + base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def page(exact=None):
    browser = Mock(deadline=helper.time.monotonic() + 22)
    browser.batch.return_value = [{"snapshot": "Readable page [ref=e1]"}]
    result = helper.PageBrowser(9222, "tab", browser)
    result._exact = exact or Mock()
    if exact is None:
        result._exact.assert_mutations_allowed = Mock()
    result._exact.snapshot.return_value = {
        "url": "https://login.example.test", "title": "Page", "text": "Readable page",
        "elements": [], "masked": [],
    }
    result._exact.invoke.return_value = {"role": "button", "name": "Save"}
    result.settle = Mock(return_value=True)
    return result


class PageBrowserTest(unittest.TestCase):
    def test_settle_reads_the_live_page_load_telemetry(self):
        browser = Mock(deadline=helper.time.monotonic() + 22)
        browser.batch.side_effect = [
            [{"result": {"href": "https://example.test/", "ready": "complete", "done": []}},
             {"requests": []}],
            [{}],
        ]
        target = helper.PageBrowser(9222, "tab", browser)
        self.assertTrue(target.settle(0))
        commands = browser.batch.call_args_list[0].args[0]
        self.assertEqual(commands[0][0], "eval")
        self.assertIn("document.readyState", commands[0][1])
        self.assertIn('performance.getEntriesByType("resource")', commands[0][1])
        self.assertEqual(commands[1], ["network", "requests"])
        self.assertEqual(browser.batch.call_args_list[1].args[0], [["network", "requests", "--clear"]])

    def test_closed_stdin_cancels_helper_without_a_browser(self):
        with subprocess.Popen([sys.executable, str(Path(__file__).with_name("rakazo-page-browser")), "snapshot", "{}"],
                              env={**os.environ, "RAKAZO_BROWSER_WATCH_STDIN": "1", "RAKAZO_CDP_PORT": "0"},
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            process.stdin.close()
            self.assertEqual(process.wait(timeout=3), 130)

    def test_stdin_eof_terminates_the_active_cli_subprocess_without_stopping_the_fixture_service(self):
        self._assert_eof_cancels_owned_cli("navigate")

    def test_stdin_eof_terminates_an_active_capability_version_cli(self):
        self._assert_eof_cancels_owned_cli("capabilities")

    def _assert_eof_cancels_owned_cli(self, command):
        import http.server
        import threading
        import time

        class Discovery(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                value = ({"Browser": "Owned fixture"} if self.path == "/json/version" else
                         [{"type": "page", "id": "fixture-tab", "url": "chrome://newtab/"}])
                body = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Discovery)
        server.daemon_threads = True
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        process = None
        try:
            with tempfile.TemporaryDirectory() as directory:
                cli = Path(directory, "owned_fake_cli.py")
                cli.write_text("#!" + sys.executable + "\n" + r"""
import json, os, signal, sys, time
from pathlib import Path
base = Path(__file__)
def terminated(signum, frame):
    base.with_suffix('.terminated').write_text(json.dumps({'pid': os.getpid(), 'signal': signum}))
    raise SystemExit(143)
signal.signal(signal.SIGTERM, terminated)
signal.alarm(10)
commands = [["--version"]] if "--version" in sys.argv else json.loads(sys.stdin.read())
ready = base.with_suffix('.ready.tmp')
ready.write_text(json.dumps({'pid': os.getpid(), 'parent': os.getppid(), 'commands': commands}))
ready.replace(base.with_suffix('.ready'))
while base.exists():
    time.sleep(0.02)
""")
                cli.chmod(0o700)
                environment = {"PATH": "/usr/bin:/bin", "HOME": directory, "TMPDIR": directory,
                               "RAKAZO_AGENT_BROWSER": str(cli), "RAKAZO_CDP_PORT": str(server.server_port),
                               "RAKAZO_BROWSER_WATCH_STDIN": "1", "PYTHONDONTWRITEBYTECODE": "1"}
                process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("rakazo-page-browser")),
                                            command, '{"url":"https://fixture.invalid/not-dispatched"}'],
                                           env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE)
                ready = cli.with_suffix(".ready")
                until = time.monotonic() + 4
                while not ready.exists() and process.poll() is None and time.monotonic() < until:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "The shipped wrapper never started its active CLI")
                started = json.loads(ready.read_text())
                self.assertEqual(started["parent"], process.pid)
                self.assertEqual(started["commands"], [["--version"]] if command == "capabilities" else [["tab", "new", "about:blank"]])
                self.assertIsNone(process.poll())
                process.stdin.close()
                process.stdin = None
                stdout, stderr = process.communicate(timeout=4)
                self.assertEqual(process.returncode, 130, stderr.decode(errors="replace"))
                stopped = cli.with_suffix(".terminated")
                until = time.monotonic() + 2
                while not stopped.exists() and time.monotonic() < until:
                    time.sleep(0.01)
                self.assertTrue(stopped.exists(), "EOF left the active owned CLI running")
                terminated = json.loads(stopped.read_text())
                self.assertEqual(terminated["pid"], started["pid"])
                self.assertEqual(terminated["signal"], 15)
                until = time.monotonic() + 2
                while True:
                    status = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(started["pid"])],
                                            capture_output=True, text=True, timeout=1).stdout.strip()
                    if not status or status.startswith("Z") or time.monotonic() >= until:
                        break
                    time.sleep(0.01)
                self.assertTrue(not status or status.startswith("Z"), "The terminated owned CLI is still executing")
                self.assertEqual(stdout, b"")
                # This is a controlled discovery service, not a real Chromium process.
                self.assertTrue(worker.is_alive())
                self.assertEqual(helper.http_get_json(f"http://127.0.0.1:{server.server_port}/json/version"),
                                 {"Browser": "Owned fixture"})
        finally:
            if process is not None and process.poll() is None:
                if process.stdin is not None:
                    process.stdin.close()
                    process.stdin = None
                try:
                    process.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=2)
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_rejects_url_credentials_before_navigation(self):
        target = page()
        for url in ("http://example:fake-password@example.test", "https://example:fake-password@example.test"):
            result = target.navigate(url)
            self.assertFalse(result["ok"])
            self.assertFalse(result["uncertain"])
            self.assertIn("credentials", result["error"])
        target._exact.client.call.assert_not_called()

    def test_rejects_navigation_error(self):
        target = page()
        target._exact.client.call.return_value = {"errorText": "net::ERR_NAME_NOT_RESOLVED"}
        result = target.navigate("https://example.test")
        self.assertFalse(result["ok"])
        self.assertIn("ERR_NAME_NOT_RESOLVED", result["error"])
        self.assertFalse(result["uncertain"])
        self.assertEqual(target._exact.client.call.call_count, 1)

    def test_preserves_completed_actions_when_next_response_is_lost(self):
        target = page()
        target._exact.act.side_effect = [True, TimeoutError("lost response")]
        with patch.object(helper.page_secrets, "follow_navigation", return_value=False):
            result = target.act([{"kind": "click", "ref": ref("first")}, {"kind": "click", "ref": ref("second")}])
        self.assertEqual(result["completed"], 1)
        self.assertTrue(result["uncertain"])
        self.assertFalse(result["ok"])
        self.assertEqual(target._exact.act.call_count, 2)
        self.assertEqual(result["fallback"], "computer_act")

    def test_rejects_missing_text_before_any_action(self):
        target = page()
        with self.assertRaisesRegex(RuntimeError, "Text"):
            target.act([{"kind": "click", "ref": ref()}, {"kind": "fill", "ref": ref("second")}])
        target._exact.invoke.assert_not_called()
        target._exact.act.assert_not_called()

    def test_binds_saved_login_fill_to_its_origin_in_the_same_exact_call(self):
        target = page()
        step = {"kind": "fill", "ref": ref(), "text": 'fake-password"\\\n',
                "origin": "https://login.example.test", "field": "password"}
        with patch.object(helper.page_secrets, "follow_navigation", return_value=False), patch.object(helper.time, "sleep"):
            result = target.act([step])
        self.assertTrue(result["ok"])
        target._exact.login.assert_called_once_with(step)
        target._exact.act.assert_not_called()
        self.assertNotIn(step["text"], json.dumps(target.ab.batch.call_args_list, default=str))
        self.assertNotIn(step["text"], json.dumps(result))

    def test_rejects_origin_outside_fill_before_any_action(self):
        target = page()
        with self.assertRaisesRegex(RuntimeError, "origin"):
            target.act([{"kind": "type", "ref": ref(), "text": "x", "origin": "https://login.example.test"}])
        target._exact.invoke.assert_not_called()

    def test_reads_arguments_from_one_stdin_line_only(self):
        payload = b'{"actions": []}\nrest'
        with patch.object(helper.os, "read", side_effect=[payload[i:i + 1] for i in range(len(payload))]) as read:
            self.assertEqual(helper.read_stdin_line(), '{"actions": []}')
        self.assertEqual(read.call_count, len(b'{"actions": []}\n'))

    def test_refused_stale_or_covered_step_is_settled_without_desktop_replay(self):
        for message in ("Stale ref", "The element is covered", "No unique enabled option"):
            target = page()
            target._exact.act.side_effect = helper.page_secrets.Refused(message)
            result = target.act([{"kind": "click", "ref": ref()}])
            self.assertEqual((result["ok"], result["completed"], result["uncertain"]), (False, 0, False))
            self.assertNotIn("fallback", result)
            self.assertEqual(target._exact.act.call_count, 1)

    def test_expired_deadline_dispatches_no_mutation(self):
        target = page()
        target.deadline = helper.time.monotonic() - 1
        result = target.act([{"kind": "click", "ref": ref()}])
        self.assertEqual(result["completed"], 0)
        self.assertFalse(result["uncertain"])
        target._exact.act.assert_not_called()

    def test_second_step_does_not_run_after_navigation_replaces_its_node(self):
        target = page()
        target._exact.invoke.side_effect = [{"role": "button"}, helper.page_secrets.Refused("Stale")]
        with patch.object(helper.page_secrets, "follow_navigation", return_value=False):
            result = target.act([{"kind": "click", "ref": ref()}, {"kind": "click", "ref": ref("next")}])
        self.assertEqual((result["completed"], result["uncertain"]), (1, False))
        self.assertEqual(target._exact.act.call_count, 1)
        self.assertNotIn("fallback", result)

    def test_model_view_budget_counts_utf16_quotes_and_escaped_newlines(self):
        target = page()
        target.ab.batch.return_value = [{"snapshot": ('🙂"line\n' * 10000)}]
        target._exact.snapshot.return_value["elements"] = [
            {"ref": ref(str(index)), "role": "button", "name": '🙂"\n' * 70} for index in range(100)
        ]
        result = target.snapshot()
        encoded = json.dumps({key: value for key, value in result.items() if key != "elements"}, ensure_ascii=False, separators=(",", ":")).encode("utf-16-le")
        self.assertLessEqual(len(encoded) // 2 - 2, 12000)
        self.assertIn("showing", result["tree"])
        self.assertTrue(result["elements"])

    def test_structured_native_options_fit_the_transport_budget_and_keep_the_selected_option(self):
        target = page()
        options = [{"label": f"Choice {index} " + "🙂" * 2000, "value": str(index) + "🙂" * 2000,
                    "optionToken": "or2." + f"{index:032x}", "labelTruncated": True, "valueTruncated": True}
                   for index in range(100)]
        selected_token = "or2." + "f" * 32
        selected = {"label": "Chosen", "value": "selected-" + "🙂" * 2000, "selected": True,
                    "optionToken": selected_token, "valueTruncated": True}
        target._exact.snapshot.return_value["elements"] = [
            {"ref": ref(), "role": "combobox", "name": "Country", "options": [*options, selected], "optionsTotal": 200}
        ]
        result = target.snapshot()
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False).encode("utf-8")), 512 * 1024)
        self.assertEqual(len(result["elements"]), 1)
        dropdown = result["elements"][0]
        self.assertEqual(dropdown["optionsTotal"], 200)
        self.assertIn({"label": "Chosen", "value": selected_token, "selected": True, "valueRef": True}, dropdown["options"])
        self.assertIn("[value=" + selected_token + "]", result["tree"])
        helper.validate_actions([{"kind": "fill", "ref": dropdown["ref"], "text": selected_token}])
        self.assertTrue(dropdown["options"])

    def test_short_secret_preserves_only_verified_protocol_refs_through_model_roundtrip(self):
        target = page()
        element_ref = ref("j" * 32)
        self.assertIn("a", element_ref)
        target._exact.snapshot.return_value.update({"masked": ["a"], "elements": [
            {"ref": element_ref, "role": "button", "tag": "button", "name": "Save a", "value": "a"}]})
        target.ab.batch.return_value = [{"snapshot": "Page content copying " + element_ref}]
        result = target.snapshot()
        self.assertEqual(result["elements"][0]["ref"], element_ref)
        self.assertEqual(result["elements"][0]["role"], "button")
        self.assertEqual(result["elements"][0]["tag"], "button")
        self.assertEqual(result["tree"].count(element_ref), 1)
        self.assertNotIn("Save a", result["tree"])
        actions = [{"kind": "click", "ref": result["elements"][0]["ref"]}]
        helper.validate_actions(actions)
        with patch.object(helper.page_secrets, "follow_navigation", return_value=False), patch.object(helper.time, "sleep"):
            acted = target.act(actions)
        self.assertTrue(acted["ok"])
        target._exact.act.assert_called_once_with(element_ref, "click")

    def test_short_secret_option_token_stays_identical_in_tree_details_and_action(self):
        target = page()
        token = "or2." + "a" * 32
        element_ref = ref("j" * 32)
        target._exact.snapshot.return_value.update({"masked": ["a"], "elements": [
            {"ref": element_ref, "role": "combobox", "tag": "select", "name": "Canada", "options": [
                {"label": "Canada", "value": "ca", "optionToken": token, "selected": True}]}]})
        result = target.snapshot()
        chosen = result["elements"][0]["options"][0]
        self.assertEqual(chosen["value"], token)
        self.assertTrue(chosen["valueRef"])
        self.assertNotIn("optionToken", chosen)
        self.assertIn("[value=" + token + "]", result["tree"])
        self.assertNotIn("Canada", result["tree"])
        actions = [{"kind": "fill", "ref": result["elements"][0]["ref"], "text": chosen["value"]}]
        helper.validate_actions(actions)
        with patch.object(helper.page_secrets, "follow_navigation", return_value=False), patch.object(helper.time, "sleep"):
            acted = target.act(actions)
        self.assertTrue(acted["ok"])
        target._exact.act.assert_called_once_with(element_ref, "fill", token)

    def test_final_render_and_details_remain_consistent_for_short_i_and_a_secrets(self):
        for secret in ("i", "a"):
            with self.subTest(secret=secret):
                target = page()
                element_ref = ref("j" * 32)
                target._exact.snapshot.return_value.update({"masked": [secret], "elements": [
                    {"ref": element_ref, "role": "button", "tag": "button", "name": "Sign in and Save"}]})
                final = target.redact(target.snapshot())
                control = final["elements"][0]
                prefix = f"- {control['role']} {json.dumps(control['name'], ensure_ascii=False)} [{control['ref']}]"
                self.assertIn(prefix, final["tree"])
                self.assertEqual(control["ref"], element_ref)
                actions = [{"kind": "click", "ref": control["ref"]}]
                helper.validate_actions(actions)
                self.assertEqual(target.redact(final), final)
                with patch.object(helper.page_secrets, "follow_navigation", return_value=False), patch.object(helper.time, "sleep"):
                    acted = target.act(actions)
                self.assertTrue(acted["ok"])
                target._exact.act.assert_called_once_with(element_ref, "click")

    def test_short_a_does_not_corrupt_the_closed_computer_act_fallback_protocol(self):
        target = page()
        target.masked.add("a")
        final = target.redact({"ok": False, "fallback": "computer_act", "error": "a synthetic error"})
        self.assertEqual(final["fallback"], "computer_act")
        self.assertNotEqual(final["error"], "a synthetic error")

    def test_dense_raw_select_budget_actually_trims_rows_with_two_full_serializations(self):
        target = page()
        target._exact.snapshot.return_value["elements"] = [
            {"ref": ref(str(group)), "role": "combobox", "tag": "select", "name": f"List {group}", "optionsTotal": 100,
             "options": [{"label": f"Choice {index}", "value": str(index) + "文" * 1990,
                           **({"selected": True} if index == 99 else {})} for index in range(100)]}
            for group in range(10)]
        original = helper.json.dumps
        whole = []
        def counted(value, *args, **kwargs):
            if isinstance(value, dict) and "elements" in value and "tree" in value:
                whole.append(1)
            return original(value, *args, **kwargs)
        with patch.object(helper.json, "dumps", side_effect=counted):
            result = target.snapshot()
        self.assertLessEqual(len(whole), 2)
        self.assertTrue(any(element.get("optionsTruncated") for element in result["elements"]))
        self.assertLessEqual(len(original(result).encode()), 512 * 1024)
        for element in result["elements"]:
            self.assertEqual(element["optionsTotal"], 100)
            self.assertIn({"label": "Choice 99", "value": "99" + "文" * 1990, "selected": True}, element["options"])

    def test_structural_budget_keeps_a_published_unselected_value_reference(self):
        target = page()
        token = "or2." + "b" * 32
        options = [{"label": f"Choice {index}", "value": str(index) + "文" * 1990,
                    **({"selected": True} if index == 99 else {})} for index in range(100)]
        options[98] = {"label": "L" * 100, "value": "literal", "optionToken": token}
        target._exact.snapshot.return_value["elements"] = [{"ref": ref(), "role": "combobox", "tag": "select",
            "name": "Dense", "options": options, "optionsTotal": 100}]
        result = target.snapshot()
        control = result["elements"][0]
        self.assertTrue(control["optionsTruncated"])
        published = [option for option in control["options"] if option["value"] == token]
        self.assertEqual(len(published), 1)
        self.assertTrue(published[0]["valueRef"])
        self.assertIn("[value=" + token + "]", result["tree"])
        self.assertIn(options[99], control["options"])
        self.assertLessEqual(len(json.dumps(result).encode()), 512 * 1024)

    def test_dense_select_budget_serializes_the_whole_result_only_twice_and_keeps_selected_refs(self):
        import hashlib
        target = page()
        elements = []
        for group in range(10):
            options = []
            for index in range(100):
                token = "or2." + hashlib.sha256(f"{group}:{index}".encode()).hexdigest()[:32]
                options.append({"label": "🙂" * 2000, "value": "🙂" * 2000,
                                "optionToken": token, **({"selected": True} if index == 99 else {})})
            elements.append({"ref": ref(str(group)), "role": "combobox", "tag": "select", "name": f"List {group}",
                             "options": options, "optionsTotal": 100})
        target._exact.snapshot.return_value["elements"] = elements
        original = helper.json.dumps
        whole = []
        def counted(value, *args, **kwargs):
            if isinstance(value, dict) and "elements" in value and "tree" in value:
                whole.append(1)
            return original(value, *args, **kwargs)
        with patch.object(helper.json, "dumps", side_effect=counted):
            result = target.snapshot()
        self.assertLessEqual(len(whole), 2)
        self.assertLessEqual(len(original(result).encode()), 512 * 1024)
        self.assertTrue(result["elements"])
        for element in result["elements"]:
            chosen = [option for option in element["options"] if option.get("selected")]
            self.assertEqual(len(chosen), 1)
            self.assertTrue(chosen[0]["valueRef"])
            self.assertIn("[value=" + chosen[0]["value"] + "]", result["tree"])
            self.assertTrue(all(option.get("valueRef") for option in element["options"]))

    def test_engine_refs_are_not_advertised_as_callable_controls(self):
        target = page()
        target.ab.batch.return_value = [{"snapshot": '- button "Semantic" [ref=e8]\nReadable article'}]
        result = target.snapshot()
        self.assertNotIn("ref=e8", result["tree"])
        self.assertEqual(result["elements"], [])
        self.assertIn("Readable article", result["tree"])

    def test_short_and_quoted_reflected_secrets_are_hidden_in_every_public_field(self):
        target = page()
        value = 'a"\\\n🙂'
        target._exact.snapshot.return_value.update({"masked": [value, "a"], "title": value, "text": value,
            "elements": [{"ref": ref(), "role": "textbox", "name": value, "value": value}]})
        target.ab.batch.return_value = [{"snapshot": json.dumps(value, ensure_ascii=False)}]
        result = target.snapshot()
        self.assertNotIn(value, json.dumps(result, ensure_ascii=False))
        self.assertNotIn(json.dumps(value, ensure_ascii=False)[1:-1], result["tree"])

    def test_internal_tab_opens_blank_then_dispatches_the_requested_url_once(self):
        import contextlib
        import io
        browser = Mock()
        target = Mock()
        target.navigate.return_value = {"ok": True, "navigationOutcomeKnown": True, "uncertain": False}
        output = io.StringIO()
        with patch.object(helper, "AgentBrowser", return_value=browser), \
                patch.object(helper, "wait_for_cdp"), \
                patch.object(helper, "front_tab", side_effect=[("old", "chrome://newtab/"), ("new", "about:blank")]), \
                patch.object(helper, "PageBrowser", return_value=target), \
                patch.dict(os.environ, {"RAKAZO_BROWSER_ARGS_STDIN": "0", "RAKAZO_BROWSER_WATCH_STDIN": "0"}), \
                contextlib.redirect_stdout(output):
            self.assertEqual(helper.run(["page-browser", "navigate", '{"url":"https://example.test/once"}']), 0)
        self.assertEqual(browser.batch.call_args_list[0].args[0], [["tab", "new", "about:blank"]])
        target.navigate.assert_called_once_with("https://example.test/once")
        browser.use_tab.assert_called_once_with("new")
        self.assertTrue(json.loads(output.getvalue())["ok"])

    def run_result(self, command, args, *, address="https://example.test", target=None):
        import contextlib
        import io
        browser = Mock()
        target = target or page()
        output = io.StringIO()
        with patch.object(helper, "AgentBrowser", return_value=browser), \
                patch.object(helper, "wait_for_cdp"), \
                patch.object(helper, "front_tab", return_value=("tab", address)), \
                patch.object(helper, "PageBrowser", return_value=target) as create_page, \
                patch.dict(os.environ, {"RAKAZO_BROWSER_ARGS_STDIN": "0", "RAKAZO_BROWSER_WATCH_STDIN": "0"}), \
                contextlib.redirect_stdout(output):
            self.assertEqual(helper.run(["page-browser", command, json.dumps(args)]), 0)
        return json.loads(output.getvalue()), browser, create_page

    def test_run_reports_validation_before_dispatch_as_settled_without_fallback(self):
        target = page()
        result, browser, _ = self.run_result("act", {"actions": [{"kind": "fill", "ref": ref()}]}, target=target)
        self.assertFalse(result["ok"])
        self.assertIn("Text", result["error"])
        self.assertEqual((result.get("completed"), result["uncertain"]), (0, False))
        self.assertNotIn("fallback", result)
        target._exact.act.assert_not_called()
        target._exact.invoke.assert_not_called()
        browser.batch.assert_not_called()

    def test_run_reports_internal_page_refusal_before_dispatch_as_settled_without_fallback(self):
        result, browser, create_page = self.run_result("act", {"actions": [{"kind": "click", "ref": ref()}]},
                                                      address="chrome://settings/")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], helper.INTERNAL_PAGE)
        self.assertEqual((result.get("completed"), result["uncertain"]), (0, False))
        self.assertNotIn("fallback", result)
        create_page.assert_not_called()
        browser.batch.assert_not_called()

    def test_run_preserves_uncertainty_for_an_unclassified_dispatch_failure(self):
        target = page()
        target.act = Mock(side_effect=RuntimeError("The action response was lost"))
        result, _, _ = self.run_result("act", {"actions": [{"kind": "click", "ref": ref()}]}, target=target)
        self.assertFalse(result["ok"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(result["fallback"], "computer_act")
        target.act.assert_called_once()

    def test_engine_commands_use_stdin_and_a_private_environment(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(helper.tempfile, "gettempdir", return_value=directory), \
                patch.dict(os.environ, {"UNRELATED_CREDENTIAL": "must-not-cross", "HTTP_PROXY": "must-not-cross"}):
            browser = helper.AgentBrowser(9222)
            process = Mock()
            process.communicate.return_value = ('[{"success":true,"result":{}}]', "")
            with patch.object(helper.subprocess, "Popen", return_value=process) as popen:
                browser.batch([["keyboard", "type", "ordinary-text"]])
            argv = popen.call_args.args[0]
            self.assertNotIn("ordinary-text", " ".join(argv))
            self.assertIn("--omit-command", argv)
            self.assertEqual(json.loads(process.communicate.call_args.args[0]), [["keyboard", "type", "ordinary-text"]])
            environment = popen.call_args.kwargs["env"]
            self.assertNotIn("UNRELATED_CREDENTIAL", environment)
            self.assertNotIn("HTTP_PROXY", environment)
            self.assertEqual(environment["AGENT_BROWSER_CDP"], "9222")
            self.assertEqual(environment["AGENT_BROWSER_NO_AUTO_DIALOG"], "1")
            self.assertTrue(Path(environment["HOME"]).is_relative_to(directory))

    def test_uploads_only_real_files_inside_explicit_trusted_roots(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory) / "allowed"
            root.mkdir()
            wanted = root / "report.txt"
            wanted.write_text("synthetic")
            foreign = Path(outside) / "secret.txt"
            foreign.write_text("synthetic")
            (root / "escape.txt").symlink_to(foreign)
            self.assertEqual(helper.resolve_upload_paths([str(wanted)], home=directory, roots=["allowed"]), [str(wanted.resolve())])
            for denied in (str(foreign), str(root / "escape.txt"), str(root), str(root / "absent")):
                with self.subTest(path=denied), self.assertRaises(RuntimeError):
                    helper.resolve_upload_paths([denied], home=directory, roots=["allowed"])


if __name__ == "__main__":
    unittest.main()
