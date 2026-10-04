import { agentRequest } from './agent-bridge.mjs';

/** The catalog is open read-only to project roles; the supervisor identity for configuration writes is still verified by the server. */
async function request(pathname, input = {}) {
  if (!process.env.WB_HOME || !process.env.WB_RUN_ID) throw new Error('This command can only be used inside a valid workbench run session');
  return agentRequest(pathname, { ...input, runId: process.env.WB_RUN_ID });
}
export const setupCatalog = () => request('/api/agent/setup/catalog');
export const setupPropose = input => request('/api/agent/setup/propose', input);
export const updateRolePrompt = input => request('/api/agent/roles/prompt', input);
