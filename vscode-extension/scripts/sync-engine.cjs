const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const sourceDist = path.join(repoRoot, 'dist');
const rootNodeModules = path.join(repoRoot, 'node_modules');
const targetEngineRoot = path.join(extensionRoot, 'engine');
const targetDist = path.join(targetEngineRoot, 'dist');
const targetNodeModules = path.join(targetEngineRoot, 'node_modules');

if (!fs.existsSync(sourceDist)) {
  throw new Error(`Engine build output not found: ${sourceDist}`);
}

fs.rmSync(targetEngineRoot, { recursive: true, force: true });
fs.mkdirSync(targetDist, { recursive: true });
fs.cpSync(sourceDist, targetDist, { recursive: true });

// Copy runtime dependencies (native modules cannot be bundled).
const runtimeDeps = ['better-sqlite3', 'gpt-tokenizer', 'bindings', 'file-uri-to-path'];
fs.mkdirSync(targetNodeModules, { recursive: true });
for (const dep of runtimeDeps) {
  const src = path.join(rootNodeModules, dep);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(targetNodeModules, dep), { recursive: true });
  }
}

fs.writeFileSync(
  path.join(targetEngineRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'prompt-proxy-engine-runtime',
      private: true,
      type: 'module',
    },
    null,
    2
  ) + '\n',
  'utf8'
);

console.log(`Synced engine runtime to ${targetDist}`);