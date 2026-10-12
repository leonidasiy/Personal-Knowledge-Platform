"""Offline compiler for the retained, hash-pinned IANA XML; never fetches resources."""
import argparse
import datetime as dt
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

NAMESPACE = 'http://www.iana.org/assignments'
TAG = '{' + NAMESPACE + '}'
ROOT = Path(__file__).resolve().parent


class SnapshotInvalid(ValueError):
    """The retained source cannot certify an address policy."""


class NoDoctype(ET.TreeBuilder):
    def doctype(self, name, public_id, system_id):
        raise SnapshotInvalid('xml-doctype-forbidden')


def require(condition, context):
    if not condition:
        raise SnapshotInvalid(context)


def text(element):
    return ''.join(element.itertext()).strip()


def _canonical_address(address):
    """Numeric serialization: dotted IPv4; lowercase hex IPv6, including mapped.

    Compress only the leftmost longest run of at least two zero hextets.
    """
    value = int(address)
    if address.version == 4:
        return '.'.join(str((value >> shift) & 255) for shift in (24, 16, 8, 0))
    expanded = ':'.join(f'{(value >> shift) & 0xffff:x}' for shift in range(112, -1, -16))
    zeros = max(re.finditer(r'(?:^|:)0(?::0)+(?=:|$)', expanded), key=lambda match: match.group().count('0'), default=None)
    return expanded if zeros is None else expanded[:zeros.start()].rstrip(':') + '::' + expanded[zeros.end():].lstrip(':')


def parse_registry(data: bytes, family: int):
    require(family in (4, 6), 'registry-family')
    require(isinstance(data, bytes) and 0 < len(data) <= 1048576, 'xml-byte-limit')
    try:
        decoded = data.decode('utf-8')
        require('\x00' not in decoded and '<!DOCTYPE' not in decoded and '<!ENTITY' not in decoded, 'xml-declarations-forbidden')
        # ElementTree ignores stylesheet/model PIs and does not load schemas,
        # XInclude, or remote resources. Reject DTDs before entity expansion.
        root = ET.fromstring(decoded, parser=ET.XMLParser(target=NoDoctype()))
    except (UnicodeError, ET.ParseError) as error:
        raise SnapshotInvalid('xml-invalid') from error
    identity = f'iana-ipv{family}-special-registry'
    require(root.tag == TAG + 'registry' and root.attrib == {'id': identity}, 'registry-identity')
    for element in root.iter():
        require(element.tag.startswith(TAG), 'xml-namespace')
    require(all(child.tag[len(TAG):] in {'title', 'category', 'created', 'updated', 'registry', 'footnote', 'people'} for child in root), 'registry-schema')
    for name in ('title', 'category', 'created'):
        require(len(root.findall(TAG + name)) == 1 and text(root.find(TAG + name)), 'registry-metadata')
    revisions = root.findall(TAG + 'updated')
    require(len(revisions) == 1, 'registry-revision')
    revision = text(revisions[0])
    try:
        require(dt.date.fromisoformat(revision).isoformat() == revision, 'registry-revision')
    except ValueError as error:
        raise SnapshotInvalid('registry-revision') from error
    tables = root.findall(TAG + 'registry')
    require(len(tables) == 1 and tables[0].attrib == {'id': identity + '-1'}, 'registry-table')
    table = tables[0]
    require(all(child.tag[len(TAG):] in {'title', 'xref', 'registration_rule', 'note', 'record'} for child in table), 'table-schema')
    records = []
    seen = set()
    for record in table.findall(TAG + 'record'):
        fields = {child.tag[len(TAG):]: child for child in record}
        required = {'address', 'name', 'spec', 'allocation', 'source', 'destination', 'forwardable', 'global', 'reserved'}
        require(len(fields) == len(record) and required <= fields.keys() and fields.keys() <= required | {'termination'}, 'record-fields')
        require(record.attrib.keys() <= {'date', 'updated'}, 'record-attributes')
        references = [{'type': x.attrib.get('type'), 'data': x.attrib.get('data')} for x in fields['spec']]
        require(references and all(x.tag == TAG + 'xref' and x.attrib.get('type') in {'rfc', 'rfc-errata'} and re.fullmatch(r'rfc[0-9]+|[0-9]+', x.attrib.get('data', '')) for x in fields['spec']), 'record-references')
        for name in required - {'spec'}:
            require(all(x.tag == TAG + 'xref' and x.attrib.get('type') == 'note' and x.attrib.get('data') for x in fields[name]), 'record-markup')
        blocks = []
        for value in text(fields['address']).split(','):
            try:
                network = ipaddress.ip_network(value.strip(), strict=True)
            except ValueError as error:
                raise SnapshotInvalid('record-cidr') from error
            first = _canonical_address(network.network_address)
            cidr = f'{first}/{network.prefixlen}'
            require(network.version == family and cidr not in seen, 'record-family-or-duplicate')
            seen.add(cidr)
            blocks.append({'cidr': cidr, 'first': first, 'last': _canonical_address(network.broadcast_address)})
        flags = {name: text(fields[name]) for name in ('source', 'destination', 'forwardable', 'global', 'reserved')}
        require(all(value in {'True', 'False', 'N/A', ''} for value in flags.values()), 'record-flags')
        require(text(fields['name']) and text(fields['allocation']), 'record-metadata')
        records.append({'blocks': blocks, 'name': text(fields['name']), 'references': references,
                        'allocation': text(fields['allocation']), 'termination': text(fields['termination']) if 'termination' in fields else None,
                        'attributes': record.attrib, 'flags': flags})
    require(records, 'registry-empty')
    return {'revision': revision, 'title': text(root.find(TAG + 'title')),
            'created': text(root.find(TAG + 'created')), 'category': text(root.find(TAG + 'category')), 'records': records,
            'recordCount': len(records), 'prefixCount': len(seen)}


