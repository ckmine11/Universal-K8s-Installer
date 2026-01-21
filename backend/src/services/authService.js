import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../utils/cryptoUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '../../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = getJwtSecret();

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
        return this.users.length === 0;
    }

    async registerAdmin(username, password) {
        if (this.users.length > 0) {
            throw new Error('Admin already registered. Use login.');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: 'admin',
            username,
            password: hashedPassword,
            role: 'admin',
            createdAt: new Date().toISOString()
        };

        this.users.push(newUser);
        this.saveUsers();

        return this.generateToken(newUser);
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
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
    }

    verifyToken(token) {
        try {
            return jwt.verify(token, JWT_SECRET);
        } catch (error) {
            return null;
        }
    }
}

export const authService = new AuthService();
