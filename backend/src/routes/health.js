import express from 'express';
import os from 'os';
import { BackupService } from '../services/backupService.js';

export const healthRouter = express.Router();

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
healthRouter.get('/detailed', (req, res) => {
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
healthRouter.get('/backups', (req, res) => {
    try {
        const stats = BackupService.getStats();
        const backups = BackupService.listBackups();

        res.json({
            status: 'healthy',
            backupSystem: {
                enabled: true,
                stats,
                recentBackups: backups.slice(0, 5).map(b => ({
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
