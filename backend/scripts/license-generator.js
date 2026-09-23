import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_DIR = path.join(__dirname, 'vendor-keys');

// Ensure keys directory exists
if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
}

const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'private.pem');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'public.pem');

// 1. Generate RSA Key Pair if they don't exist
function generateKeys() {
    if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
        console.log('✅ Vendor Keys already exist.');
        return;
    }

    console.log('Generating 2048-bit RSA key pair for Enterprise Licensing...');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem'
        }
    });

    fs.writeFileSync(PRIVATE_KEY_PATH, privateKey);
    fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);

    console.log('🔐 Keys generated successfully!');
    console.log(`Private Key (KEEP SECRET): ${PRIVATE_KEY_PATH}`);
    console.log(`Public Key (SHIP WITH APP): ${PUBLIC_KEY_PATH}`);
    console.log('\n--- IMPORTANT ---');
    console.log('Copy the contents of public.pem to the KUBEEZ_LICENSE_PUBLIC_KEY environment variable in docker-compose.yml');
}

// 2. Generate a License JWT
function createLicense(plan, maxClusters, maxNodes, validityDays) {
    if (!fs.existsSync(PRIVATE_KEY_PATH)) {
        console.error('❌ Private key not found! Run with "generate-keys" first.');
        process.exit(1);
    }

    const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');

    // Create Payload
    const payload = {
        plan,
        maxClusters,
        maxNodes,
        issuer: 'KubeEZ-Vendor',
        issuedAt: new Date().toISOString()
    };

    // Sign JWT using RS256
    const token = jwt.sign(payload, privateKey, {
        algorithm: 'RS256',
        expiresIn: `${validityDays}d` // e.g., '365d'
    });

    console.log('\n======================================================');
    console.log('🎉 LICENSE GENERATED SUCCESSFULLY');
    console.log('======================================================');
    console.log(`Plan: ${plan}`);
    console.log(`Max Clusters: ${maxClusters}`);
    console.log(`Max Nodes: ${maxNodes}`);
    console.log(`Validity: ${validityDays} days`);
    console.log('\nCopy the License Key below and provide it to the customer:\n');
    console.log(token);
    console.log('\n======================================================\n');
}

// Simple CLI Router
const command = process.argv[2];

if (command === 'generate-keys') {
    generateKeys();
} else if (command === 'create-license') {
    const plan = process.argv[3] || 'PRO';
    const clusters = parseInt(process.argv[4] || '5', 10);
    const nodes = parseInt(process.argv[5] || '25', 10);
    const days = parseInt(process.argv[6] || '365', 10);
    createLicense(plan, clusters, nodes, days);
} else {
    console.log(`
KubeEZ Enterprise License Generator
-----------------------------------
Usage:

1. Generate Public/Private Keys (Do this once):
   node license-generator.js generate-keys

2. Create a License Key:
   node license-generator.js create-license [PLAN] [MAX_CLUSTERS] [MAX_NODES] [VALIDITY_DAYS]

Examples:
   node license-generator.js create-license ENTERPRISE 50 500 365
   node license-generator.js create-license PRO 5 25 30
    `);
}
