import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'tests'];
const issues = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|vue|mjs|css)$/.test(entry.name)) continue;
    const content = fs.readFileSync(full, 'utf8');
    if (content.startsWith('\uFEFF')) {
      issues.push(`${full}: unexpected UTF-8 BOM`);
    }
    if (full.startsWith(`src${path.sep}`) && /\.(ts|vue)$/.test(entry.name)) {
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (/\bdebugger\b/.test(line)) {
          issues.push(`${full}:${index + 1}: unexpected debugger statement`);
        }
        if (/\bconsole\.log\s*\(/.test(line)) {
          issues.push(`${full}:${index + 1}: avoid console.log in production source`);
        }
      });
    }
  }
}

for (const root of roots) walk(root);

if (issues.length > 0) {
  console.error('Frontend static lint failed:\n' + issues.join('\n'));
  process.exit(1);
}
console.log('Frontend static lint passed.');
