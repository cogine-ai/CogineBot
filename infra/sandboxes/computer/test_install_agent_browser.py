import os
import pathlib
import subprocess
import tempfile
import unittest


INSTALLER = pathlib.Path(__file__).with_name("install-agent-browser.sh")


class InstallAgentBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="page-engine-install-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        self.destination = self.root / "destination"
        self.destination.mkdir()
        self.previous = self.destination / "agent-browser"
        self.previous.write_bytes(b"existing synthetic fixture; never executed\n")
        self.previous_bytes = self.previous.read_bytes()
        self.curl_marker = self.root / "curl-called"
        self.install_marker = self.root / "install-called"
        self.env = {
            "PATH": str(self.bin) + os.pathsep + os.defpath,
            "HOME": str(self.root),
            "TMPDIR": str(self.downloads),
            "LC_ALL": "C",
            "E06_TEST_ARCH": "x86_64",
            "E06_TEST_CURL_MARKER": str(self.curl_marker),
            "E06_TEST_INSTALL_MARKER": str(self.install_marker),
        }
        self.command("uname", 'printf "%s\\n" "$E06_TEST_ARCH"\n')
        self.command(
            "curl",
            'printf called > "$E06_TEST_CURL_MARKER"\n'
            'if [ "${E06_TEST_DOWNLOAD_FAILURE:-0}" = 1 ]; then exit 22; fi\n'
            'while [ "$#" -gt 0 ]; do\n'
            '  if [ "$1" = -o ]; then shift; printf "corrupt synthetic bytes\\n" > "$1"; exit 0; fi\n'
            '  shift\n'
            'done\nexit 1\n',
        )
        self.command("install", 'printf called > "$E06_TEST_INSTALL_MARKER"\nexit 88\n')
        # macOS lacks sha256sum; keep real checksum verification in these offline controls.
        if not any((pathlib.Path(p) / "sha256sum").is_file() for p in os.defpath.split(os.pathsep)):
            self.assertTrue(pathlib.Path("/usr/bin/shasum").is_file())
            self.command("sha256sum", 'exec /usr/bin/shasum -a 256 "$@"\n')

    def command(self, name, body):
        target = self.bin / name
        target.write_text("#!/bin/sh\n" + body)
        target.chmod(0o755)

    def reject(self, *args):
        result = subprocess.run(
            ["/bin/sh", str(INSTALLER), *args],
            env=self.env,
            capture_output=True,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.previous.read_bytes(), self.previous_bytes)
        self.assertFalse(self.install_marker.exists())
        self.assertEqual(list(self.downloads.iterdir()), [])
        return result

    def test_unsupported_architecture_stops_before_download(self):
        self.env["E06_TEST_ARCH"] = "mips"
        self.reject(str(self.destination))
        self.assertFalse(self.curl_marker.exists())

    def test_corrupt_x64_download_never_replaces_existing_binary(self):
        self.reject(str(self.destination))
        self.assertTrue(self.curl_marker.exists())

    def test_corrupt_arm64_download_never_replaces_existing_binary(self):
        self.env["E06_TEST_ARCH"] = "aarch64"
        self.reject(str(self.destination))
        self.assertTrue(self.curl_marker.exists())

    def test_download_failure_removes_temporary_file(self):
        self.env["E06_TEST_DOWNLOAD_FAILURE"] = "1"
        self.reject(str(self.destination))
        self.assertTrue(self.curl_marker.exists())

    def test_missing_destination_stops_before_download(self):
        self.reject()
        self.assertFalse(self.curl_marker.exists())


if __name__ == "__main__":
    unittest.main()