def compile_policy(directory: Path, metadata):
    require(isinstance(metadata, dict), 'snapshot-metadata')
    sources = metadata.get('sources')
    require(isinstance(sources, list) and len(sources) == 2 and all(isinstance(item, dict) for item in sources) and [item.get('family') for item in sources] == [4, 6], 'snapshot-families')
    config = metadata.get('conservativeConfig')
    require(isinstance(config, dict) and set(config) == {'ipv4Multicast', 'ipv6Envelope'}, 'conservative-config')
    for key, cidr, reference in [('ipv4Multicast', '224.0.0.0/4', 'https://www.rfc-editor.org/rfc/rfc1112#section-4'), ('ipv6Envelope', '2000::/3', 'https://www.rfc-editor.org/rfc/rfc4291#section-2.4')]:
        require(isinstance(config[key], dict) and config[key].get('cidr') == cidr and config[key].get('source') == reference and config[key].get('basis'), 'conservative-contract')
    registries = []
    for source in sources:
        identity = f"iana-ipv{source['family']}-special-registry"
        require(source.get('url') == f'https://www.iana.org/assignments/{identity}/{identity}.xml' and source.get('file') == identity + '.xml', 'snapshot-location')
        try:
            data = (directory / source['file']).read_bytes()
        except OSError as error:
            raise SnapshotInvalid('snapshot-unavailable') from error
        require(source.get('sha256') == hashlib.sha256(data).hexdigest() and source.get('bytes') == len(data), 'snapshot-integrity')
        parsed = parse_registry(data, source['family'])
        retrieved = source.get('retrievedAt')
        require(isinstance(retrieved, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', retrieved), 'snapshot-retrieval-utc')
        try:
            instant = dt.datetime.fromisoformat(retrieved.replace('Z', '+00:00'))
            require(dt.date.fromisoformat(parsed['revision']) <= instant.date() and instant <= dt.datetime.now(dt.timezone.utc), 'snapshot-retrieval-date')
        except ValueError as error:
            raise SnapshotInvalid('snapshot-retrieval-date') from error
        registries.append({**source, **parsed})
    return {'policy': 'deny-all-registered-special-purpose-prefixes', 'conservativeConfig': config, 'registries': registries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='Generate locally; never retrieve or widen the prior exclusion set.')
    args = parser.parse_args()
    try:
        generated = compile_policy(ROOT, json.loads((ROOT / 'snapshots.json').read_text()))
        output = json.dumps(generated, indent=2) + '\n'
        destination = ROOT / 'policy.json'
        if args.write:
            if destination.exists():
                previous = json.loads(destination.read_text())
                require(len(previous['registries']) == len(generated['registries']), 'registry-exclusion-removed')
                for old, new in zip(previous['registries'], generated['registries']):
                    retained = [ipaddress.ip_network(block['cidr']) for record in new['records'] for block in record['blocks']]
                    require(old['family'] == new['family'] and all(any(ipaddress.ip_network(block['cidr']).subnet_of(network) for network in retained) for record in old['records'] for block in record['blocks']), 'registry-exclusion-removed')
            destination.write_text(output)
        else:
            require(destination.read_text() == output, 'generated-policy-drift')
    except (SnapshotInvalid, OSError, json.JSONDecodeError) as error:
        parser.exit(1, f'SnapshotInvalid: {error}\n')
    print('PASS: retained source hashes, metadata and exact offline policy')


if __name__ == '__main__':
    main()
