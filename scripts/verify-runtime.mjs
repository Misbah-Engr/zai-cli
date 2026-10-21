#!/usr/bin/env node
import { resolveRuntime } from '../src/runtime.mjs';
const runtime = resolveRuntime({ command: 'managed', args: [] });
if (!runtime.managed) throw new Error('Expected the managed runtime dependency.');
console.log(`Runtime package verified: zcode-app-cli ${runtime.version}`);
