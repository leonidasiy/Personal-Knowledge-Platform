import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import puppeteer from '@cloudflare/puppeteer';

test('installed dependency graph excludes the unused ZIP, FTP and proxy dependency chain',async()=>{
  const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
  for(const name of ['extract-zip','basic-ftp','ip-address','get-uri','proxy-agent','pac-proxy-agent']){
    assert(!Object.keys(lock.packages).some(path=>path.endsWith(`/node_modules/${name}`)||path===`node_modules/${name}`),`${name} must stay out of fresh installations.`);
  }
  const require=createRequire(import.meta.url),fromCloudflare=createRequire(require.resolve('@cloudflare/puppeteer'));
  assert.equal(fromCloudflare('@puppeteer/browsers/package.json').version,'3.2.5');
});

test('unchanged Cloudflare browser client still launches through its remote binding',async()=>{
  const requests=[];
  await assert.rejects(puppeteer.launch({fetch:async(url,init)=>{
    requests.push({url:String(url),method:init.method});
    return new Response('Synthetic capacity rejection',{status:429});
  }},{keep_alive:60000}),/Unable to create new browser: code: 429/);
  assert.deepEqual(requests,[{url:'https://fake.host/v1/devtools/browser?keep_alive=60000',method:'POST'}]);
});
