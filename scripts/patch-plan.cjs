// Validate version and generated filenames before formatting or applying patches.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, '../patches/manifest.json')));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
if (!plan.upstreamVersions.includes(version)) throw Error(`Unsupported upstream ${version}; supported: ${plan.upstreamVersions.join(', ')}`);
const seen = new Set();
for (const item of plan.patches) {
  for (const dep of item.after) if (!seen.has(dep)) throw Error(`${item.file}: dependency ${dep} must precede it`);
  const patch = fs.readFileSync(path.join(__dirname, '../patches', item.file), 'utf8');
  const targets = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1].trim());
  if (!targets.length) throw Error(`${item.file}: no targets`);
  for (const target of targets) {
    if (path.isAbsolute(target) || target.split('/').includes('..')) throw Error(`Unsafe patch target ${target}`);
    if (!fs.existsSync(path.join(root, target))) throw Error(`${item.file}: missing target ${target} in upstream ${version}`);
  }
  seen.add(item.file);
  console.log(`${item.file}: ${targets.join(', ')}${item.optional ? ' (optional)' : ''}`);
}
const script = fs.readFileSync(path.join(__dirname, 'prepare_asar'), 'utf8');
const applied = [...script.matchAll(/^\s*apply_patch_file patches\/(.+\.patch)$/gm)].map(m => m[1]);
if (JSON.stringify(applied) !== JSON.stringify(plan.patches.map(p => p.file))) throw Error('Patch manifest and worker order disagree');
