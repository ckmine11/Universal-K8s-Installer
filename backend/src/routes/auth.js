import express from 'express'
import { authService } from '../services/authService.js'

const router = express.Router()

// Check if initial setup is needed
router.get('/status', (req, res) => {
    res.json({ setupRequired: authService.isSetupRequired() })
})

// First-time admin setup (only works once)
router.post('/setup', async (req, res) => {
    try {
        const { username, password } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' })
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

        const result = await authService.registerAdmin(username, password)
        res.json({ token: result.token, user: { username, role: 'admin' } })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// User registration (open signup)
router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' })
        if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' })
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, - and _' })

        const result = await authService.register(username, password)
        res.json({ token: result.token, user: { username: result.user.username, role: result.user.role } })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// Login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body
        const result = await authService.login(username, password)
        res.json({ token: result.token, user: { username: result.user.username, role: result.user.role } })
    } catch (e) {
        res.status(401).json({ error: e.message })
    }
})

export default router
