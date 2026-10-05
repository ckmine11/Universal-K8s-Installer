/**
 * make-superadmin.js — ensure an account exists as a Super Admin.
 *
 * Usage:
 *   node scripts/make-superadmin.js <username> <password> [email]
 *
 * - If the user exists  → promotes to superadmin + resets the password.
 * - If the user is new  → creates the account as superadmin (Enterprise quotas).
 *
 * This is THE way to create the platform Super Admin in SaaS mode — public
 * sign-ups never become Super Admin there. Honors KUBEEZ_DATA_DIR and works on
 * a fresh server (no users.json yet).
 *
 * NOTE: The running backend caches users in memory, so after running this you
 * must RESTART the backend container for the change to take effect:
 *   docker compose -f docker-compose.prod.yml restart backend
 */
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { DATA_DIR } from '../src/utils/paths.js';
import { passwordProblem } from '../src/utils/passwordPolicy.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');

const [, , username, password, email = ''] = process.argv;

if (!username || !password) {
    console.error('Usage: node scripts/make-superadmin.js <username> <password> [email]');
    process.exit(1);
}

const problem = passwordProblem(password);
if (problem) {
    console.error(problem);
    process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) : [];
const hash = bcrypt.hashSync(password, 10);

let user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

if (user) {
    user.role = 'superadmin';
    user.password = hash;
    user.passwordChangedAt = Math.floor(Date.now() / 1000); // older sessions end
    user.isSuspended = false;
    if (email) user.email = email;
    console.log(`✅ Promoted existing account "${user.username}" to superadmin (password reset).`);
} else {
    user = {
        id: uuidv4(),
        orgId: uuidv4(),
        username,
        email,
        password: hash,
        role: 'superadmin',
        subscription: { plan: 'ENTERPRISE', maxClusters: 9999, maxNodes: 9999, maxMembers: 9999 },
        createdAt: new Date().toISOString()
    };
    users.push(user);
    console.log(`✅ Created new superadmin account "${username}".`);
}

fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
console.log('   Saved. Now RESTART the backend so the change loads into memory.');
