#!/usr/bin/python3
"""Root-owned forced SSH command; install only the Ecom artifact, never shell input."""
import fcntl
import grp
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

BASE = Path('/opt/rescova-ecom')
LOG = Path('/var/log/rescova-ecom-deploy.log')
APP_GROUP = grp.getgrnam('rescova-ecom').gr_gid
FILES = {'RELEASE.json', 'package.json', 'package-lock.json', 'src/db.js',
         'src/services/shopify-crypto.js', 'scripts/migrate.js', 'agent/recovery.py',
         'agent/requirements-recovery.txt', 'dashboard/package.json', 'dashboard/package-lock.json'}
PREFIXES = ('src/recovery/', 'migrations/', 'node_modules/', 'dashboard/build/', 'dashboard/node_modules/')


def allowed(name):
    path = PurePosixPath(name)
    return not path.is_absolute() and '..' not in path.parts and (
        str(path) in FILES or str(path).startswith(PREFIXES))


def run(*args):
    with LOG.open('ab') as log:
        subprocess.run(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, check=True, timeout=600)


def healthy():
    for url in ('http://127.0.0.1:3610/healthz', 'http://127.0.0.1:3673/login'):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status != 200:
                    return False
        except Exception:
            return False
    return True


def deploy(state):
    with tempfile.TemporaryDirectory(prefix='incoming-', dir=BASE) as temporary:
        archive = Path(temporary) / 'release.tar.gz'
        signal.alarm(300)
        total = 0
        with archive.open('wb') as output:
            while chunk := sys.stdin.buffer.read(1024 * 1024):
                total += len(chunk)
                if total > 150 * 1024 * 1024:
                    raise RuntimeError('artifact too large')
                output.write(chunk)
        # The 15-minute receiver deadline stays below the 20-minute call fence.
        signal.alarm(900)
        expanded_archive = Path(temporary) / 'release.tar'
        unpack_gzip(archive, expanded_archive)
        with tarfile.open(expanded_archive, 'r:') as tar:
            members = []
            expanded = 0
            for member in tar:
                members.append(member)
                expanded += member.size
                if len(members) > 40000 or expanded > 600 * 1024 * 1024:
                    raise RuntimeError('expanded artifact too large')
            names = set()
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                    raise RuntimeError('unsafe archive member')
                if member.isfile() and (not allowed(member.name) or str(path) in names):
                    raise RuntimeError('unexpected archive file')
                names.add(str(path))
            manifest_member = next(member for member in members if str(PurePosixPath(member.name)) == 'RELEASE.json')
            if manifest_member.size > 4096:
                raise RuntimeError('invalid manifest')
            manifest = json.load(tar.extractfile(manifest_member))
            if manifest.get('schemaVersion') != 1 or manifest.get('repository') != 'louiz7/shoppingcart' or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', '')):
                raise RuntimeError('invalid release identity')
            release = BASE / 'releases' / f"{manifest['commit']}-{time.time_ns()}"
            release.mkdir(mode=0o750)
            state['release'] = release
            os.chown(release, 0, APP_GROUP)
            release.chmod(0o750)
            for member in members:
                if not member.isfile():
                    continue
                destination = release / str(PurePosixPath(member.name))
                destination.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, destination.open('xb') as output:
                    shutil.copyfileobj(source, output)
            for path in release.rglob('*'):
                os.chown(path, 0, APP_GROUP)
                path.chmod(0o750 if path.is_dir() else 0o640)

        # The same transaction lock fences new reservations while existing calls drain.
        active = psql("BEGIN; SELECT pg_advisory_xact_lock(72632026029); "
            "UPDATE recovery_deployment_guard SET paused_until=NOW()+INTERVAL '20 minutes' WHERE id=1; "
            "SELECT count(*) FROM recovery_calls WHERE status IN ('reserved','dialing','connected','unknown') AND ended_at IS NULL; COMMIT;")
        state['paused'] = True
        if active.strip() != '0':
            raise RuntimeError('active calls prevent deployment')

        backups = Path('/var/lib/rescova-ecom-db/backups')
        backups.mkdir(mode=0o700, exist_ok=True)
        import pwd
        owner = pwd.getpwnam('rescova-ecom-db')
        os.chown(backups, owner.pw_uid, owner.pw_gid)
        run('runuser', '-u', 'rescova-ecom-db', '--', '/usr/lib/postgresql/18/bin/pg_dump',
            '-h', '/run/rescova-ecom-db', '-p', '3643', '-d', 'ecom', '-Fc', '-f', str(backups / f'{release.name}.dump'))

        requirements = release / 'agent/requirements-recovery.txt'
        digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
        (BASE / 'venvs').mkdir(mode=0o750, exist_ok=True)
        os.chown(BASE / 'venvs', 0, APP_GROUP)
        (BASE / 'venvs').chmod(0o750)
        venv = BASE / 'venvs' / digest
        ready = BASE / 'venvs' / f'{digest}.ready'
        if not ready.exists():
            venv.mkdir(parents=True, exist_ok=True)
            app = pwd.getpwnam('rescova-ecom')
            os.chown(venv, app.pw_uid, app.pw_gid)
            sandbox = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect',
                '--unit=rescova-ecom-venv', '-p', 'User=rescova-ecom', '-p', 'Group=rescova-ecom',
                '-p', 'NoNewPrivileges=true', '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=true',
                '-p', 'PrivateTmp=true', '-p', 'MemoryMax=768M', '-p', 'CPUQuota=100%',
                '-p', f'ReadWritePaths={venv}',
                '-p', 'InaccessiblePaths=/opt/rescova /opt/debtfree /opt/rescova-crm /var/lib/postgresql /var/lib/rescova-ecom-db']
            run(*sandbox, '/usr/bin/python3', '-m', 'venv', str(venv))
            run(*sandbox, str(venv / 'bin/pip'), 'install', '--disable-pip-version-check', '--no-cache-dir', '-r', str(requirements))
            ready.touch()
        (release / '.venv').symlink_to(venv)

        run('systemd-run', '--quiet', '--wait', '--pipe', '--collect',
            '--unit=rescova-ecom-migrate', '-p', 'User=rescova-ecom', '-p', 'Group=rescova-ecom',
            '-p', f'WorkingDirectory={release}', '-p', 'EnvironmentFile=/etc/rescova-ecom/app.env',
            '-p', 'NoNewPrivileges=true', '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=true',
            '-p', 'PrivateTmp=true', '-p', 'MemoryMax=512M',
            '-p', 'InaccessiblePaths=/opt/rescova /opt/debtfree /opt/rescova-crm /var/lib/postgresql /var/lib/rescova-ecom-db',
            '/usr/bin/node', 'scripts/migrate.js')
        current = BASE / 'current'
        previous = current.resolve() if current.exists() else None
        agent_running = subprocess.run(['systemctl', 'is-active', '--quiet', 'rescova-ecom-agent']).returncode == 0
        candidate = BASE / 'current.next'
        candidate.symlink_to(release)
        candidate.replace(current)
        try:
            run('systemctl', 'enable', 'rescova-ecom-api', 'rescova-ecom-dashboard')
            run('systemctl', 'restart', 'rescova-ecom-api', 'rescova-ecom-dashboard')
            for _ in range(20):
                if healthy():
                    break
                time.sleep(1)
            else:
                raise RuntimeError('health check failed')
            if agent_running:
                run('systemctl', 'restart', 'rescova-ecom-agent')
        except Exception:
            if previous:
                candidate.symlink_to(previous)
                candidate.replace(current)
                run('systemctl', 'restart', 'rescova-ecom-api', 'rescova-ecom-dashboard')
            else:
                run('systemctl', 'stop', 'rescova-ecom-dashboard', 'rescova-ecom-api')
            raise
        # Keep rollback artifacts and three recent DB snapshots within this app only.
        retained = {release, previous}
        older = sorted((p for p in (BASE / 'releases').iterdir() if re.fullmatch(r'[a-f0-9]{40}-[0-9]+', p.name)), key=lambda p: p.name.split('-')[-1], reverse=True)
        for path in older[3:]:
            if path not in retained:
                shutil.rmtree(path)
        for path in sorted(backups.glob('*.dump'), key=lambda p: p.stat().st_mtime, reverse=True)[3:]:
            path.unlink()
        print(f"Ecom release {manifest['commit']} deployed; health checks passed.")

