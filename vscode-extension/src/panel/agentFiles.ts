import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { workspaceRoot, workspaceSkillsDir } from '../instructions/paths';

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export type AgentFileResult =
  | { ok: true; id: string; label?: string }
  | { ok: false; error: string };

const DEFAULT_AGENT_BODY =
  '## Role\nDescribe what this agent does in one or two sentences.\n\n' +
  '## Instructions\n- Step 1: …\n- Step 2: …\n\n' +
  '## Output format\nExplain the structure of the response you want this agent to produce.';

/** Create a custom agent skill file in `.promptoptimizer/skills` and open it. */
export async function createAgentFile(agentName: string, agentContent: string): Promise<AgentFileResult> {
  const label = agentName.trim();
  if (label === '') { return { ok: false, error: 'Enter a name for the agent.' }; }

  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41);
  if (!AGENT_ID_RE.test(id)) { return { ok: false, error: 'Use a name with at least 2 letters or digits.' }; }

  const wsRoot = workspaceRoot();
  if (!wsRoot) { return { ok: false, error: 'Open a workspace folder first to save agents.' }; }

  const targetDir = workspaceSkillsDir(wsRoot);
  const targetPath = path.join(targetDir, `${id}.md`);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create skills folder.' };
  }
  if (fs.existsSync(targetPath)) {
    return { ok: false, error: `An agent with id "${id}" already exists.` };
  }

  const body = agentContent.trim();
  const hasFrontmatter = /^---\s*\n[\s\S]*?\n---/.test(body);
  const fileText = hasFrontmatter
    ? (body.endsWith('\n') ? body : `${body}\n`)
    : `---\nid: ${id}\nlabel: ${label}\nreadOnly: false\ntags: [custom]\n---\n\n# ${label}\n\n${body === '' ? DEFAULT_AGENT_BODY : body}\n`;

  try {
    fs.writeFileSync(targetPath, fileText, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not write agent file.' };
  }

  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    // Opening the file is best-effort; the agent is already saved.
  }
  return { ok: true, id, label };
}

/** Delete a previously-created custom agent skill file and close its editor tab. */
export async function deleteAgentFile(agentId: string): Promise<AgentFileResult> {
  const id = agentId.trim();
  if (!AGENT_ID_RE.test(id)) { return { ok: false, error: 'Invalid agent id.' }; }

  const wsRoot = workspaceRoot();
  if (!wsRoot) { return { ok: false, error: 'No workspace folder is open.' }; }

  const targetPath = path.join(workspaceSkillsDir(wsRoot), `${id}.md`);
  if (!fs.existsSync(targetPath)) { return { ok: false, error: `Agent "${id}" no longer exists.` }; }

  try {
    fs.unlinkSync(targetPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not delete the agent file.' };
  }

  // Close the editor tab if the freshly-created file is still open.
  try {
    const uri = vscode.Uri.file(targetPath);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === uri.fsPath) {
        await vscode.window.showTextDocument(editor.document, editor.viewColumn);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
  } catch {
    // Best-effort; the file is already deleted.
  }
  return { ok: true, id };
}
