#!/usr/bin/env node
// Installer rollback helper: restore ZC preferences, never upstream credentials.
import { readFile } from 'node:fs/promises';
import { saveConfig } from '../src/config.mjs';
if (process.argv.length !== 3) throw new Error('Provide the previous ZC configuration file.');
const value = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
await saveConfig(value);
