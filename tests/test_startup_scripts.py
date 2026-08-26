import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]


class BatchLauncherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.launcher = (PROJECT_DIR / "start_jarvis.bat").read_text(
            encoding="utf-8"
        )

    def test_launcher_derives_repository_directory_from_its_own_path(self) -> None:
        self.assertIn('cd /d "%~dp0"', self.launcher)
        self.assertNotIn(str(PROJECT_DIR), self.launcher)

    def test_launcher_uses_project_virtual_environment_and_visible_python(self) -> None:
        self.assertIn('".venv\\Scripts\\python.exe" jarvis.py', self.launcher)
        self.assertNotIn("pythonw.exe", self.launcher.casefold())

    def test_launcher_has_useful_missing_file_errors(self) -> None:
        self.assertIn('if not exist ".venv\\Scripts\\python.exe"', self.launcher)
        self.assertIn('if not exist "jarvis.py"', self.launcher)
        self.assertIn("ERROR:", self.launcher)


class StartupRegistrationScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.installer = (PROJECT_DIR / "scripts" / "install_startup.ps1").read_text(
            encoding="utf-8"
        )
        self.uninstaller = (
            PROJECT_DIR / "scripts" / "uninstall_startup.ps1"
        ).read_text(encoding="utf-8")

    def test_installer_targets_current_user_startup_folder(self) -> None:
        self.assertIn("[Environment+SpecialFolder]::Startup", self.installer)
        self.assertIn('"Jarvis.lnk"', self.installer)
        self.assertIn('"start_jarvis.bat"', self.installer)

    def test_installer_uses_dynamic_repository_path_without_admin_mechanisms(self) -> None:
        lowered = self.installer.casefold()
        self.assertIn("split-path -parent $psscriptroot", lowered)
        self.assertNotIn("hklm", lowered)
        self.assertNotIn("scheduledtask", lowered)
        self.assertNotIn("runas", lowered)

    def test_uninstaller_removes_only_the_jarvis_shortcut(self) -> None:
        lowered = self.uninstaller.casefold()
        self.assertIn('"jarvis.lnk"', lowered)
        self.assertIn("remove-item -literalpath $shortcutpath", lowered)
        self.assertNotIn("remove-item -recurse", lowered)
        self.assertNotIn("*", self.uninstaller)

    def test_startup_scripts_contain_no_secret_configuration_names(self) -> None:
        combined = f"{self.installer}\n{self.uninstaller}"
        self.assertNotIn("ELEVENLABS_API_KEY", combined)
        self.assertNotIn("ELEVENLABS_VOICE_ID", combined)


if __name__ == "__main__":
    unittest.main()
