"""Offline, stdlib-only snapshot/parser contract tests; no source requests."""
import copy
import importlib.util
import json
import ipaddress
import re
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


class SourceBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = ROOT / 'compile_policy.py'
        if not path.exists():
            raise AssertionError('Missing offline source boundary validator')
        spec = importlib.util.spec_from_file_location('compile_policy', path)
        cls.compiler = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.compiler)
        cls.metadata = json.loads((ROOT / 'snapshots.json').read_text())
        cls.sources = {item['family']: (ROOT / item['file']).read_bytes() for item in cls.metadata['sources']}

    def test_exact_source_to_generated_policy(self):
        with patch('socket.socket', side_effect=AssertionError('ForbiddenNetwork')), patch('urllib.request.urlopen', side_effect=AssertionError('ForbiddenFetch')):
            generated = self.compiler.compile_policy(ROOT, self.metadata)
            self.assertEqual(generated, json.loads((ROOT / 'policy.json').read_text()))
            self.assertEqual((json.dumps(generated, indent=2) + '\n').encode('utf-8'), (ROOT / 'policy.json').read_bytes())
            self.assertEqual(sum(len(record['blocks']) for registry in generated['registries'] for record in registry['records']), 51)
            for registry in generated['registries']:
                self.assertEqual(registry['revision'], '2025-10-09')
                self.assertEqual(len(registry['records']), 25)
                self.assertTrue(all(record['references'] for record in registry['records']))
            self.assertEqual(sum(len(record['blocks']) for record in generated['registries'][0]['records']), 26)

    def test_numeric_address_canonical_contract(self):
        # IPv6 is lowercase hex; compress the leftmost longest zero run of >=2.
        cases = [
            ('0.0.0.0', '0.0.0.0'), ('255.255.255.255', '255.255.255.255'),
            ('::', '::'), ('::1', '::1'),
            ('FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'),
            ('2001:0DB8:0000:0001:0002:0003:0004:0005', '2001:db8:0:1:2:3:4:5'),
            ('0:0:1:2:3:4:5:6', '::1:2:3:4:5:6'),
            ('1:2:3:4:5:6:0:0', '1:2:3:4:5:6::'),
            ('1:0:0:2:0:0:3:4', '1::2:0:0:3:4'),
            ('0:0:1:0:0:2:3:4', '::1:0:0:2:3:4'),
            ('1:0:0:2:0:0:0:3', '1:0:0:2::3'),
            ('::ffff:0.0.0.0', '::ffff:0:0'),
            ('::ffff:192.0.2.1', '::ffff:c000:201'),
            ('::ffff:255.255.255.255', '::ffff:ffff:ffff'),
            ('0:0:0:0:0:ffff:0:0', '::ffff:0:0'),
        ]
        for representation, expected in cases:
            with self.subTest(representation=representation):
                address = ipaddress.ip_address(representation)
                self.assertEqual(int(address), int(ipaddress.ip_address(expected)))
                self.assertEqual(self.compiler._canonical_address(address), expected)
        self.assertEqual(ipaddress.ip_network('::ffff:0.0.0.0/96'), ipaddress.ip_network('::ffff:0:0/96'))

    def test_mapped_formatting_portability_preserves_exact_artifact(self):
        original = ipaddress.IPv6Address.__str__
        for spellings in (
            {0xffff00000000: '::ffff:0:0', 0xffffffffffff: '::ffff:ffff:ffff'},
            {0xffff00000000: '::ffff:0.0.0.0', 0xffffffffffff: '::ffff:255.255.255.255'},
        ):
            def formatted(address):
                return spellings.get(int(address), original(address))
            with self.subTest(spellings=spellings), patch.object(ipaddress.IPv6Address, '__str__', formatted):
                generated = self.compiler.compile_policy(ROOT, self.metadata)
                mapped = next(record['blocks'][0] for record in generated['registries'][1]['records'] if record['name'] == 'IPv4-mapped Address')
                self.assertEqual(mapped, {'cidr': '::ffff:0:0/96', 'first': '::ffff:0:0', 'last': '::ffff:ffff:ffff'})
                self.assertEqual((json.dumps(generated, indent=2) + '\n').encode('utf-8'), (ROOT / 'policy.json').read_bytes())
        duplicate = self.sources[6].replace(b'<address>::/128</address>', b'<address>::ffff:0.0.0.0/96</address>')
        with self.assertRaisesRegex(self.compiler.SnapshotInvalid, 'record-family-or-duplicate'):
            self.compiler.parse_registry(duplicate, 6)

    def test_refresh_rejects_unequal_registry_counts_without_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            for name in ('compile_policy.py', 'snapshots.json'):
                (directory / name).write_bytes((ROOT / name).read_bytes())
            for source in self.metadata['sources']:
                (directory / source['file']).write_bytes(self.sources[source['family']])
            for count in (1, 3):
                previous = json.loads((ROOT / 'policy.json').read_text())
                previous['registries'] = (previous['registries'] * 2)[:count]
                retained = json.dumps(previous).encode('utf-8')
                (directory / 'policy.json').write_bytes(retained)
                result = subprocess.run([sys.executable, str(directory / 'compile_policy.py'), '--write'], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('SnapshotInvalid: registry-exclusion-removed', result.stderr)
                self.assertEqual((directory / 'policy.json').read_bytes(), retained)

    def test_xml_rejects_entities_doctype_xinclude_and_bad_schema(self):
        original = self.sources[4]
        cases = [
            b'<!DOCTYPE registry SYSTEM "https://forbidden.invalid/schema.dtd">' + original,
            b'<!DOCTYPE registry [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' + original,
            b'<!DOCTYPE registry [<!ENTITY % leak SYSTEM "https://forbidden.invalid/">%leak;]>' + original,
            original.replace(b'"This network"', b'&undefined;'),
            original.replace(b'http://www.iana.org/assignments', b'http://wrong.invalid/schema'),
            original.replace(b'iana-ipv4-special-registry-1', b'guessed-table'),
            original.replace(b'<address>0.0.0.0/8</address>', b'<address>10.0.0.1/8</address>'),
            original.replace(b'<address>0.0.0.0/8</address>', b'<address>::/8</address>'),
            original.replace(b'<address>0.0.0.0/8</address>', b'<address>0.0.0.0/33</address>'),
            re.sub(rb'<record(?: [^>]*)?>.*?</record>', b'', original, flags=re.S),
            original.replace(b'<global>False</global>', b'<global>Maybe</global>', 1),
            original.replace(b'<name>"This network"</name>', b''),
            original.replace(b'<title>IPv4 Special-Purpose Address Space</title>', b'', 1),
            original.replace(b'<people/>', b'<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="https://forbidden.invalid/"/>'),
            original.replace(b'<updated>2025-10-09</updated>', b'<updated>2025-99-99</updated>'),
            original[:-20], b'\xff', original.decode().encode('utf-16'), b'x' * 1048577,
        ]
        with patch('socket.socket', side_effect=AssertionError('ForbiddenNetwork')), patch('urllib.request.urlopen', side_effect=AssertionError('ForbiddenFetch')):
            for data in cases:
                with self.subTest(data=data[:60]), self.assertRaises(self.compiler.SnapshotInvalid):
                    self.compiler.parse_registry(data, 4)
        with self.assertRaises(self.compiler.SnapshotInvalid):
            self.compiler.parse_registry(original, 5)

    def test_missing_or_changed_source_metadata_fails_closed(self):
        for key, value in [('url', 'https://forbidden.invalid/'), ('file', '../other.xml'), ('sha256', '0' * 64), ('bytes', 1), ('retrievedAt', None), ('retrievedAt', '2026-10-06'), ('retrievedAt', '2000-01-01T00:00:00Z'), ('retrievedAt', '2999-01-01T00:00:00Z'), ('retrievedAt', '2026-10-06T99:99:99Z'), ('family', 6)]:
            metadata = copy.deepcopy(self.metadata)
            metadata['sources'][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(self.compiler.SnapshotInvalid):
                self.compiler.compile_policy(ROOT, metadata)
        metadata = copy.deepcopy(self.metadata)
        metadata['sources'].pop()
        with self.assertRaises(self.compiler.SnapshotInvalid):
            self.compiler.compile_policy(ROOT, metadata)
        metadata = copy.deepcopy(self.metadata)
        metadata['conservativeConfig']['ipv6Envelope']['cidr'] = '::/0'
        with self.assertRaises(self.compiler.SnapshotInvalid):
            self.compiler.compile_policy(ROOT, metadata)

    def test_parser_hook_rejects_dtd_before_entity_expansion(self):
        xml = '<!DOCTYPE registry [<!ENTITY expansion "content">]><registry>&expansion;</registry>'
        with self.assertRaisesRegex(self.compiler.SnapshotInvalid, 'xml-doctype-forbidden'):
            self.compiler.ET.fromstring(xml, parser=self.compiler.ET.XMLParser(target=self.compiler.NoDoctype()))

    def test_missing_source_and_invalid_metadata_are_named(self):
        for metadata in (None, [], {}, {'sources': [None, None]}):
            with self.assertRaises(self.compiler.SnapshotInvalid):
                self.compiler.compile_policy(ROOT, metadata)
        with tempfile.TemporaryDirectory() as folder, self.assertRaisesRegex(self.compiler.SnapshotInvalid, 'snapshot-unavailable'):
            self.compiler.compile_policy(Path(folder), self.metadata)

    def test_refresh_cannot_remove_previous_exclusions(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            for name in ('compile_policy.py', 'snapshots.json', 'policy.json'):
                (directory / name).write_bytes((ROOT / name).read_bytes())
            metadata = copy.deepcopy(self.metadata)
            for source in metadata['sources']:
                data = self.sources[source['family']]
                if source['family'] == 4:
                    start, end = data.index(b'     <record>'), data.index(b'    </record>') + len(b'    </record>')
                    data = data[:start] + data[end:]
                    source.update(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
                (directory / source['file']).write_bytes(data)
            (directory / 'snapshots.json').write_text(json.dumps(metadata))
            result = subprocess.run([sys.executable, str(directory / 'compile_policy.py'), '--write'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('registry-exclusion-removed', result.stderr)
            self.assertEqual((directory / 'policy.json').read_bytes(), (ROOT / 'policy.json').read_bytes())

    def test_dropped_record_cannot_certify_snapshot(self):
        original = self.sources[4]
        start, end = original.index(b'     <record>'), original.index(b'    </record>') + len(b'    </record>')
        changed = original[:start] + original[end:]
        # XML is still well formed; the pinned hash and exact regeneration must reject it.
        self.assertEqual(len(self.compiler.parse_registry(changed, 4)['records']), 24)
        with patch.object(Path, 'read_bytes', return_value=changed), self.assertRaises(self.compiler.SnapshotInvalid):
            self.compiler.compile_policy(ROOT, self.metadata)


if __name__ == '__main__':
    unittest.main()
