import { createHash, generateKeyPairSync, randomBytes, scryptSync, timingSafeEqual, sign } from 'node:crypto';

export function createLocalAuth({database,password,origin,port,now=Date.now}) {
  if(typeof password!=='string'||password.length<16||/^(change|replace|example|your[-_ ]?password)/iu.test(password))throw new Error('Set LOCAL_PASSWORD to a unique password of at least 16 characters in .env.local.');
  let publicOrigin;
  try{publicOrigin=new URL(origin);}catch{throw new Error('LOCAL_ORIGIN must be a valid localhost or private HTTPS origin.');}
  if(publicOrigin.origin!==origin || publicOrigin.username || publicOrigin.password || !(
    publicOrigin.protocol==='https:' || publicOrigin.origin===`http://127.0.0.1:${port}` || publicOrigin.origin===`http://localhost:${port}`
  ))throw new Error('LOCAL_ORIGIN must be the localhost address or the exact private HTTPS address used by your phone.');
  const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`,publicOrigin.host]);
  const allowedOrigins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`,origin]);
  const salt=randomBytes(32), passwordDigest=scryptSync(password,salt,32);
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const kid=randomBytes(16).toString('hex');
  const issuer='https://local-resonance.invalid',audience='local-resonance';
  const jwk={...publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'};
  const {sqlite}=database;
  sqlite.exec('CREATE TABLE IF NOT EXISTS local_sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL) STRICT');
  sqlite.exec('DELETE FROM local_sessions');
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const cookieName='resonance_local_session';
  const cookie=request=>request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  const cookieHeader=(request,value,age)=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${publicOrigin.protocol==='https:'&&(request.headers.get('host')===publicOrigin.host||request.headers.get('origin')===origin)?'; Secure':''}`;
  const response=(body,status=200,headers={})=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",...headers}});
  const page=message=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in to Resonance</title><main><h1>Sign in to Resonance</h1><p>${message}</p><form method="post" action="/local/login"><label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label><button>Sign in</button></form></main></html>`;
  let failures=0,windowStart=now();
  return {
    issuer,audience,jwksUrl:`${issuer}/cdn-cgi/access/certs`,jwks:{keys:[jwk]},
    assertion(){
      const base64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
      const input=`${base64({alg:'RS256',kid})}.${base64({iss:issuer,aud:audience,email:'owner@local.invalid',exp:Math.floor(now()/1000)+300})}`;
      return `${input}.${sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;
    },
    async authorize(request){
      if(!allowedHosts.has(request.headers.get('host')))return response('Unrecognized host.',403);
      const pathname=new URL(request.url).pathname;
      const suppliedOrigin=request.headers.get('origin');
      if((suppliedOrigin&&!allowedOrigins.has(suppliedOrigin))||(!['GET','HEAD','OPTIONS'].includes(request.method)&&!suppliedOrigin))return response('Open the application at its configured address and try again.',403);
      if(pathname==='/local/login') {
        if(request.method==='GET')return response(page('Use the password from your private .env.local file.'));
        if(request.method!=='POST')return response('Method not allowed.',405);
        if(now()-windowStart>=900_000){failures=0;windowStart=now();}
        if(failures>=10)return response(page('Too many failed attempts. Try again in 15 minutes.'),429);
        const reader=request.body?.getReader();
        const chunks=[];let length=0;
        if(reader)for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>4096){await reader.cancel();return response('Login request is too large.',413);}chunks.push(value);}
        const content=Buffer.concat(chunks).toString('utf8');
        const value=new URLSearchParams(content).get('password')??'';
        const digest=scryptSync(value,salt,32);
        if(!timingSafeEqual(digest,passwordDigest)){failures++;return response(page('Password was not recognized.'),401);}
        failures=0;
        sqlite.prepare('DELETE FROM local_sessions WHERE expires<=?').run(now());
        const session=randomBytes(32).toString('base64url'),age=30*24*60*60;
        sqlite.prepare('INSERT INTO local_sessions VALUES (?,?)').run(hash(session),now()+age*1000);
        return response('',303,{location:'/', 'set-cookie':cookieHeader(request,session,age)});
      }
      const session=cookie(request);
      const valid=typeof session==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(session)&&sqlite.prepare('SELECT 1 FROM local_sessions WHERE digest=? AND expires>?').get(hash(session),now());
      if(!valid)return pathname.startsWith('/api/')?new Response(JSON.stringify({error:'LocalSignInRequired'}),{status:401,headers:{'content-type':'application/json','cache-control':'no-store'}}):response('',303,{location:'/local/login'});
      if(pathname==='/local/logout'&&request.method==='POST'){
        sqlite.prepare('DELETE FROM local_sessions WHERE digest=?').run(hash(session));
        return response('',303,{location:'/local/login','set-cookie':cookieHeader(request,'',0)});
      }
      return null;
    },
  };
}
