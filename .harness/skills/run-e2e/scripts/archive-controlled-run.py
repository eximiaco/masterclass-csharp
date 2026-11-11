#!/usr/bin/env python3
"""Arquiva provas controladas e traces sanitizados. Exemplo: --run DIR --dest DIR."""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

SensitiveKeys = {'authorization', 'cookie', 'set-cookie', 'password', 'client_secret',
                 'access_token', 'refresh_token', 'id_token', 'code_verifier', 'apikey', 'api_key', 'x-api-key'}
OAuthFields = {'code', 'state', 'session_state', 'client_data', 'code_verifier'}


def sanitize_text(text, secrets, rewrites):
    for secret in secrets:
        text = text.replace(secret, '[redacted]')
    text = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted-jwt]', text)
    text = re.sub(r'([?&](?:code|state|session_state|client_data|code_verifier)=)[^&\s"<>]+', r'\1[redacted]', text)
    text = re.sub(r'(/tenants/by-apikey/)[^/\s?\"<>]+', r'\1[redacted-api-key]', text, flags=re.I)
    text = re.sub(r'(ftc\.auth(?:C\d+)?=)[^;\s"<>]+', r'\1[redacted]', text)
    text = re.sub(r'<input\b[^>]*>', sanitize_input, text, flags=re.I)
    for source, destination in rewrites:
        text = text.replace(source, destination)
    return text


def sanitize_input(match):
    tag = match.group(0)
    name = re.search(r"\bname\s*=\s*[\"']([^\"']+)", tag, re.I)
    if name and name.group(1).lower() in OAuthFields | SensitiveKeys:
        tag = re.sub(r"(\bvalue\s*=\s*[\"'])[^\"']*", r"\1[redacted]", tag, flags=re.I)
    return tag


def sanitize_value(value, secrets, rewrites):
    if isinstance(value, str):
        if value.lstrip().startswith(('{', '[')):
            try:
                return json.dumps(sanitize_value(json.loads(value), secrets, rewrites), ensure_ascii=False)
            except json.JSONDecodeError:
                pass
        return sanitize_text(value, secrets, rewrites)
    if isinstance(value, list):
        return [sanitize_value(item, secrets, rewrites) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: ('[redacted]' if key.lower() in SensitiveKeys else sanitize_value(item, secrets, rewrites))
              for key, item in value.items()}
    name = str(value.get('name', '')).lower()
    if 'value' in value and (name in SensitiveKeys | OAuthFields or name.startswith('ftc.auth') or 'domain' in value or 'httpOnly' in value):
        result['value'] = '[redacted]'
    # Cookies têm esquema próprio; preservar forma para manter trace legível.
    if isinstance(value.get('cookies'), list):
        result['cookies'] = [{**sanitize_value(cookie, secrets, rewrites), 'value': '[redacted]'}
                             for cookie in value['cookies']]
    return result


def sanitize_bytes(content, secrets, rewrites):
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        assert not any(secret.encode() in content for secret in secrets), 'Segredo em recurso binário'
        return content
    try:
        value = json.loads(text)
        return (json.dumps(sanitize_value(value, secrets, rewrites), ensure_ascii=False) + '\n').encode()
    except json.JSONDecodeError:
        lines = []
        for line in text.splitlines():
            try:
                line = json.dumps(sanitize_value(json.loads(line), secrets, rewrites), ensure_ascii=False)
            except json.JSONDecodeError:
                line = sanitize_text(line, secrets, rewrites)
            lines.append(line)
        return ('\n'.join(lines) + '\n').encode()


def archive_trace(source, destination, secrets, rewrites):
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination, 'x', zipfile.ZIP_DEFLATED) as archived:
        for entry in original.infolist():
            assert not entry.filename.startswith('/') and '..' not in Path(entry.filename).parts, 'Path inválido no trace'
            archived.writestr(entry, sanitize_bytes(original.read(entry), secrets, rewrites))


def archive_run(run, destination, source_root, repo_root):
    marker = json.loads((run / 'runtime/ownership.json').read_text())
    assert marker['owner'] == 'run-e2e-controlled' and Path(marker['outDir']) == run
    assert marker['project'] == 'ftc-e2e-controlled-' + marker['id']
    credentials = json.loads((run / 'runtime/credentials.json').read_text())
    secrets = [credentials['postgres'], credentials['admin']['password'], *credentials['clients'].values(),
               *[account['password'] for account in credentials['accounts']]]
    rewrites = [(str(run), str(destination)), (str(source_root), str(repo_root))]
    destination.mkdir(parents=True, exist_ok=False)
    names = ['report.json', 'summary.md', 'controlled-stack.log', 'runtime/versions.json', 'runtime/readiness.json']
    names += [str(path.relative_to(run)) for directory in ['runtime/test-results', 'runtime/diagnostics']
              for path in (run / directory).rglob('*') if path.is_file()
              and path.suffix in {'.json', '.md', '.zip', '.png'}]
    inventory = []
    for name in sorted(set(names)):
        source = run / name
        if not source.exists():
            continue
        assert not source.is_symlink() and source.stat().st_nlink == 1, 'Prova não regular/exclusiva'
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.suffix == '.zip':
            archive_trace(source, target, secrets, rewrites)
        else:
            content = sanitize_bytes(source.read_bytes(), secrets, rewrites)
            if name == 'report.json':
                report = json.loads(content)
                report['artifacts']['html_report'] = None
                report['artifacts']['controlled_runtime'] = None
                report['archive_note'] = 'JSON completo e traces sanitizados; HTML e runtime privado não retidos.'
                content = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode()
            if name == 'summary.md':
                content = re.sub(rb'^- (?:html_report|controlled_runtime):.*$', b'- runtime/HTML privados descartados; JSON e traces sanitizados retidos.', content, flags=re.M)
            target.write_bytes(content)
        inventory.append({'path': name, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    (destination / 'archive.json').write_text(json.dumps({'run_id': marker['id'], 'files': inventory}, indent=2) + '\n')
    return inventory


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['run', 'dest', 'source-root', 'repo-root']:
        parser.add_argument('--' + key, type=Path, required=True)
    args = parser.parse_args()
    inventory = archive_run(args.run.resolve(), args.dest.resolve(), args.source_root.resolve(), args.repo_root.resolve())
    print(json.dumps({'archived_files': len(inventory), 'destination': str(args.dest)}))
