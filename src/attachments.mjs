import { mkdir, open, rename, unlink, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export const ATTACHMENT_COUNT = 6;
const idPattern = /^[a-f0-9-]{36}$/;

/** Attachments are stored per project; the file name is for display only, and the on-disk path is determined entirely by the server-side ID. */
export class Attachments {
  constructor(db, directory) { this.db = db; this.directory = directory; }
  async upload(projectId, req) {
    if (!this.db.get('projects', projectId)) throw new Error('Project not found');
    const name = decodeURIComponent(req.headers['x-file-name'] || 'attachment').replace(/[\x00-\x1f/\\]/g, '_').slice(0, 180);
    if (Number(req.headers['content-length']) > ATTACHMENT_LIMIT) throw new Error('Each attachment must be at most 20 MB');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID(), temp = join(this.directory, `${id}.part`), destination = join(this.directory, id), hash = createHash('sha256');
    const handle = await open(temp, 'wx', 0o600);
    let size = 0, magic = Buffer.alloc(0), renamed = false;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > ATTACHMENT_LIMIT) throw new Error('Each attachment must be at most 20 MB');
        if (magic.length < 16) magic = Buffer.concat([magic, chunk]).subarray(0, 16);
        hash.update(chunk); await handle.writeFile(chunk);
      }
      if (!size) throw new Error('Empty files cannot be uploaded');
      await handle.close();
      await rename(temp, destination);
      renamed = true;
      // Only recognized raster images can be previewed inline; HTML, SVG, and the like are always served as download attachments.
      const mime = magic.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) ? 'image/png'
        : magic[0] === 255 && magic[1] === 216 && magic[2] === 255 ? 'image/jpeg'
        : /^GIF8[79]a/.test(magic.toString('ascii')) ? 'image/gif'
        : magic.toString('ascii',0,4) === 'RIFF' && magic.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : 'application/octet-stream';
      return this.db.put('attachments', { id, projectId, name: name || 'attachment', mime, size, sha256: hash.digest('hex'), createdAt: new Date().toISOString() });
    } catch (e) { await handle.close().catch(()=>{}); await unlink(renamed ? destination : temp).catch(()=>{}); throw e; }
  }
  /** A message only accepts IDs that were uploaded and belong to the current project; the client cannot forge file paths. */
  resolve(projectId, ids = []) {
    if (!Array.isArray(ids) || ids.length > ATTACHMENT_COUNT || new Set(ids).size !== ids.length) throw new Error('Each message allows at most 6 distinct attachments');
    return ids.map(id => {
      const item = idPattern.test(id) && this.db.get('attachments', id);
      if (!item || item.projectId !== projectId) throw new Error('Attachment does not exist or does not belong to the current project');
      return item;
    });
  }
  async read(projectId, id) {
    const [item] = this.resolve(projectId, [id]);
    return { item, bytes: await readFile(join(this.directory, id)) };
  }
}

