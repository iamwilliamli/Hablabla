import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = 'FluidInference/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b-CoreML';
const revision = '1a41b75758b0337ff67db7d5408280aaaf23074e';
const prefix = 'multilingual/2240ms/';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(root, '.data/models/nemotron-3.5-multilingual/2240ms');
const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/${revision}/multilingual/2240ms?recursive=true`);
if (!response.ok) throw new Error(`Model manifest failed: HTTP ${response.status}`);
if (response.headers.has('link')) throw new Error('Unexpected manifest pagination; inspect before installing.');
const files = (await response.json()).filter(item => item.type === 'file');
function hashFor(item) {
  const hash = createHash(item.lfs ? 'sha256' : 'sha1');
  if (!item.lfs) hash.update(`blob ${item.size}\0`);
  return hash;
}
function expectedHash(item) { return item.lfs?.oid || item.oid; }
async function valid(item,path) {
  try {
    if ((await stat(path)).size !== item.size) return false;
    const hash = hashFor(item); for await(const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === expectedHash(item);
  } catch { return false; }
}
console.log(`Installing ${repo}@${revision}\nFull multilingual vocabulary, 2240 ms tier\n${target}`);
let index = 0;
// Publish metadata last so a partial download is never advertised as configured.
files.sort((a,b) => Number(a.path.endsWith('/metadata.json')) - Number(b.path.endsWith('/metadata.json')));
const metadata = files.pop();
if (!metadata.path.endsWith('/metadata.json')) throw new Error('Metadata missing');
async function install(item) {
  if (!item.path.startsWith(prefix) || item.path.split('/').includes('..')) throw new Error('Invalid manifest path');
  const path = resolve(target,item.path.slice(prefix.length)); await mkdir(dirname(path),{recursive:true});
  if (await valid(item,path)) { console.log(`Verified cache: ${item.path}`); return; }
  for(let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${item.path}`,{signal:AbortSignal.timeout(600000)});
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const hash = hashFor(item); let bytes = 0;
      await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}}),createWriteStream(path+'.partial',{mode:0o600}));
      if(bytes !== item.size || hash.digest('hex') !== expectedHash(item)) throw new Error('Model integrity check failed');
      await rename(path+'.partial',path); console.log(`Verified download: ${item.path} (${bytes} bytes)`); return;
    } catch(error) { if(attempt===3) throw error; console.log(`Retry ${attempt}: ${item.path}`); await new Promise(r=>setTimeout(r,1000)); }
  }
}
await Promise.all(Array.from({length:4},async()=>{while(index<files.length)await install(files[index++]);}));
await install(metadata);
const info=JSON.parse(await readFile(resolve(target,'metadata.json'),'utf8'));
if(info.model!=='nvidia/nemotron-3.5-asr-streaming-0.6b'||info.vocab_size!==13087||info.chunk_mel_frames!==224) throw new Error('Unexpected model variant');
await writeFile(resolve(target,'hablabla-provenance.json'),JSON.stringify({repo,revision,variant:'multilingual/2240ms',files:files.length+1,verifiedAt:new Date().toISOString()},null,2));
console.log('Nemotron 3.5 multilingual 2240 ms installed and verified.');
