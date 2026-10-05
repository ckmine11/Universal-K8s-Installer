import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../utils/cryptoUtils.js';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { DATA_DIR } from '../utils/paths.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = getJwtSecret();
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;
const hashResetCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

class AuthService {
    constructor() {
        this.users = [];
        this.loadUsers();
    }

    loadUsers() {
        try {
            if (fs.existsSync(USERS_FILE)) {
                const data = fs.readFileSync(USERS_FILE, 'utf8');
                this.users = JSON.parse(data);
                
                // Quick migration: Ensure all existing users have an orgId
                let modified = false;
                this.users.forEach((u, index) => {
                    if (!u.orgId) {
                        u.orgId = uuidv4();
                        modified = true;
                    }
                    // The first user in the system is always the Super Admin
                    if (index === 0 && u.role !== 'superadmin') {
                        u.role = 'superadmin';
                        modified = true;
                    }
                });
                if (modified) this.saveUsers();
            }
        } catch (error) {
            console.error('Error loading users:', error);
            this.users = [];
        }
    }

    saveUsers() {
        fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
    }

    isSetupRequired() {
        if (process.env.KUBEEZ_MODE === 'saas') {
            return false;
        }
        return this.users.length === 0;
    }

    async registerUser(username, password, email) {
        const existing = this.users.find(u => u.username.toLowerCase() === username.toLowerCase() || (u.email && email && u.email.toLowerCase() === email.toLowerCase()));
        if (existing) {
            throw new Error('Username or email is already taken');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Every new registration is a Tenant Admin with a unique orgId
        // BUT the very first user is the Global Super Admin
        const role = this.users.length === 0 ? 'superadmin' : 'admin';
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

    async login(username, password) {
        const user = this.users.find(u => u.username === username);
        if (!user) {
            throw new Error('Invalid credentials');
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            throw new Error('Invalid credentials');
        }

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

    async forgotPassword(email) {
        const user = this.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
        if (!user) {
            // Return success even if not found to prevent email enumeration
            return true;
        }

        // Generate a cryptographically random 6-digit code. Only its hash is
        // stored; it's bound to this email and burns after MAX_RESET_ATTEMPTS.
        const resetCode = crypto.randomInt(100000, 1000000).toString();

        user.resetToken = hashResetCode(resetCode);
        user.resetTokenExpiry = Date.now() + RESET_CODE_TTL_MS;
        user.resetAttempts = 0;

        this.saveUsers();

        try {
            await transporter.sendMail({
                from: process.env.EMAIL_FROM || process.env.SMTP_USER,
                to: email,
                subject: 'KubeEZ - Password Reset Code',
                text: `Your password reset code is: ${resetCode}\n\nThis code is valid for 15 minutes.`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                        <h2 style="color: #3b82f6;">KubeEZ Platform</h2>
                        <p>We received a request to reset your password.</p>
                        <p>Your 6-digit reset code is:</p>
                        <h1 style="background: #f4f4f5; padding: 10px 20px; text-align: center; letter-spacing: 5px; color: #18181b; border-radius: 5px;">${resetCode}</h1>
                        <p style="color: #71717a; font-size: 12px; margin-top: 20px;">This code will expire in 15 minutes. If you did not request this, please ignore this email.</p>
                    </div>
                `
            });
            console.log(`Reset code sent to ${email}`);
        } catch (error) {
            console.error('Error sending reset email:', error);
            throw new Error('Failed to send reset email. Please try again later.');
        }

        return true;
    }

    async resetPassword(email, token, newPassword) {
        const invalid = new Error('Invalid or expired reset code');
        const user = this.users.find(u => u.email && u.email.toLowerCase() === String(email).toLowerCase());
        if (!user || !user.resetToken || !(user.resetTokenExpiry > Date.now())) {
            throw invalid;
        }

        const given = Buffer.from(hashResetCode(String(token)), 'hex');
        const stored = Buffer.from(user.resetToken, 'hex');
        if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
            user.resetAttempts = (user.resetAttempts || 0) + 1;
            if (user.resetAttempts >= MAX_RESET_ATTEMPTS) {
                // Burn the code — the user must request a new one
                user.resetToken = undefined;
                user.resetTokenExpiry = undefined;
                user.resetAttempts = undefined;
            }
            this.saveUsers();
            throw invalid;
        }

        user.resetToken = undefined;
        user.resetTokenExpiry = undefined;
        user.resetAttempts = undefined;
        await this.setPassword(user, newPassword);
        return true;
    }
}

export const authService = new AuthService();
