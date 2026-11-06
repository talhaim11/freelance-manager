// Copies the previous app into the build output at /legacy/ (kept as a rollback option).
import { cpSync, existsSync, readdirSync } from 'node:fs';
if (!existsSync('dist-app/index.html')) throw new Error('build the app first (dist-app missing)');
cpSync('legacy', 'dist-app/legacy', { recursive: true, filter: (src) => !src.endsWith('.d.ts') });
console.log('legacy app copied to dist-app/legacy:', readdirSync('dist-app/legacy').join(', '));
