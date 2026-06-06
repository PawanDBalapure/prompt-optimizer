import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { parseCopilotInstructionsCanvas } from '../panel/canvasGraphParser';

export function runCanvasTests(workspaceRoot: string) {
  console.log('Running Canvas Graph Parser tests...');

  // Setup mock file
  const mockFilePath = path.join(workspaceRoot, 'copilot-instructions.md');
  const childMockPath = path.join(workspaceRoot, 'child-instructions.md');
  
  fs.writeFileSync(mockFilePath, `
# Main Instructions
- Do not use global state.
See child-instructions.md
  `);
  
  fs.writeFileSync(childMockPath, `
# Child Rules
- Keep dependencies minimal.
  `);

  const result = parseCopilotInstructionsCanvas(workspaceRoot);
  
  assert.ok(result.nodes.length >= 4, 'Should parse base nodes and child nodes');
  assert.ok(result.nodes.some(n => n.text === 'Do not use global state.'), 'Should parse main rules');
  assert.ok(result.nodes.some(n => n.text === 'Keep dependencies minimal.'), 'Should parse recursive child rules');
  assert.ok(result.edges.length > 0, 'Should build edges');

  // Clean up
  try {
    fs.unlinkSync(mockFilePath);
    fs.unlinkSync(childMockPath);
  } catch (e) {
    // Ignore cleanup errors
  }

  console.log('Canvas Graph Parser tests passed.');
}
