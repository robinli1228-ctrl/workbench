// A sent video gets a video type, so the chat shows its first frame instead of a file card; other files stay downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Attachments} from '../src/attachments.mjs';

const ftyp=brand=>Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftyp'+brand),Buffer.alloc(32,1)]);
const request=(name,bytes)=>Object.assign(Readable.from([bytes]),{headers:{'x-file-name':encodeURIComponent(name),'content-length':String(bytes.length)}});

test('uploaded MP4, MOV and WebM are typed as video; a PNG stays an image and unknown bytes a download', async () => {
  const dir=await mkdtemp(join(tmpdir(),'wb-attach-'));
  try {
    const db=new Store(':memory:');db.put('projects',{id:'p1',name:'demo'});
    const attachments=new Attachments(db,dir),type=async(name,bytes)=>(await attachments.upload('p1',request(name,bytes))).mime;
    assert.equal(await type('clip.mp4',ftyp('isom')),'video/mp4');
    assert.equal(await type('clip.mov',ftyp('qt  ')),'video/quicktime');
    assert.equal(await type('clip.webm',Buffer.concat([Buffer.from('1a45dfa3','hex'),Buffer.alloc(32,1)])),'video/webm');
    assert.equal(await type('a.png',Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(32,1)])),'image/png');
    assert.equal(await type('song.m4a',ftyp('M4A ')),'application/octet-stream','audio is not a video');
    assert.equal(await type('notes.mp4',Buffer.from('not really a video at all')),'application/octet-stream','the bytes decide, not the name');
  } finally {await rm(dir,{recursive:true,force:true});}
});
