import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../utils/cryptoUtils.js';
import { randomUUID as uuidv4 } from 'crypto';
import { mailConfigured, mailError } from '../utils/mailer.js';
import { welcomeEmail, resetCodeEmail, passwordChangedEmail, sendAccountEmail, sendAccountEmailLater } from '../utils/accountEmails.js';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { DATA_DIR } from '../utils/paths.js';
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = getJwtSecret();
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
// bcrypt hash of a random string — compared against when the username does not exist
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
const MAX_RESET_ATTEMPTS = 5;
const hashResetCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const RESET_RESEND_MS = 60 * 1000;   // one reset email per account per minute
const RESET_TICKET_TTL_MS = 10 * 60 * 1000;   // to set the password after the code was verified

class AuthService {
    constructor() {
        this.users = [];
        this._failures = new Map(); // username → { count, until } (login lockout)
        this.loadUsers();
    }

    loadUsers() {
        try {
            if (fs.existsSync(USERS_FILE)) {
                const data = fs.readFileSync(USERS_FILE, 'utf8');
                this.users = JSON.parse(data);
                
                // Quick migration: Ensure all existing users have an orgId
                let modified = false;
                this.users.forEach((u) => {
                    if (!u.orgId) {
                        u.orgId = uuidv4();
                        modified = true;
                    }
                });
                // Legacy self-hosted data from before roles existed: make the first
                // account Super Admin ONLY if there is none at all. Never in SaaS —
                // there a deleted first account would hand the platform to a customer.
                if (process.env.KUBEEZ_MODE !== 'saas' && this.users.length && !this.users.some(u => u.role === 'superadmin')) {
                    this.users[0].role = 'superadmin';
                    modified = true;
                }
                if (modified) this.saveUsers();
            }
        } catch (error) {
            console.error('Error loading users:', error);
            this.users = [];
        }
    }

    saveUsers() {
        writeFileAtomicSync(USERS_FILE, JSON.stringify(this.users, null, 2));
    }

    isSetupRequired() {
        if (process.env.KUBEEZ_MODE === 'saas') {
            return false;
        }
        return this.users.length === 0;
    }

