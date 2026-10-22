/**
 * Which history rows start a turn. CLIs write injected context (reminders, environment blocks, slash-command receipts)
 * into history as "user" rows; only what a person wrote, a slash command or a background-task notice starts a turn.
 * Shared by the Sessions page and the Worker, so both agree where a turn begins (the Worker looks back for the prompt of
 * a turn that starts before the page it returns).
 */
/** CLIs write injected context (system reminders, environment blocks, slash-command receipts) into history as "user" messages; only the words the person typed are a prompt. */
export const INJECTED=/<(system-reminder|user_info|environment_context|local-command-stdout|local-command-caveat|command-message|command-args|skill_metadata|available_skills|task-notification)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi;
/** A background task's completion notice: shown as one quiet system line, never as a prompt bubble. */
export const taskNotificationOf=text=>String(text||'').match(/<task-notification>[\s\S]*?<task-id>\s*([^<]+?)\s*<\/task-id>/i)?.[1]||'';
/** The prompt text a person wrote: injected context, pictures, slash-command tags and the attached-files note removed. */
export const cleanUserText=text=>String(text||'').replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi,'').replace(/\[Image: source:[^\]]*\]/g,'').replace(INJECTED,'').replace(/<command-name>[\s\S]*?<\/command-name>/gi,'').replace(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/i,'$1').replace(/\n*Attached files for this message \(local paths\):[\s\S]*$/,'').trim();
/** A slash command's name, when the row records one. */
export const commandOf=text=>String(text||'').match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i)?.[1]||'';
/** Claude Code's context compaction writes its summary into history as a "user" row; older Workers do not flag it, so the opening sentence identifies it too. */
export const isCompactSummary=(text,flag=false)=>flag===true||/^\s*This session is being continued from a previous conversation that ran out of context\./.test(String(text||''));
/** Whether a history "user" row starts a turn. A background task's completion notice does not: Claude Code writes it as a
 * "user" row, but it belongs to the turn that is running, so the page shows it as a line inside that turn. */
export const isHistoryPrompt=text=>Boolean(cleanUserText(text)||commandOf(text));
