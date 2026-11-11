import importlib.util
import json
import unittest
import sys
import tempfile
import zipfile
sys.dont_write_bytecode = True
from pathlib import Path

spec = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('archive-controlled-run.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveTest(unittest.TestCase):
    def test_credentials_headers_and_opaque_cookies_are_redacted(self):
        source = {'headers': [{'name': 'Cookie', 'value': 'opaque-session'},
                              {'name': 'Authorization', 'value': 'Bearer opaque'}],
                  'cookies': [{'name': 'ftc.auth', 'value': 'opaque-cookie', 'secure': True}],
                  'password': 'secret', 'url': 'https://localhost/auth?code=private&state=state',
                  'params': {'value': 'generated-password'}}
        result = archive.sanitize_value(source, ['generated-password'], [])
        text = json.dumps(result)
        for secret in ['opaque-session', 'Bearer opaque', 'opaque-cookie', 'private', 'generated-password']:
            self.assertNotIn(secret, text)
        self.assertTrue(result['cookies'][0]['secure'])
        self.assertEqual(result['headers'][0]['value'], '[redacted]')

    def test_trace_ndjson_and_binary_resources_preserve_shape(self):
        content = b'{"type":"before","params":{"value":"secret"}}\n{"type":"after"}\n'
        result = archive.sanitize_bytes(content, ['secret'], [])
        self.assertNotIn(b'secret', result)
        self.assertEqual(len(result.splitlines()), 2)
        self.assertEqual(archive.sanitize_bytes(b'\x89PNG\xff', [], []), b'\x89PNG\xff')
        with self.assertRaises(AssertionError):
            archive.sanitize_bytes(b'\xffsecret', ['secret'], [])

    def test_nested_oauth_and_api_keys_are_not_retained(self):
        original = {'postData': {'text': json.dumps({'arguments': {'apiKey': 'opaque-api-key'}})},
                    'cookie': {'name': 'KEYCLOAK_IDENTITY', 'value': 'opaque-sso', 'domain': 'localhost'},
                    'form': '<input name="code" value="opaque-authorization-code">',
                    'url': 'http://localhost/tenants/by-apikey/opaque-url-key'}
        result = json.dumps(archive.sanitize_value(original, [], []))
        for secret in ['opaque-api-key', 'opaque-sso', 'opaque-authorization-code', 'opaque-url-key']:
            self.assertNotIn(secret, result)

    def test_zip_trace_retains_entries_and_redacts_bodies(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.zip'
            target = Path(directory) / 'sanitized.zip'
            with zipfile.ZipFile(source, 'w') as zipped:
                zipped.writestr('resources/body.dat', '{"apiKey":"opaque-key"}')
                zipped.writestr('trace.trace', '{"type":"before","params":{"value":"password"}}\n')
            archive.archive_trace(source, target, ['password'], [])
            with zipfile.ZipFile(target) as zipped:
                self.assertEqual(len(zipped.namelist()), 2)
                self.assertNotIn(b'opaque-key', zipped.read('resources/body.dat'))
                self.assertNotIn(b'password', zipped.read('trace.trace'))


if __name__ == '__main__':
    unittest.main()
