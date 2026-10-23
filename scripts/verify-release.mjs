import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const config=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')),version=config.version;
const folder=resolve(`release-output/v${version}`),file=resolve(folder,`Soumissions-et-factures_${version}_x64-setup.exe`);
const out=resolve(process.argv.find(arg=>arg.startsWith('--out='))?.slice(6)||`docs/releases/${version}`);await mkdir(out,{recursive:true});
const signatureText=(await readFile(file+'.sig','utf8')).trim();
const lines=Buffer.from(signatureText,'base64').toString('utf8').trim().split(/\r?\n/);
const publicLines=Buffer.from(config.plugins.updater.pubkey,'base64').toString('utf8').trim().split(/\r?\n/);
const publicBytes=Buffer.from(publicLines[1],'base64'),signature=Buffer.from(lines[1],'base64');
assert.equal(publicBytes.length,42);assert.equal(signature.length,74);assert.equal(signature.subarray(0,2).toString(),'ED');
assert.ok(publicBytes.subarray(2,10).equals(signature.subarray(2,10)));
const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicBytes.subarray(10)]),format:'der',type:'spki'});
const blake=createHash('blake2b512'),sha=createHash('sha256');let bytes=0;
for await(const chunk of createReadStream(file)){blake.update(chunk);sha.update(chunk);bytes+=chunk.length;}
const digest=blake.digest();assert.ok(verify(null,digest,key,signature.subarray(10)));
assert.ok(lines[2].startsWith('trusted comment: '));
assert.ok(verify(null,Buffer.concat([signature.subarray(10),Buffer.from(lines[2].slice(17))]),key,Buffer.from(lines[3],'base64')));
const corrupted=Buffer.from(digest);corrupted[0]^=1;assert.equal(verify(null,corrupted,key,signature.subarray(10)),false);
const receipt={version,bytes,sha256:sha.digest('hex'),signatureVerified:true,tamperRejected:true};
await writeFile(resolve(out,'signature-receipt.json'),JSON.stringify(receipt,null,2));
console.log('LOCAL_SIGNED_INSTALLER_VERIFIED version='+version+' bytes='+bytes);
if(process.argv.includes('--public')) {
  const get=async url=>{const r=await fetch(url,{headers:{'User-Agent':'Hermitage-release-verification'},signal:AbortSignal.timeout(30000)});assert.ok(r.ok,'HTTP '+r.status+' '+url);return r;};
  const release=await(await get('https://api.github.com/repos/foodcel/invoice-company-app/releases/latest')).json();
  assert.equal(release.tag_name,'v'+version);assert.equal(release.draft,false);assert.equal(release.prerelease,false);
  const local=JSON.parse(await readFile(resolve(folder,'latest.json'),'utf8'));
  const manifest=await(await get(config.plugins.updater.endpoints[0])).json();assert.deepEqual(manifest,local);
  const platform=manifest.platforms['windows-x86_64'],asset=release.assets.find(a=>a.browser_download_url===platform.url);assert.ok(asset);
  assert.equal(asset.size,bytes);assert.equal(platform.signature,signatureText);
  const sigAsset=release.assets.find(a=>a.name===asset.name+'.sig');assert.ok(sigAsset);
  assert.equal((await(await get(sigAsset.browser_download_url)).text()).trim(),signatureText);
  const head=await fetch(platform.url,{method:'HEAD',signal:AbortSignal.timeout(30000)});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes);
  let hash=asset.digest?.replace(/^sha256:/,'');
  if(!hash){const streamHash=createHash('sha256');for await(const chunk of(await get(platform.url)).body)streamHash.update(chunk);hash=streamHash.digest('hex');}
  assert.equal(hash,receipt.sha256);assert.equal(release.assets.length,3);
  await writeFile(resolve(out,'public-receipt.json'),JSON.stringify({...receipt,published:true,url:release.html_url,feedVersion:manifest.version,publicDigestMatches:true,installerHTTP:head.status},null,2));
  console.log('PUBLIC_RELEASE_VERIFIED '+release.html_url);
}
