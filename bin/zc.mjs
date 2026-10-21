#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  console.error('ZC requires Node.js 22.16 or newer. Install a supported Node.js LTS release.');
  process.exitCode = 1;
} else {
  const { main } = await import('../src/cli.mjs');
  await main();
}
