import {captureSourceSnapshot} from './source-sync-files.mjs';
import {entryEqual,validateSourcePath,manifestDigest,syncError} from './source-sync-manifest.mjs';

/** Compare the whole eligible repository against the pinned repair input, not a model-provided file list. */
export async function captureSourceCandidate({root,path,baseline,blobRoot}) {
  validateSourcePath(path);if(manifestDigest(baseline.entries)!==baseline.digest)throw syncError('source_input_changed');
  const captured=await captureSourceSnapshot({root,repositoryId:baseline.repositoryId,expectedHead:baseline.baseCommit,blobRoot});
  const changedPaths=[...new Set([...Object.keys(baseline.entries),...Object.keys(captured.entries)])].sort().filter(p=>!entryEqual(Object.hasOwn(baseline.entries,p)?baseline.entries[p]:null,Object.hasOwn(captured.entries,p)?captured.entries[p]:null));
  return {entry:Object.hasOwn(captured.entries,path)?captured.entries[path]:null,changedPaths,manifestHash:captured.digest};
}
