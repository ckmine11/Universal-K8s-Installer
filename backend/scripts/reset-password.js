/**
 * reset-password.js — set a new password for any account (server owner only).
 *
 * Usage:
 *   node scripts/reset-password.js <username-or-email> <new-password>
 *
 * In Docker:
 *   docker exec -it kubeez-backend node scripts/reset-password.js <username-or-email> <new-password>
 *   docker compose -f docker-compose.prod.yml restart backend
 *
 * For when email (SMTP) is not set up and no workspace admin can reset it.
 * All older sessions of the account end, and its login lockout is cleared.
 * Honors KUBEEZ_DATA_DIR.
 *
 * NOTE: The running backend caches users in memory — RESTART it afterwards.
 */
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { DATA_DIR } from '../src/utils/paths.js';
import { passwordProblem } from '../src/utils/passwordPolicy.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const [, , identifier, password] = process.argv;

if (!identifier || !password) {
    console.error('Usage: node scripts/reset-password.js <username-or-email> <new-password>');
    process.exit(1);
}
const problem = passwordProblem(password);
if (problem) {
    console.error(problem);
    process.exit(1);
}
if (!fs.existsSync(USERS_FILE)) {
    console.error(`No accounts yet (${USERS_FILE} does not exist).`);
    process.exit(1);
}

const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const id = identifier.trim().toLowerCase();
const user = users.find(u => u.username.toLowerCase() === id) || users.find(u => u.email && u.email.toLowerCase() === id);
if (!user) {
    console.error(`No account with the username or email "${identifier}".`);
    process.exit(1);
}

user.password = bcrypt.hashSync(password, 10);
user.passwordChangedAt = Math.floor(Date.now() / 1000);   // older sessions end
delete user.resetToken; delete user.resetTokenExpiry; delete user.resetAttempts; delete user.resetRequestedAt;

const tmp = USERS_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
fs.renameSync(tmp, USERS_FILE);
console.log(`✅ New password set for "${user.username}"${user.email ? ` (${user.email})` : ''}.`);
console.log('   Restart the backend so it takes effect: docker compose -f docker-compose.prod.yml restart backend');
