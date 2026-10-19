# Actual Mac-local file viewing and shared document access

Status: implemented and deployed locally and on one remote Worker. Actual-Mac reading was verified both with an isolated Linux Home and on the active service. Activation and measured boundaries are recorded in design-source-sync section 13.6.
The single synchronization contract is [design-source-sync, section 13](design-source-sync.md#13-unified-continuous-project-file-synchronization). This document specifies only browser/file-reading integration and replaces the document-only synchronization and Home display-copy proposal.

## 1. Display device and intended result

Resources, Recent Outputs, document/file contents, displayed paths and Open project folder refer to the selected Mac's actual bound project directory. Persist its stable Worker ID as `displayNodeId`, independently of Home's host or a local/cloud icon. Moving Home does not change that identity or directory.

Source files, shared documents and resources reach the Mac through the unified project-file engine. Opening or refreshing the page may request its current state but is not required for synchronization. The page does not start a document-specific transfer queue.

The unshipped read-only cache prototype was removed. Shared documents use the existing file-transfer engine and direct Worker reads.

## 2. Local inventory and reading

Home validates the project/scope and requests inventory/content from the selected Mac Worker. That Worker resolves and reads the actual local file under the bound project. Home's transfer/recovery storage remains internal to synchronization and does not supply a long-lived browser display copy.

Reading does not depend on synchronization being enabled or having been configured. Prefer the saved display Mac; without it, exactly one registered Mac project binding is discoverable, whereas multiple candidates require explicit selection. Read scopes come from current project/repository bindings, including registered project-baseline directories and read-only repositories; they do not inherit write permission. Revalidate bindings after asynchronous reads and preserve exclusion, symlink and traversal protections. Disabled synchronization never makes an existing local file unreadable.

Resources discovers eligible actual Mac files, including `.workbench/docs/`, independently of recent Runs. Recent Outputs links verified output evidence to the same inventory without fabricating a modifier or Run. File type selects rendering, supported preview or download; it does not select another synchronization policy.

Recent Outputs queries a bounded set of Run evidence rather than replacing it with the alphabetic inventory. Successful completed file-write tools are labeled Write record; reply links are labeled Mentioned in reply and never identify a modifying CLI. Resolve both through scope/path mappings, show only confirmed actual Mac paths, and retain reference/record time separately from current file modification time. Cards distinguish local availability from disabled/pending synchronization, conflicts and read failures.

Keep preview limits distinct from transfer eligibility: a resource can synchronize successfully while being too large or unsupported for inline preview. Show that distinction.

## 3. Links and visible state

Recognize Markdown-linked paths, inline-code paths and ordinary explicit file paths in replies. Resolve them through the originating project's scope/path mapping to the Mac file. Leave code blocks and unrelated URLs unchanged. Authorization follows the project/scope, not an arbitrary path emitted by a model.

An absolute citation may name another registered device of the same project, even when the quoting Run executed on the Mac. Resolve such references only when their current registered scopes identify one scope/path pair; relative paths stay Run-local and ambiguous, escaped or isolated paths do not gain access. Private `.workbench` files outside `docs/` keep their original citation text with an unavailable-preview explanation rather than issuing repeated rejected reads. Files and stored messages are unchanged.

A server-only file shows Waiting for local synchronization until the Mac confirms the expected saved hash. Enable its local entry only after that receipt. Do not construct a local-looking path and imply the file already exists.

An existing Mac file remains viewable while remote changes are pending or conflicting, with its local version and pending/conflict state shown. Do not label remote bytes as Mac content. If the Mac is offline, show Local device offline; retain state metadata without substituting a Home-private content copy.

File details and Open project folder use the actual Mac path. Project switching and delayed responses cannot insert another project's file/path. Isolated worktree outputs remain isolated until controlled handoff/publication places them in the shared scope; do not redirect them to same-named Mac files.

## 4. Implementation boundary

Extend existing document/file authorization, Markdown links, workspace inspection and project configuration. Consume synchronization status, receipts and conflicts from the source-sync subsystem. Add no document-specific baseline, transfer, conflict record or receiving writer.

Preserve normal Run-document access. Shared/local project access uses an explicit bound-project route and must not expand a Run's permissions to arbitrary supplied roots. Enforce symlink/traversal/credential and cross-project checks on the Mac Worker.

The provisional `project-documents.mjs` copy service is not retained. Its early reading tests are not counted as bidirectional, browser or deployment acceptance.

## 5. Acceptance

- With all pages closed, save server code, a shared document and a necessary resource. Verify their actual Mac files arrive through the unified engine, then verify the page reads those exact files/paths. Repeat for a Mac edit reaching the server.
- Verify Resources and Recent Outputs discover shared documents independently of recent Run references.
- Open Markdown, inline-code and ordinary path references; verify the correct Mac file, while unrelated URLs and code blocks remain unchanged.
- Verify waiting, conflict, preview-unsupported and offline states without a fabricated local file or silent fallback.
- Put Home on another host in an isolated test and retain the selected Mac path and folder action.
- Verify English/Chinese, nested/non-ASCII names, duplicate filenames across scopes, project switching and delayed responses.
- Preserve normal Run reading and reject escaped/unbound paths. Report browser acceptance separately from physical transfer acceptance.

Synchronization policy and its measured acceptance boundary are maintained only in design-source-sync. Enabling a scope is distinct from installing the software; no page-private copy service is retained.