/** The user transfers files explicitly, without creating a task or starting a model; a retry after failure reuses the same batch directory. */
export class AttachmentTransfers {
  constructor({db,attachments,query,online,change=()=>{}}) { Object.assign(this,{db,attachments,query,online,change});this.active=new Map(); }
  async copy(projectId,{clientTransferId,nodeId,attachmentIds}) {
    if(!idPattern.test(clientTransferId || ''))throw new Error('Invalid attachment transfer ID');
    const items=this.attachments.resolve(projectId,attachmentIds);
    if(!items.length)throw new Error('Select an attachment');
    const fingerprint=JSON.stringify({projectId,nodeId,attachmentIds});
    const prior=this.db.get('attachmentTransfers',clientTransferId);
    if(prior && prior.fingerprint!==fingerprint)throw new Error('A repeated transfer ID has different parameters');
    if(prior?.status==='completed')return prior;
    if(this.active.has(clientTransferId))return this.active.get(clientTransferId);
    const binding=this.db.get('workspaces',`${projectId}:${nodeId}`),worker=this.db.get('workers',nodeId);
    if(!binding?.localRoot || !worker)throw new Error('Prepare the project directory on the target device in project settings first');
    if(!this.online(nodeId))throw new Error('Target device is offline; bring it online and retry');
    if(worker.capabilities?.attachmentTransfer!==1)throw new Error('Upgrade the target device Worker to support file transfer first');
    if(this.db.get('settings','main')?.paused)throw new Error('Remote operations are paused');
    const record={id:clientTransferId,projectId,nodeId,attachmentIds,fingerprint,workspace:prior?.workspace||binding.localRoot,status:'transferring',createdAt:prior?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(prior && prior.workspace!==binding.localRoot)throw new Error('The project directory has changed; create the transfer again');
    this.db.put('attachmentTransfers',record);this.change();
    const transfer=Promise.resolve().then(async()=>{
      try {
        const result=await this.query({nodeId},'attachments_receive',{projectId,transferId:record.id,workspace:record.workspace,items},items.length*65000+10000);
        if(!Array.isArray(result?.files)||result.files.length!==items.length||items.some(a=>!result.files.some(f=>f.id===a.id&&f.sha256===a.sha256&&f.size===a.size&&typeof f.path==='string')))throw new Error('The attachment confirmation returned by the target device is incomplete');
        return this.db.put('attachmentTransfers',{...record,status:'completed',files:result.files,updatedAt:new Date().toISOString()});
      } catch(error) { this.db.put('attachmentTransfers',{...record,status:'failed',error:error.message,updatedAt:new Date().toISOString()});throw error; }
      finally { this.active.delete(record.id);this.change(); }
    });
    this.active.set(record.id,transfer);return transfer;
  }
}

/** Verify level by level that the temporary directory is still inside the project, so symlinked directories never lead to writes in another workspace. */
async function temporaryDirectory(workspace,id) {
  const root=await realpath(workspace);let directory=root;
  for(const part of ['.workbench','tmp','attachments',id]) {
    const next=join(directory,part);
    await mkdir(next,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    directory=await realpath(next);
    const rel=relative(root,directory);
    if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('Attachment temporary directory escapes the project');
  }
  return directory;
}

/** The Worker downloads from Home the attachments this Run explicitly references, and hands them to the CLI only after verifying integrity. */
export async function receiveAttachments({ items = [], workspace, runId, transferId, home, token }) {
  if (!items.length) return [];
  const batchId=transferId || runId;
  if (!idPattern.test(batchId) || items.length > ATTACHMENT_COUNT || new Set(items.map(a=>a.id)).size!==items.length) throw new Error('Invalid attachment run identity');
  const directory = await temporaryDirectory(workspace,batchId);
  const received = [];
  for (const item of items) {
    if (!idPattern.test(item.id) || !Number.isSafeInteger(item.size) || item.size<1 || item.size > ATTACHMENT_LIMIT || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || typeof item.name!=='string') throw new Error('Invalid attachment information');
    const endpoint=transferId?'attachment-transfers':'attachments';
    const response = await fetch(new URL(`/api/agent/${endpoint}/${batchId}/${item.id}`, home), {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`Attachment download failed: ${item.name} (${response.status})`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > ATTACHMENT_LIMIT) throw new Error('Attachment download exceeds the size limit'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (size !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Attachment verification failed');
    const sanitized = item.name.replace(/[^\p{L}\p{N}._-]/gu, '_');
    const extension = /\.[\p{L}\p{N}]{1,16}$/u.exec(sanitized)?.[0] || '';
    const stem=extension?sanitized.slice(0,-extension.length):sanitized;
    // Linux/macOS file names are limited by bytes; the UUID prefix and a non-ASCII name together are kept within 255 bytes.
    let safeName='';
    for(const char of stem){if(Buffer.byteLength(safeName+char+extension)>180)break;safeName+=char;}
    safeName=(safeName||'attachment')+extension;
    const path = join(directory, `${item.id}-${safeName}`);
    const temp=join(directory,`${item.id}-${randomUUID()}.part`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes);await handle.close();await rename(temp,path); }
    catch(error) { await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});throw error; }
    received.push({ ...item, path });
  }
  return received;
}
