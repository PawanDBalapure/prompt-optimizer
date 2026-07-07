import * as vscode from 'vscode';

import { runEngineRaw } from '../../engine/runner';
import { workspaceRoot } from '../../instructions/paths';

export interface InstructionStudioPreset {
  id: string;
  category: string;
  label: string;
  workflowName: string;
  persona: string;
  condition: string;
  priority: string;
  agentScope: string;
  ruleText: string;
}

/** Post bundled presets merged with workspace custom personas. */
export async function postPresets(webview: vscode.Webview): Promise<void> {
  try {
    const wsRoot = workspaceRoot();
    const raw = runEngineRaw(['--instruction-studio-presets']);
    const payload = JSON.parse(raw) as { presets?: InstructionStudioPreset[] };
    let merged = payload.presets ?? [];
    if (wsRoot) {
      const customRaw = runEngineRaw(['--instruction-studio-personas-list', '--workspace-root', wsRoot]);
      const customPayload = JSON.parse(customRaw) as { personas?: InstructionStudioPreset[] };
      merged = [...merged, ...(customPayload.personas ?? [])];
    }
    await webview.postMessage({ type: 'presets', presets: merged });
  } catch {
    await webview.postMessage({ type: 'presets', presets: [] });
  }
}

/** Post the workspace's user-defined studio personas. */
export async function postCustomPersonas(webview: vscode.Webview): Promise<void> {
  const wsRoot = workspaceRoot();
  if (!wsRoot) {
    await webview.postMessage({ type: 'customPersonas', personas: [] });
    return;
  }
  try {
    const raw = runEngineRaw(['--instruction-studio-personas-list', '--workspace-root', wsRoot]);
    const payload = JSON.parse(raw) as { personas?: InstructionStudioPreset[] };
    await webview.postMessage({ type: 'customPersonas', personas: payload.personas ?? [] });
  } catch {
    await webview.postMessage({ type: 'customPersonas', personas: [] });
  }
}

/** Persist a custom persona via the engine CLI. Throws on failure. */
export function saveCustomPersona(persona: unknown): void {
  const wsRoot = workspaceRoot();
  if (!wsRoot) { throw new Error('Open a workspace folder first.'); }
  runEngineRaw(
    ['--instruction-studio-persona-save', '--workspace-root', wsRoot],
    JSON.stringify(persona ?? {}),
  );
}

/** Delete a custom persona by id via the engine CLI. Throws on failure. */
export function deleteCustomPersona(id: string): void {
  const wsRoot = workspaceRoot();
  if (!wsRoot) { throw new Error('Open a workspace folder first.'); }
  runEngineRaw([
    '--instruction-studio-persona-delete', '--workspace-root', wsRoot, '--id', id.trim(),
  ]);
}

/** Static presets for the "load popular repo" quick action. */
export function popularRepoPresets(repo: string): InstructionStudioPreset[] {
  if (repo === 'react') {
    return [{ id: 'react-1', category: 'React', label: 'Hooks Rules', ruleText: 'Rules of Hooks MUST be followed. No conditional hooks.', workflowName: 'React Flow', persona: 'React Core', condition: 'If file is a component', priority: 'High', agentScope: 'Review' }];
  }
  if (repo === 'nextjs') {
    return [{ id: 'next-1', category: 'Next.js', label: 'Server Components', ruleText: 'Use "use server" by default. Only use "use client" when reactivity is needed.', workflowName: 'Next.js Flow', persona: 'Vercel Expert', condition: 'Always', priority: 'High', agentScope: 'Code Generation' }];
  }
  if (repo === 'linux') {
    return [{ id: 'linux-1', category: 'Linux', label: 'Kernel Style', ruleText: 'Indent with tabs, 8 characters. Maximum line length is 80 columns.', workflowName: 'Linux Flow', persona: 'Kernel Hacker', condition: 'Always', priority: 'Critical', agentScope: 'Review' }];
  }
  return [];
}
