import express from 'express';
import os from 'os';
import { BackupService } from '../services/backupService.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { authService } from '../services/authService.js';
import { canUseBackups } from '../config/planFeatures.js';

export const healthRouter = express.Router();

/**
 * Gate for the backups feature: must be an admin/superadmin AND on a paid plan.
 * Returns true if allowed; otherwise writes the appropriate response and returns false.
 */
function ensureBackupAccess(req, res) {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
        res.status(403).json({ error: 'Only workspace admins can manage backups' });
        return false;
    }
    // The workspace plan — a second admin of a Pro workspace has plan "MEMBER"
    const plan = authService.getOrgPlan(req.user.orgId);
    if (!canUseBackups(plan, req.user.role)) {
        res.status(402).json({
            error: 'Daily config backups & 1-click restore are a Pro feature. Upgrade to Pro to enable automatic backups.',
            upgradeRequired: true,
            feature: 'backups'
        });
        return false;
    }
    return true;
}

/**
 * Basic health check endpoint
 * GET /api/health
 */
healthRouter.get('/', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

/**
 * Detailed health check with system metrics
 * GET /api/health/detailed
 */
healthRouter.get('/detailed', requireAuth, (req, res) => {
    const memoryUsage = process.memoryUsage();
    const systemMemory = {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem()
    };

    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: {
            seconds: Math.floor(process.uptime()),
            formatted: formatUptime(process.uptime())
        },
        process: {
            pid: process.pid,
            version: process.version,
            platform: process.platform,
            arch: process.arch
        },
        memory: {
            process: {
                rss: formatBytes(memoryUsage.rss),
                heapTotal: formatBytes(memoryUsage.heapTotal),
                heapUsed: formatBytes(memoryUsage.heapUsed),
                external: formatBytes(memoryUsage.external),
                heapUsedPercentage: ((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100).toFixed(2) + '%'
            },
            system: {
                total: formatBytes(systemMemory.total),
                free: formatBytes(systemMemory.free),
                used: formatBytes(systemMemory.used),
                usedPercentage: ((systemMemory.used / systemMemory.total) * 100).toFixed(2) + '%'
            }
        },
        cpu: {
            cores: os.cpus().length,
            model: os.cpus()[0]?.model || 'Unknown',
            loadAverage: os.loadavg()
        },
        system: {
            hostname: os.hostname(),
            platform: os.platform(),
            release: os.release(),
            type: os.type()
        }
    });
});

/**
 * Backup system health
 * GET /api/health/backups
 */
healthRouter.get('/backups', requireAuth, (req, res) => {
    try {
        if (!ensureBackupAccess(req, res)) return;
        const stats = BackupService.getStats(req.user.id);
        const backups = BackupService.listBackups(req.user.id);

        res.json({
            status: 'healthy',
            backupSystem: {
                enabled: true,
                stats,
                recentBackups: backups.map(b => ({
                    filename: b.filename,
                    size: formatBytes(b.size),
                    created: b.created
                }))
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error.message
        });
    }
});

/**
 * Trigger manual backup
 * POST /api/health/backups
 */
healthRouter.post('/backups', requireAuth, (req, res) => {
    try {
        if (!ensureBackupAccess(req, res)) return;
        const result = BackupService.createBackup('manual', req.user.id);
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Restore from a backup
 * POST /api/health/backups/restore
 */
healthRouter.post('/backups/restore', requireAuth, async (req, res) => {
    try {
        if (!ensureBackupAccess(req, res)) return;
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ success: false, error: 'Missing backup filename' });

        const result = await BackupService.restoreBackup(filename, req.user.id);
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Preview what a restore would change (no mutation)
 * GET /api/health/backups/preview?filename=...
 */
healthRouter.get('/backups/preview', requireAuth, (req, res) => {
    try {
        if (!ensureBackupAccess(req, res)) return;
        const { filename } = req.query;
        if (!filename) return res.status(400).json({ success: false, error: 'Missing backup filename' });
        const result = BackupService.previewRestore(filename, req.user.id);
        if (result.success) res.json(result);
        else res.status(404).json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Download a backup file (credentials remain encrypted in the file)
 * GET /api/health/backups/download?filename=...
 */
healthRouter.get('/backups/download', requireAuth, (req, res) => {
    try {
        if (!ensureBackupAccess(req, res)) return;
        const { filename } = req.query;
        if (!filename) return res.status(400).json({ error: 'Missing backup filename' });

        const filePath = BackupService.getBackupPath(filename, req.user.id);
        if (!filePath) return res.status(404).json({ error: 'Backup not found or access denied' });

        res.download(filePath, filename);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Helper function to format bytes to human-readable format
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Helper function to format uptime
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
}
