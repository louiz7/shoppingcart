"""Offline tests for the forced SSH artifact boundary; no service or provider runs."""
import builtins
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


WRAPPER = Path(__file__).parents[1] / 'deploy/ecom/receive-release.py'


class BeforeOperations(Exception):
    pass


class DeploymentBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('ecom_release_wrapper_test', WRAPPER)
        cls.wrapper = importlib.util.module_from_spec(spec)
        with patch('grp.getgrnam', return_value=SimpleNamespace(gr_gid=os.getgid())):
            spec.loader.exec_module(cls.wrapper)

    def archive(self, files=(), manifest=None):
        data = io.BytesIO()
        value = manifest if manifest is not None else {
            'schemaVersion': 1, 'repository': 'louiz7/shoppingcart', 'commit': 'a' * 40,
        }
        entries = [('RELEASE.json', json.dumps(value).encode())] + list(files)
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name, payload in entries:
                member = tarfile.TarInfo(name)
                if isinstance(payload, tarfile.TarInfo):
                    archive.addfile(payload)
                else:
                    member.size = len(payload)
                    member.mode = 0o4777
                    archive.addfile(member, io.BytesIO(payload))
        return data.getvalue()

    def invoke(self, payload):
        wrapper = self.wrapper
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary) / 'app'
            (base / 'releases').mkdir(parents=True)
            real_open = builtins.open

            def safe_open(path, *args, **kwargs):
                if str(path) == '/run/rescova-ecom-deploy.lock':
                    path = Path(temporary) / 'deploy.lock'
                return real_open(path, *args, **kwargs)

            # Stop at the first DB read: no service, pip, shell, migration or network may run.
            captured = []

            def before_operations(*_args, **_kwargs):
                self.release_modes = [path.stat().st_mode & 0o7777
                    for path in (base / 'releases').iterdir()]
                captured.extend((str(path.relative_to(base)), path.stat().st_mode & 0o7777)
                    for path in base.rglob('*') if path.is_file() and 'releases' in path.parts)
                raise BeforeOperations('validated archive reached DB guard')

            stop = Mock(side_effect=before_operations)
            with patch.object(wrapper, 'BASE', base), patch.object(wrapper, 'LOG', Path(temporary) / 'deploy.log'), \
                    patch.object(wrapper.sys, 'argv', ['receive-release.py']), \
                    patch.object(wrapper.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(payload))), \
                    patch.object(wrapper.os, 'geteuid', return_value=0), patch.object(wrapper.os, 'umask'), \
                    patch.object(wrapper.os, 'chown'), patch.object(wrapper.signal, 'alarm'), \
                    patch('builtins.open', safe_open), patch.object(wrapper.subprocess, 'check_output', stop), \
                    patch.object(wrapper, 'run', side_effect=AssertionError('external operation forbidden')):
                try:
                    wrapper.main()
                except Exception as error:
                    self.remaining_releases = list((base / 'releases').iterdir())
                    extracted = captured or [(str(path.relative_to(base)), path.stat().st_mode & 0o7777)
                        for path in base.rglob('*') if path.is_file()]
                    return error, stop.call_args_list, extracted
                self.fail('wrapper must stop before external operations')

    def test_allowlist_excludes_legacy_apps_secrets_and_parent_traversal(self):
        for name in ['RELEASE.json', 'src/recovery/server.js', './src/recovery/policy.js',
                     'src/db.js', 'migrations/027_recovery_owner_tests.sql',
                     'dashboard/build/server/index.js', 'node_modules/pg/package.json']:
            with self.subTest(name=name):
                self.assertTrue(self.wrapper.allowed(name))
        for name in ['.env', '.github/workflows/ecom-deploy.yml', 'src/index.js', 'src/routes/outbound.js',
                     'agent/agent.py', 'deploy/ecom/receive-release.py', '/root/.ssh/authorized_keys',
                     '../package.json', 'src/recovery/../../db.js', 'node_modules/../.env']:
            with self.subTest(name=name):
                self.assertFalse(self.wrapper.allowed(name))

    def test_valid_files_are_copied_without_executable_or_setuid_modes(self):
        # Production starts with umask 077; the root-owned release must still be traversable by the app group.
        previous_umask = os.umask(0o077)
        try:
            error, calls, files = self.invoke(self.archive([('src/recovery/server.js', b'never executed')]))
        finally:
            os.umask(previous_umask)
        self.assertIsInstance(error, BeforeOperations)
        self.assertEqual(len(calls), 1)
        self.assertTrue(files)
        self.assertTrue(all(mode == 0o640 for _, mode in files))
        self.assertTrue(all(name.startswith('releases/') for name, _ in files))
        self.assertFalse(self.remaining_releases)
        self.assertEqual(self.release_modes, [0o750])
        query = calls[0].args[0][-1]
        self.assertIn("'unknown'", query)
        self.assertNotIn('dispatch_unknown', query)

    def test_archive_rejects_links_special_files_and_canonical_duplicate_files(self):
        bad = []
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE]:
            member = tarfile.TarInfo('node_modules/malicious')
            member.type, member.linkname = kind, '/etc/shadow'
            bad.append(self.archive([(member.name, member)]))
        bad.extend([
            self.archive([('../escaped', b'bad')]), self.archive([('/root/escaped', b'bad')]),
            self.archive([('src/index.js', b'bad')]),
            self.archive([('src/recovery/a.js', b'one'), ('./src/recovery/a.js', b'two')]),
        ])
        for payload in bad:
            with self.subTest(size=len(payload)):
                error, calls, files = self.invoke(payload)
                self.assertIsInstance(error, RuntimeError)
                self.assertFalse(calls)
                self.assertFalse(files)

    def test_manifest_identity_and_size_are_checked_before_operations(self):
        for manifest in [
            {'schemaVersion': 2, 'repository': 'louiz7/shoppingcart', 'commit': 'a' * 40},
            {'schemaVersion': 1, 'repository': 'other/repository', 'commit': 'a' * 40},
            {'schemaVersion': 1, 'repository': 'louiz7/shoppingcart', 'commit': '../shell'},
        ]:
            error, calls, files = self.invoke(self.archive(manifest=manifest))
            self.assertIsInstance(error, RuntimeError)
            self.assertFalse(calls)
            self.assertFalse(files)
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            member = tarfile.TarInfo('RELEASE.json')
            member.size = 4097
            archive.addfile(member, io.BytesIO(b' ' * member.size))
        error, calls, files = self.invoke(data.getvalue())
        self.assertIsInstance(error, RuntimeError)
        self.assertFalse(calls)
        self.assertFalse(files)

    def test_forced_command_rejects_arguments_and_nonroot_before_stdin(self):
        for argv, uid in [(['wrapper', 'untrusted-command'], 0), (['wrapper'], 1000)]:
            with self.subTest(argv=argv, uid=uid), \
                    patch.object(self.wrapper.sys, 'argv', argv), \
                    patch.object(self.wrapper.os, 'geteuid', return_value=uid):
                with self.assertRaisesRegex(RuntimeError, 'forced command only'):
                    self.wrapper.main()

    def test_gzip_expansion_is_bounded_before_pax_metadata_parsing(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w', pax_headers={'comment': 'x' * 100000}) as archive:
            member = tarfile.TarInfo('RELEASE.json')
            archive.addfile(member, io.BytesIO())
        with tempfile.TemporaryDirectory() as temporary:
            source, destination = Path(temporary) / 'input.gz', Path(temporary) / 'expanded.tar'
            source.write_bytes(gzip.compress(raw.getvalue()))
            self.assertLess(source.stat().st_size, 1024)
            with self.assertRaisesRegex(RuntimeError, 'expanded archive too large'):
                self.wrapper.unpack_gzip(source, destination, limit=8192)
            self.assertLessEqual(destination.stat().st_size, 8192)
            source.write_bytes(gzip.compress(b'valid input'))
            self.wrapper.unpack_gzip(source, destination, limit=11)
            self.assertEqual(destination.read_bytes(), b'valid input')

    def cleanup_after_failure(self, unpause_error=None):
        wrapper = self.wrapper
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary) / 'app'
            release = base / 'releases' / ('a' * 40 + '-123')
            release.mkdir(parents=True)
            real_open = builtins.open

            def safe_open(path, *args, **kwargs):
                if str(path) == '/run/rescova-ecom-deploy.lock':
                    path = Path(temporary) / 'deploy.lock'
                return real_open(path, *args, **kwargs)

            def timed_out(state):
                state.update(paused=True, release=release)
                wrapper.expired(None, None)

            previous_handler = object()
            with patch.object(wrapper, 'BASE', base), patch.object(wrapper, 'LOG', Path(temporary) / 'deploy.log'), \
                    patch.object(wrapper.sys, 'argv', ['receive-release.py']), \
                    patch.object(wrapper.os, 'geteuid', return_value=0), patch.object(wrapper.os, 'umask'), \
                    patch('builtins.open', safe_open), patch.object(wrapper, 'deploy', side_effect=timed_out), \
                    patch.object(wrapper.signal, 'alarm') as alarm, \
                    patch.object(wrapper.signal, 'signal', return_value=previous_handler) as handler, \
                    patch.object(wrapper.subprocess, 'run') as service, \
                    patch.object(wrapper, 'psql', side_effect=unpause_error) as database:
                with self.assertRaises(TimeoutError if unpause_error is None else RuntimeError):
                    wrapper.main()
                self.assertFalse(release.exists())
                alarm.assert_called_once_with(0)
                self.assertEqual(handler.call_args_list[-1].args,
                    (wrapper.signal.SIGALRM, previous_handler))
                service.assert_called_once()
                self.assertEqual(service.call_args.args[0], ['systemctl', 'stop',
                    'rescova-ecom-migrate.service', 'rescova-ecom-venv.service'])
                self.assertEqual(service.call_args.kwargs['timeout'], 30)
                database.assert_called_once()
                self.assertIn('pg_advisory_xact_lock(72632026029)', database.call_args.args[0])
                self.assertIn('paused_until=NULL', database.call_args.args[0])

    def test_deadline_stops_only_own_transient_units_and_releases_call_fence(self):
        self.cleanup_after_failure()

    def test_failed_release_is_removed_even_if_fence_cleanup_fails(self):
        self.cleanup_after_failure(RuntimeError('synthetic database failure'))


if __name__ == '__main__':
    unittest.main()
