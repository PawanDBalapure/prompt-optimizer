import * as path from 'path';
import * as vscode from 'vscode';

import type { PromptProxyAnalysis } from '../types';

export function formatCurrency(value: number): string {
  return `$${value.toFixed(5)}`;
}

export function trimForDisplay(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

export function formatCacheStatus(
  status: PromptProxyAnalysis['cache']['status'],
  confidence: number,
): string {
  if (status === 'exact') { return 'exact cache hit'; }
  if (status === 'semantic') { return `semantic match (${Math.round(confidence * 100)}%)`; }
  return 'cache miss';
}

export function locationToText(location: vscode.Uri | vscode.Location): string {
  if (location instanceof vscode.Uri) {
    return location.toString();
  }
  return location.uri.toString();
}

export function toFileUri(filePath: string, workspaceRoot?: string): vscode.Uri | undefined {
  if (!filePath) {
    return undefined;
  }
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  if (workspaceRoot) {
    return vscode.Uri.file(path.resolve(workspaceRoot, filePath));
  }
  return undefined;
}
