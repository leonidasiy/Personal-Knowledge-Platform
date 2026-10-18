import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createLocalApplication } from './application.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const port=8787;
const origin=process.env.LOCAL_ORIGIN??`http://127.0.0.1:${port}`;
const dataDirectory=resolve(root,'.private/local');
await access(join(root,'dist/index.html')).catch(()=>{throw new Error('Build the app first: deno task build');});
await mkdir(dataDirectory,{recursive:true,mode:0o700});
const lockPath=join(dataDirectory,'server.lock');
try{const previous=Number(await readFile(lockPath,'utf8'));try{process.kill(previous,0);throw new Error('Another local server is using this data directory. Stop it before restarting.');}catch(error){if(error.code!=='ESRCH')throw error;}await unlink(lockPath);}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(lockPath,String(process.pid),{flag:'wx',mode:0o600});
let application;
try{
  application=await createLocalApplication({root,dataDirectory,password:process.env.LOCAL_PASSWORD,origin,port,environment:process.env});
  const server=createServer(async(incoming,outgoing)=>{
    try{
      const request=new Request(new URL(incoming.url??'/',origin),{method:incoming.method,headers:incoming.headers,body:['GET','HEAD'].includes(incoming.method)?undefined:Readable.toWeb(incoming),duplex:'half'});
      const response=await application.fetch(request);
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)Readable.fromWeb(response.body).pipe(outgoing);else outgoing.end();
    }catch{console.error(JSON.stringify({event:'local-request-failure'}));if(!outgoing.headersSent)outgoing.writeHead(500,{'content-type':'text/plain'});outgoing.end('The request failed. Check the local server log.');}
  });
  server.requestTimeout=120_000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await application.start();
  console.info(`Resonance is running at ${origin}. Keep this window open. Press Ctrl+C to stop.`);
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;server.closeAllConnections();server.close();await application.close();await unlink(lockPath);process.exit(0);};
  process.once('SIGINT',close);process.once('SIGTERM',close);
}catch(error){await application?.close();await unlink(lockPath);throw error;}
