'use strict';

// The release contains the isolated Ecom runtime; no repository-wide copy is permitted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const output = path.resolve(process.argv[2] || '');
const commit = process.argv[3] || process.env.GITHUB_SHA || '';
if (!process.argv[2] || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('An output archive and full commit SHA are required');
if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== 'louiz7/shoppingcart') throw new Error('Unexpected release repository');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rescova-ecom-release-'));
const stage = path.join(temporary, 'stage'), release = path.join(temporary, 'release');

function allowed(file) {
    const parts = file.split(path.sep), name = path.basename(file);
    return !parts.some((part) => ['.git', '.local', '.bin', '__pycache__', 'test', 'tests', '__tests__', 'coverage'].includes(part)) &&
        !name.startsWith('.env') && !name.startsWith('._') && !['.npmrc', '.npmignore'].includes(name) &&
        !/\.(map|pyc|test\.js|test\.ts|spec\.js|spec\.ts)$/.test(name);
}

function copy(source, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, dereference: true, filter: allowed });
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    if (result.error || result.status !== 0) throw new Error(`${command} failed while packaging the Ecom release`);
}

try {
    for (const entry of ['src/recovery', 'src/db.js', 'src/services/shopify-crypto.js', 'migrations',
        'scripts/migrate.js', 'agent/recovery.py', 'agent/requirements-recovery.txt',
        'dashboard/build', 'dashboard/package.json', 'dashboard/package-lock.json']) {
        copy(path.resolve(entry), path.join(stage, entry));
    }
    for (const name of ['package.json', 'package-lock.json']) copy(path.resolve('deploy/ecom', name), path.join(stage, name));
    for (const directory of [stage, path.join(stage, 'dashboard')]) {
        run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
    }
    fs.writeFileSync(path.join(stage, 'RELEASE.json'), JSON.stringify({
        schemaVersion: 1, commit, repository: 'louiz7/shoppingcart', createdAt: new Date().toISOString(),
    }) + '\n');
    // A second copy materializes dependency links and separates hard-linked files before tar runs.
    copy(stage, release);
    let entries = 0, bytes = 0;
    function inspect(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, item.name), stat = fs.lstatSync(file);
            if (!allowed(file) || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) {
                throw new Error('Release contains an unexpected file type or excluded path');
            }
            entries++;
            if (stat.isDirectory()) inspect(file); else bytes += stat.size;
        }
    }
    inspect(release);
    if (entries > 40000 || bytes > 600 * 1024 * 1024) throw new Error('Release exceeds deployment extraction limits');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    run('tar', ['--dereference', '-czf', output, '-C', release, 'RELEASE.json', 'package.json', 'package-lock.json',
        'node_modules', 'src', 'migrations', 'scripts', 'agent', 'dashboard']);
    const compressed = fs.statSync(output).size;
    if (compressed > 150 * 1024 * 1024) {
        fs.rmSync(output);
        throw new Error('Release exceeds deployment upload limit');
    }
    console.log(JSON.stringify({ commit, entries, uncompressedBytes: bytes, compressedBytes: compressed }));
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
