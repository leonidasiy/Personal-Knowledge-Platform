import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {Address4,Address6} from 'ip-address';

test('updated IP parser rejects ambiguous octets and recognizes the full IPv6 link-local range',()=>{
  assert.equal(Address4.isValid('010.0.0.1'),false);
  assert.equal(new Address6('febf::1').isLinkLocal(),true);
  assert.equal(new Address6('fe80::1').isLinkLocal(),true);
});

test('patched FTP parser retains the API used by get-uri and handles adversarial listings within the test deadline',{timeout:2000},async()=>{
  const require=createRequire(import.meta.url),fromGetUri=createRequire(require.resolve('get-uri'));
  const {Client,parseList}=fromGetUri('basic-ftp');
  assert.equal(fromGetUri('basic-ftp/package.json').version,'6.2.3');
  for(const method of ['access','lastMod','list','downloadTo','close'])assert.equal(typeof Client.prototype[method],'function');
  const entries=parseList('-rw-r--r-- 1 owner group 42 Jan 1 2020 file.txt');
  assert.equal(entries[0].name,'file.txt');assert.equal(entries[0].size,42);
  const output=execFileSync(process.execPath,['--input-type=module','-e',`import {parseList} from 'basic-ftp'; console.log(JSON.stringify(parseList('-rw-r--r-- 1 '+'a '.repeat(65536)+'!\\r\\n-rw-r--r-- 1 owner group 42 Jan 1 2020 file.txt\\r\\n').map(entry=>entry.name)));`],{timeout:1500,encoding:'utf8'});
  assert.deepEqual(JSON.parse(output),['file.txt']);
});
