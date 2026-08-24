"""Regression: Pre-submission Self-Check is fully removed from the public UI."""

import unittest
from pathlib import Path

import app as urge_app

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class PrecheckRemovedTests(unittest.TestCase):
    def setUp(self):
        self.client = urge_app.app.test_client()

    def test_home_omits_precheck_assets_and_button(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertNotIn('precheck/precheck.css', html)
        self.assertNotIn('precheck/rules.js', html)
        self.assertNotIn('precheck/checker.js', html)
        self.assertNotIn('precheck/report.js', html)
        self.assertNotIn('urgePrecheckBtn', html)
        self.assertNotIn('Pre-submission Self-Check', html)
        self.assertNotIn('btn-urge-precheck', html)

    def test_home_keeps_readme_actions(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('generateReadMe()', html)
        self.assertIn('generateAnonymousReadMe()', html)
        self.assertIn('generateJsonFile()', html)
        self.assertIn('sendReadmeDataverse()', html)
        self.assertIn('id="readmeForm"', html)
        self.assertIn('static/dvurge.js', html)

    def test_updates_and_privacy_still_render(self):
        updates = self.client.get('/updates')
        self.assertEqual(updates.status_code, 200)
        self.assertIn('URGE', updates.get_data(as_text=True))
        privacy = self.client.get('/privacy')
        self.assertEqual(privacy.status_code, 200)
        self.assertNotIn('precheck/', privacy.get_data(as_text=True))


class PrecheckAssetsGoneTests(unittest.TestCase):
    def test_precheck_static_files_are_absent(self):
        precheck_dir = PROJECT_ROOT / 'static' / 'precheck'
        self.assertFalse(precheck_dir.exists(), 'static/precheck must be removed')

    def test_export_script_is_absent(self):
        script = PROJECT_ROOT / 'scripts' / 'export_precheck_rules_docx.py'
        self.assertFalse(script.exists(), 'precheck export script must be removed')

    def test_requirements_does_not_pin_python_docx(self):
        text = (PROJECT_ROOT / 'requirements.txt').read_text(encoding='utf-8')
        self.assertNotIn('python-docx', text)


if __name__ == '__main__':
    unittest.main()