def unpack_gzip(source, destination, limit=640 * 1024 * 1024):
    # Bound metadata expansion before tarfile can allocate a PAX/GNU extension.
    total = 0
    with gzip.open(source, 'rb') as compressed, destination.open('wb') as output:
        while chunk := compressed.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise RuntimeError('expanded archive too large')
            output.write(chunk)


def psql(sql):
    return subprocess.check_output(['runuser', '-u', 'rescova-ecom-db', '--',
        '/usr/lib/postgresql/18/bin/psql', '-h', '/run/rescova-ecom-db', '-p', '3643', '-d', 'ecom',
        '-v', 'ON_ERROR_STOP=1', '-qAtc', sql], text=True, timeout=10)


def expired(_signal, _frame):
    raise TimeoutError('deployment deadline exceeded')


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0:
        raise RuntimeError('forced command only')
    os.umask(0o077)
    with open('/run/rescova-ecom-deploy.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous_handler = signal.signal(signal.SIGALRM, expired)
        state = {}
        try:
            deploy(state)
        finally:
            signal.alarm(0)
            try:
                if state.get('paused'):
                    # A timed-out systemd-run client can leave its transient unit running.
                    with LOG.open('ab') as log:
                        subprocess.run(['systemctl', 'stop', 'rescova-ecom-migrate.service', 'rescova-ecom-venv.service'],
                            stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=30)
                    psql("BEGIN; SELECT pg_advisory_xact_lock(72632026029); UPDATE recovery_deployment_guard SET paused_until=NULL WHERE id=1; COMMIT;")
            finally:
                release = state.get('release')
                if release and (BASE / 'current').resolve() != release:
                    shutil.rmtree(release)
                signal.signal(signal.SIGALRM, previous_handler)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        with LOG.open('a') as output:
            output.write(f'{type(error).__name__}: {error}\n')
        print('Ecom deployment failed; inspect the private server deployment log.', file=sys.stderr)
        sys.exit(1)
