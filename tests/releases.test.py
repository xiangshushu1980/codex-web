import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('releases', str(Path(__file__).resolve().parents[1] / 'scripts/releases'))
spec = importlib.util.spec_from_loader(loader.name, loader)
r = importlib.util.module_from_spec(spec)
loader.exec_module(r)

class ReleasesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Path(self.temp.name)
        self.saved = r.STORE
        r.STORE = self.store
    def tearDown(self):
        r.STORE = self.saved
        self.temp.cleanup()
    def release(self, name):
        p = self.store / name
        p.mkdir()
        (p / 'asset').write_text(name)
        r.atomic_json(p / 'release.json', {'status': 'validated', 'artifacts': {'asset': r.digest(p / 'asset')}})
        return p
    def command(self, *args, state='inactive'):
        with patch('sys.argv', ['releases', *args]), patch.object(r.subprocess, 'run') as run:
            run.return_value.returncode = 3 if state == 'inactive' else 0
            run.return_value.stdout = state
            r.main()
    def test_switch_rollback_and_integrity(self):
        a, b = self.release('a'), self.release('b')
        self.command('activate', 'a', '--service-stopped')
        self.command('activate', 'b', '--service-stopped')
        self.assertEqual((self.store / 'current').resolve(), b)
        self.assertEqual((self.store / 'previous').resolve(), a)
        self.command('rollback', '--service-stopped')
        self.assertEqual((self.store / 'current').resolve(), a)
        (b / 'asset').write_text('corrupted')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.command('activate', 'b', '--service-stopped')
        self.assertEqual((self.store / 'current').resolve(), a)
    def test_running_service_rejects_switch(self):
        self.release('a')
        with self.assertRaisesRegex(ValueError, 'inactive'):
            self.command('activate', 'a', '--service-stopped', state='active')
        self.assertFalse((self.store / 'current').exists())
    def test_failed_and_outside_releases_rejected(self):
        p = self.release('a')
        r.atomic_json(p / 'release.json', {'status': 'failed'})
        with self.assertRaisesRegex(ValueError, 'validation'):
            r.validated('a')
        with self.assertRaisesRegex(ValueError, 'direct child'):
            r.validated('..')
    def test_prepare_failure_preserves_selection(self):
        import subprocess
        a = self.release('a')
        r.link('current', a)
        with patch('sys.argv', ['releases', 'prepare']), patch.object(r.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'patch')):
            with self.assertRaisesRegex(RuntimeError, 'live resources unchanged'):
                r.main()
        self.assertEqual((self.store / 'current').resolve(), a)
        failed = [p for p in self.store.glob('*/release.json') if p.parent.name not in ['a', 'current']]
        self.assertEqual(len(failed), 1)
        self.assertEqual(json.loads(failed[0].read_text())['status'], 'failed')

class PatchPlanTest(unittest.TestCase):
    def test_version_targets_and_order(self):
        import subprocess
        import re
        root = Path(__file__).resolve().parents[1]
        plan = json.loads((root / 'patches/manifest.json').read_text())
        with tempfile.TemporaryDirectory() as folder:
            tree = Path(folder)
            (tree / 'package.json').write_text(json.dumps({'version': 'unknown'}))
            command = ['node', str(root / 'scripts/patch-plan.cjs'), folder]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Unsupported upstream', result.stderr)
            (tree / 'package.json').write_text(json.dumps({'version': plan['upstreamVersions'][0]}))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('missing target', result.stderr)
            for item in plan['patches']:
                for name in re.findall(r'^\+\+\+ b/(.+)$', (root / 'patches' / item['file']).read_text(), re.M):
                    target = tree / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.touch()
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

if __name__ == '__main__':
    unittest.main()
