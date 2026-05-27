const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const sourceDist = path.join(repoRoot, 'dist');
const targetEngineRoot = path.join(extensionRoot, 'engine');
const targetDist = path.join(targetEngineRoot, 'dist');

if (!fs.existsSync(sourceDist)) {
  throw new Error(`Engine build output not found: ${sourceDist}`);
}

fs.rmSync(targetEngineRoot, { recursive: true, force: true });
fs.mkdirSync(targetDist, { recursive: true });
fs.cpSync(sourceDist, targetDist, { recursive: true });
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