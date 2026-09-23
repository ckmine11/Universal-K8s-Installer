import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

// Ensure public directory exists
const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

async function buildAgent() {
    try {
        await esbuild.build({
            entryPoints: ['src/services/agent.js'],
            bundle: true,
            outfile: 'public/agent-bundle.js',
            platform: 'node',
            target: 'node18',
            format: 'cjs', // Node.js standalone executable prefers CommonJS for single files
            minify: true,
            // Keep native modules as external if any, but ws and node-ssh can usually be bundled
            // node-ssh might use some native bindings but typically ssh2 handles it
            external: ['ssh2', 'cpu-features'], 
        });
        console.log('✅ Gateway Agent bundled successfully to public/agent-bundle.js');
    } catch (err) {
        console.error('❌ Failed to bundle agent:', err);
        process.exit(1);
    }
}

buildAgent();