    // { setup: true } only from the one-time /api/auth/setup of a self-hosted
    // server — that first account becomes the platform Super Admin. Every other
    // sign-up is the admin of its own new workspace. SaaS Super Admins are made
    // with scripts/make-superadmin.js, never by signing up.
    async registerUser(username, password, email, { setup = false } = {}) {
        const existing = this.users.find(u => u.username.toLowerCase() === username.toLowerCase() || (u.email && email && u.email.toLowerCase() === email.toLowerCase()));
        if (existing) {
            throw new Error('Username or email is already taken');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Every new registration is a Tenant Admin with a unique orgId
        // BUT the very first user is the Global Super Admin
        const role = (setup && this.users.length === 0 && process.env.KUBEEZ_MODE !== 'saas') ? 'superadmin' : 'admin';
        const orgId = uuidv4();

        const newUser = {
            id: uuidv4(),
            orgId,
            username,
            email,
            password: hashedPassword,
            role,
            subscription: { plan: 'FREE', maxClusters: 1, maxNodes: 2, maxMembers: 1 },
            createdAt: new Date().toISOString()
        };

        this.users.push(newUser);
        this.saveUsers();
        sendAccountEmailLater(email, welcomeEmail(newUser), 'welcome');

        return this.generateToken(newUser);
    }

    async createTeamMember(adminOrgId, username, password, email, role = 'viewer') {
        const existing = this.users.find(u => u.username.toLowerCase() === username.toLowerCase() || (u.email && email && u.email.toLowerCase() === email.toLowerCase()));
        if (existing) {
            throw new Error('Username or email is already taken');
        }

        // Validate role — only assignable workspace roles are allowed here
        const allowedRoles = ['admin', 'operator', 'viewer'];
        if (!allowedRoles.includes(role)) {
            throw new Error(`Invalid role. Choose one of: ${allowedRoles.join(', ')}`);
        }

        // Enforce the plan's team-member seat limit (counts ALL users in the org)
        const orgAdmin = this.getOrgOwner(adminOrgId)
        const maxMembers = orgAdmin?.subscription?.maxMembers ?? 1
        const currentCount = this.users.filter(u => u.orgId === adminOrgId).length
        if (currentCount >= maxMembers) {
            throw new Error(`Team seat limit reached (${maxMembers}). Upgrade your plan to add more members.`)
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = {
            id: uuidv4(),
            orgId: adminOrgId,
            username,
            email,
            password: hashedPassword,
            role,
            subscription: { plan: 'MEMBER', maxClusters: 0, maxNodes: 0 },
            createdAt: new Date().toISOString()
        };

        this.users.push(newUser);
        this.saveUsers();
        return newUser;
    }

    async registerAdmin(username, password, email) {
        return this.registerUser(username, password, email);
    }

    // An account by what people type on the login page: the username (any
    // case) or the email address. Usernames and emails are unique ignoring case.
    findByLogin(identifier) {
        const id = String(identifier || '').trim();
        if (!id) return null;
        const lower = id.toLowerCase();
        return this.users.find(u => u.username === id)
            || this.users.find(u => u.username.toLowerCase() === lower)
            || (id.includes('@') ? this.users.find(u => u.email && u.email.toLowerCase() === lower) : null)
            || null;
    }

    async login(username, password) {
        const name = String(username || '').trim()
        const user = this.findByLogin(name);
        // one counter per account, whether the username or the email was typed
        const lockKey = (user ? user.username : name).toLowerCase();

        // Per-account lockout: 10 wrong passwords → 15 minutes (on top of the
        // per-IP limit, which a distributed attack would get around)
        const lock = this._failures.get(lockKey);
        if (lock && lock.until > Date.now()) {
            throw new Error('Too many failed attempts for this account. Try again in 15 minutes.');
        }

        // Always run one bcrypt comparison, so the response time does not reveal
        // whether the username exists
        const isMatch = await bcrypt.compare(String(password || ''), user ? user.password : DUMMY_HASH);
        if (!user || !isMatch) {
            const f = this._failures.get(lockKey) || { count: 0, until: 0 };
            f.count += 1;
            if (f.count >= 10) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
            this._failures.set(lockKey, f);
            throw new Error('Invalid credentials');
        }
        this._failures.delete(lockKey);
        if (user.isSuspended) throw new Error('This account is suspended. Contact your administrator.');

        return this.generateToken(user);
    }

    generateToken(user) {
        return jwt.sign(
            { id: user.id, username: user.username, email: user.email, role: user.role, orgId: user.orgId },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
    }

    // Set a new password. Sessions issued before this moment stop working
    // (a leaked password or an admin reset logs everyone else out).
    async setPassword(user, plain) {
        user.password = await bcrypt.hash(plain, 10);
        user.passwordChangedAt = Math.floor(Date.now() / 1000);
        this.saveUsers();
    }

    verifyToken(token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = this.getUserById(decoded.id);
            if (!user || user.isSuspended) {
                return null;
            }
            if (user.passwordChangedAt && decoded.iat < user.passwordChangedAt) {
                return null; // issued before the last password change
            }
            // Authorize with the CURRENT stored role/org — not the values baked
            // into the token — so demotions and role changes apply immediately.
            return {
                ...decoded,
                username: user.username,
                email: user.email,
                role: user.role,
                orgId: user.orgId
            };
        } catch (error) {
            console.error('JWT Verification Failed:', error.message)
            return null;
        }
    }

    // ─── Super Admin Functions ────────────────────────────────────────

    // Strip password hash + reset state before anything leaves the service
    toSafeUser(u) {
        const { password, resetToken, resetTokenExpiry, resetAttempts, ...safeUser } = u;
        return safeUser;
    }

    getAllUsers() {
        return this.users.map(u => {
            const { password, resetToken, resetTokenExpiry, ...safeUser } = u;
            return safeUser;
        });
    }

    updateUserStatus(id, isSuspended) {
        const user = this.getUserById(id);
        if (user) {
            user.isSuspended = isSuspended;
            this.saveUsers();
            return this.toSafeUser(user);
        }
        throw new Error('User not found');
    }

    deleteUser(id) {
        const idx = this.users.findIndex(u => u.id === id);
        if (idx === -1) throw new Error('User not found');
        const [removed] = this.users.splice(idx, 1);
        this.saveUsers();
        const { password, resetToken, resetTokenExpiry, ...safe } = removed;
        return safe;
    }

    updateUserRole(id, role) {
        const user = this.getUserById(id);
        if (user) {
            user.role = role;
            this.saveUsers();
            return this.toSafeUser(user);
        }
        throw new Error('User not found');
    }

    getUserById(id) {
        return this.users.find(u => u.id === id);
    }

    // Resolve a workspace's plan from its owner (the admin/superadmin account
    // that holds the subscription). Team members have plan 'MEMBER', so we must
    // look at the org owner to know the real plan for feature gating.
    getOrgOwner(orgId) {
        if (!orgId) return undefined
        // Prefer the account that actually holds a (non-MEMBER) subscription
        return this.users.find(u => u.orgId === orgId && (u.role === 'admin' || u.role === 'superadmin')
                && String(u.subscription?.plan || 'FREE').toUpperCase() !== 'MEMBER')
            || this.users.find(u => u.orgId === orgId && (u.role === 'admin' || u.role === 'superadmin'))
            || this.users.find(u => u.orgId === orgId && String(u.subscription?.plan || '').toUpperCase() !== 'MEMBER')
    }

    getOrgPlan(orgId) {
        return String(this.getOrgOwner(orgId)?.subscription?.plan || 'FREE').toUpperCase()
    }

    getUsersByOrgId(orgId) {
        return this.users.filter(u => u.orgId === orgId).map(u => {
            const { password, resetToken, resetTokenExpiry, ...safeUser } = u;
            return safeUser;
        });
    }

    updateUserSubscription(id, plan, maxClusters, maxNodes, maxMembers, billing) {
        const user = this.getUserById(id);
        if (!user) throw new Error('User not found');

        const planU = String(plan).toUpperCase();
        // Sensible team-seat default per plan when not explicitly provided
        const seats = (maxMembers != null && maxMembers !== '')
            ? parseInt(maxMembers)
            : (planU === 'ENTERPRISE' ? 9999 : planU === 'PRO' ? 5 : 1);

        const sub = { plan, maxClusters, maxNodes, maxMembers: seats };

        // Enterprise billing record (negotiated deal) — tracked for the superadmin
        if (billing && (billing.amount || billing.paymentLink || billing.notes)) {
            const cycle = billing.cycle === 'annual' ? 'annual' : 'monthly';
            const days = cycle === 'annual' ? 365 : 30;
            sub.billing = {
                amount: billing.amount || '',
                cycle,
                currency: billing.currency || 'USD',
                paymentLink: billing.paymentLink || '',
                notes: billing.notes || '',
                provisionedAt: new Date().toISOString()
            };
            sub.billingCycle = cycle;
            sub.renewsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        } else if (planU === 'PRO') {
            sub.billingCycle = 'monthly';
            sub.renewsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        }

        user.subscription = sub;
        this.saveUsers();
        return this.toSafeUser(user);
    }

    /**
     * Send a 6-digit reset code to the account's email. Who asked is never
     * revealed (same answer for unknown accounts). Throws NO_SMTP when this
     * server cannot send email, so the page can say what to do instead.
     */
    async forgotPassword(identifier) {
        if (!mailConfigured()) {
            throw Object.assign(new Error('Password reset by email is not set up on this server. Ask your workspace admin to reset your password (Team & Roles), or the server owner can run: node scripts/reset-password.js <username> <new-password>'), { code: 'NO_SMTP' });
        }
        const user = this.findByLogin(identifier);
        if (!user || !user.email || user.isSuspended) return true;
        // Resend protection: a new code at most once a minute per account
        if (user.resetRequestedAt && Date.now() - user.resetRequestedAt < RESET_RESEND_MS) return true;

        // A cryptographically random 6-digit code. Only its hash is stored; it's
        // bound to this account and burns after MAX_RESET_ATTEMPTS.
        const resetCode = crypto.randomInt(100000, 1000000).toString();
        user.resetToken = hashResetCode(resetCode);
        user.resetTokenExpiry = Date.now() + RESET_CODE_TTL_MS;
        user.resetAttempts = 0;
        user.resetRequestedAt = Date.now();
        this.saveUsers();

        try {
            await sendAccountEmail(user.email, resetCodeEmail(user, resetCode));
        } catch (error) {
            // Undo, so a later attempt is not blocked by the resend limit
            user.resetToken = undefined; user.resetTokenExpiry = undefined; user.resetAttempts = undefined; user.resetRequestedAt = undefined;
            this.saveUsers();
            console.error('[auth] reset email failed:', mailError(error));
            throw Object.assign(new Error('The reset email could not be sent right now. Please try again in a few minutes.'), { code: 'MAIL_FAILED' });
        }
        return true;
    }

    // Check a reset code; wrong guesses count, and after MAX_RESET_ATTEMPTS the
    // code burns (a new one must be requested).
    _checkResetCode(user, code) {
        const invalid = Object.assign(new Error('Wrong or expired code — check the latest email, or send a new code.'), { code: 'BAD_CODE' });
        if (!user || !user.resetToken || !(user.resetTokenExpiry > Date.now())) throw invalid;
        const given = Buffer.from(hashResetCode(String(code ?? '').trim()), 'hex');
        const stored = Buffer.from(user.resetToken, 'hex');
        if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
            user.resetAttempts = (user.resetAttempts || 0) + 1;
            const left = MAX_RESET_ATTEMPTS - user.resetAttempts;
            if (left <= 0) {
                user.resetToken = undefined; user.resetTokenExpiry = undefined; user.resetAttempts = undefined;
                this.saveUsers();
                throw Object.assign(new Error('Too many wrong codes — this code no longer works. Send a new code.'), { code: 'CODE_BURNED' });
            }
            this.saveUsers();
            throw Object.assign(invalid, { attemptsLeft: left });
        }
    }

    /**
     * Step 2 of forgot password: the emailed code is right. It is used up and
     * swapped for a one-time ticket (10 min) that allows setting the password.
     */
    verifyResetCode(identifier, code) {
        const user = this.findByLogin(identifier);
        this._checkResetCode(user, code);
        const ticket = crypto.randomBytes(32).toString('hex');
        user.resetToken = undefined; user.resetTokenExpiry = undefined; user.resetAttempts = undefined;
        user.resetTicket = hashResetCode(ticket);
        user.resetTicketExpiry = Date.now() + RESET_TICKET_TTL_MS;
        this.saveUsers();
        return ticket;
    }

    /** Step 3: new password with the ticket from step 2 (or, older clients, the code itself). */
    async resetPassword(identifier, { ticket, code } = {}, newPassword) {
        const user = this.findByLogin(identifier);
        if (ticket) {
            const ok = user?.resetTicket && user.resetTicketExpiry > Date.now() && (() => {
                const g = Buffer.from(hashResetCode(String(ticket)), 'hex'), st = Buffer.from(user.resetTicket, 'hex');
                return g.length === st.length && crypto.timingSafeEqual(g, st);
            })();
            if (!ok) throw Object.assign(new Error('This reset session expired — start again with Forgot Password.'), { code: 'BAD_TICKET' });
        } else {
            this._checkResetCode(user, code);
        }

        user.resetToken = undefined; user.resetTokenExpiry = undefined; user.resetAttempts = undefined;
        user.resetRequestedAt = undefined; user.resetTicket = undefined; user.resetTicketExpiry = undefined;
        await this.setPassword(user, newPassword);   // ends every older session
        this._failures.delete(user.username.toLowerCase());   // the lockout is over too
        // Tell the owner (best effort) — a reset they did not do is a warning sign
        sendAccountEmailLater(user.email, passwordChangedEmail(user), 'password-changed');
        return true;
    }
}

export const authService = new AuthService();
