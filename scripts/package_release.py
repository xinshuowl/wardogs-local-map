import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIRECTORIES = ['assets/models', 'assets/terrain', 'assets/landscape', 'assets/tiles']
EXCLUDED_DIRECTORIES = ['assets/models/source', 'assets/terrain/source']
PRIVATE_PREFIXES = ['.git/', '.local-data/', '.reference/', '.asset-updates/', '.publication/', '%SystemDrive%/', '.validation/backup', '.validation/swap-']


def file_digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def publishable(path):
    relative = path.relative_to(ROOT).as_posix()
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
        raise ValueError('Release file escapes the project: ' + relative)
    if relative == '.local-server.json' or any(relative.startswith(prefix) for prefix in PRIVATE_PREFIXES):
        raise ValueError('Private local file selected: ' + relative)
    if path.name == '.env' or path.name.startswith('.env.') and path.name != '.env.example':
        raise ValueError('Environment file selected: ' + relative)
    return relative


def main():
    parser = argparse.ArgumentParser(description='Package the complete local map for a GitHub Release.')
    parser.add_argument('--version', default=json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version'])
    arguments = parser.parse_args()
    if not arguments.version or any(character not in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-' for character in arguments.version):
        raise ValueError('Invalid release version')
    directory = ROOT / '.publication' / ('v' + arguments.version)
    directory.mkdir(parents=True, exist_ok=True)
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode('utf-8').split('\0')
    files = {ROOT / relative for relative in tracked if relative}
    if not files:
        raise ValueError('Stage the public source files before packaging.')
    for runtime in RUNTIME_DIRECTORIES:
        for path in (ROOT / runtime).rglob('*'):
            if not path.is_file():
                continue
            relative = path.relative_to(ROOT).as_posix()
            if any(relative.startswith(excluded + '/') for excluded in EXCLUDED_DIRECTORIES):
                continue
            files.add(path)
    for relative in ['promotional-video/wardogs-promo-1080p.mp4', 'promotional-video/original-music.wav']:
        files.add(ROOT / relative)
    for relative in ['index.html', 'map-data.js', 'vendor/three/three.module.js', 'assets/scene-manifest.json', 'assets/terrain/manifest.json', 'assets/models/bakurani/manifest.json', 'assets/models/ozeti/manifest.json', 'assets/models/zestafona/manifest.json']:
        if ROOT / relative not in files:
            raise ValueError('Required runtime file missing: ' + relative)
    manifest = {'version': arguments.version, 'files': []}
    archive_path = directory / ('wardogs-local-map-v' + arguments.version + '.zip')
    stored_extensions = {'.mp4', '.png', '.jpg', '.webp', '.woff2'}
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for order, path in enumerate(sorted(files), start=1):
            relative = publishable(path)
            checksum = file_digest(path)
            manifest['files'].append({'path': relative, 'bytes': path.stat().st_size, 'sha256': checksum})
            compression = zipfile.ZIP_STORED if path.suffix in stored_extensions else zipfile.ZIP_DEFLATED
            archive.write(path, 'wardogs-local-map/' + relative, compress_type=compression)
            if order % 1000 == 0:
                print(f'Packaged {order}/{len(files)} files', flush=True)
        archive.writestr('wardogs-local-map/RELEASE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(archive_path) as archive:
        failure = archive.testzip()
        if failure:
            raise ValueError('ZIP integrity check failed: ' + failure)
    (directory / 'RELEASE-MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    assets = [archive_path, ROOT / 'promotional-video/wardogs-promo-1080p.mp4']
    checksums = '\n'.join(file_digest(path) + '  ' + path.name for path in assets) + '\n'
    (directory / 'SHA256SUMS.txt').write_text(checksums, encoding='utf-8')
    print(json.dumps({'archive': str(archive_path), 'files': len(files), 'bytes': archive_path.stat().st_size, 'unpackedBytes': sum(entry['bytes'] for entry in manifest['files']), 'verified': True}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
