import * as vscode from 'vscode';

import { ocrImage as runOcrOnBuffer } from '../chat/ocr';
import { runEngineRawAsync } from '../engine/runner';
import { seedCacheFromWorkspace } from '../engine/seeder';
import { SECRET_PATTERNS } from '../security/secret-patterns';
import { getDbPath } from '../state/config';
import type { CustomSecretPatternConfig } from '../types';
import { computeWorkspaceId } from '../util/workspace';

/** Query the engine for workspace index counters and post them to the panel. */
export async function sendStatusOverview(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): Promise<void> {
  try {
    const dbPath = getDbPath(context);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsId = computeWorkspaceId(wsRoot);
    const args = ['--status-overview', '--workspace', wsId, '--db', dbPath];
    // Pass the root too so the engine can transparently fall back to legacy
    // workspace ids (drive-letter casing / pre-canonicalization) and never
    // shows phantom zeros right after an extension update.
    if (wsRoot) { args.push('--workspace-root', wsRoot); }
    const raw = await runEngineRawAsync(args);
    webview.postMessage({ type: 'statusOverview', payload: JSON.parse(raw) });
  } catch (err) {
    // Non-fatal, but visible: a silent failure leaves the panel looking like
    // every counter is 0 even when the DB is populated.
    webview.postMessage({
      type: 'statusOverviewError',
      message: err instanceof Error ? err.message : 'Could not read workspace index status.',
    });
  }
}

/** Re-seed the workspace index, then push fresh counters to the panel. */
export async function refreshOverview(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Prompt Optimizer: refreshing index…' },
      async () => { await seedCacheFromWorkspace(context, { force: true, skipChatHistory: true }); },
    );
  } catch {
    // Non-fatal: still re-read whatever the engine can report.
  } finally {
    await sendStatusOverview(context, webview);
    webview.postMessage({ type: 'overviewRefreshed' });
  }
}

/** Push the current secret-detection settings into the panel overlay. */
export function sendSecretSettings(webview: vscode.Webview): void {
  const cfg = vscode.workspace.getConfiguration('promptProxy');
  webview.postMessage({
    type: 'secretSettingsState',
    enabled: cfg.get<boolean>('enableSecretDetection') !== false,
    customPatterns: cfg.get<CustomSecretPatternConfig[]>('secretPatterns') ?? [],
    builtinLabels: SECRET_PATTERNS.map((s) => s.label),
  });
}

/** Persist secret-detection settings posted from the panel overlay. */
export async function saveSecretSettings(
  webview: vscode.Webview,
  data: { enabled?: boolean; customPatterns?: CustomSecretPatternConfig[] },
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('promptProxy');
  await cfg.update('enableSecretDetection', data.enabled === true, vscode.ConfigurationTarget.Global);
  await cfg.update('secretPatterns', data.customPatterns ?? [], vscode.ConfigurationTarget.Global);
  webview.postMessage({ type: 'secretSettingsSaved' });
}

/**
 * Decode the base64 image payload posted by the webview, run it through
 * Tesseract OCR (fully offline), and ship the extracted text back. The
 * webview correlates responses to requests via the `id` field.
 */
export async function handleOcrImage(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  data: { id?: string; name?: string; dataBase64?: string },
): Promise<void> {
  const id = data.id;
  if (!id || !data.dataBase64) {
    if (id) {
      webview.postMessage({ type: 'ocrImageResult', id, ok: false, error: 'invalid payload' });
    }
    return;
  }
  try {
    const buffer = Buffer.from(data.dataBase64, 'base64');
    if (buffer.length === 0) {
      webview.postMessage({ type: 'ocrImageResult', id, ok: false, error: 'empty image' });
      return;
    }
    const text = await runOcrOnBuffer(context, buffer);
    webview.postMessage({ type: 'ocrImageResult', id, ok: true, name: data.name, text: text ?? '' });
  } catch (err) {
    webview.postMessage({
      type: 'ocrImageResult',
      id,
      ok: false,
      error: err instanceof Error ? err.message : 'OCR failed',
    });
  }
}
