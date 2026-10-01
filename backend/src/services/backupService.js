import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encrypt, decrypt } from '../utils/cryptoUtils.js';
import { clusterStore } from './clusterStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * BackupService - Handles automatic and manual backups of cluster data
 */
export class BackupService {
    static DATA_PATH = path.join(__dirname, '../../data/clusters.json');
    static BACKUP_DIR = path.join(__dirname, '../../data/backups');

    /**
     * Initialize backup service - create backup directory if it doesn't exist
     */
    static initialize() {
        if (!fs.existsSync(this.BACKUP_DIR)) {
            fs.mkdirSync(this.BACKUP_DIR, { recursive: true });
            console.log('✓ Backup directory created');
        }
    }

    // Sensitive node fields that must never sit in a backup file as plain text.
    static SENSITIVE_NODE_FIELDS = ['password', 'sshKey'];

    /** Apply fn (encrypt/decrypt) to sensitive node credentials across clusters. */
    static mapCredentials(clusters, fn) {
        const mapNode = (n) => {
            const node = { ...n };
            for (const f of this.SENSITIVE_NODE_FIELDS) {
                if (node[f]) node[f] = fn(node[f]);
            }
            return node;
        };
        return clusters.map(c => {
            const clone = { ...c };
            if (Array.isArray(clone.masterNodes)) clone.masterNodes = clone.masterNodes.map(mapNode);
            if (Array.isArray(clone.workerNodes)) clone.workerNodes = clone.workerNodes.map(mapNode);
            return clone;
        });
    }

    /** Resolve a backup file path after validating ownership + rejecting traversal. */
    static getBackupPath(filename, userId) {
        if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            return null;
        }
        if (!new RegExp(`^clusters-${userId}-`).test(filename)) return null;
        const p = path.join(this.BACKUP_DIR, filename);
        return fs.existsSync(p) ? p : null;
    }

    /**
     * Create a backup of clusters for a specific user
     * @param {string} reason - Reason for backup (optional)
     * @param {string} userId - ID of the user taking the backup
     * @returns {Object} Backup result with path and timestamp
     */
    static createBackup(reason = 'manual', userId) {
        try {
            if (!userId) throw new Error('User ID is required for backup');
            this.initialize();

            // Check if source file exists
            if (!fs.existsSync(this.DATA_PATH)) {
                return {
                    success: false,
                    error: 'No clusters.json file found to backup'
                };
            }

            // Read existing clusters
            const allClusters = JSON.parse(fs.readFileSync(this.DATA_PATH, 'utf-8'));
            const userClusters = allClusters.filter(c => c.ownerId === userId);

            // Encrypt node credentials (password/sshKey) at rest in the backup file
            const securedClusters = this.mapCredentials(userClusters, encrypt);

            // Create timestamp-based filename isolated by user
            const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
            const backupFilename = `clusters-${userId}-${timestamp}-${reason}.json`;
            const backupPath = path.join(this.BACKUP_DIR, backupFilename);

            // Write only this user's clusters (credentials encrypted) to the backup file
            fs.writeFileSync(backupPath, JSON.stringify(securedClusters, null, 2));

            // Get file stats
            const stats = fs.statSync(backupPath);

            console.log(`✓ Backup created for user ${userId}: ${backupFilename}`);

            return {
                success: true,
                path: backupPath,
                filename: backupFilename,
                size: stats.size,
                timestamp: new Date().toISOString(),
                reason
            };
        } catch (error) {
            console.error('Backup creation failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * List all available backups for a specific user
     * @param {string} userId - ID of the user
     * @returns {Array} List of backup files with metadata
     */
    static listBackups(userId) {
        try {
            if (!userId) return [];
            this.initialize();

            if (!fs.existsSync(this.BACKUP_DIR)) {
                return [];
            }

            const files = fs.readdirSync(this.BACKUP_DIR);
            const backups = files
                .filter(file => file.endsWith('.json') && file.includes(`clusters-${userId}-`))
                .map(file => {
                    const filePath = path.join(this.BACKUP_DIR, file);
                    const stats = fs.statSync(filePath);
                    // birthtime is unreliable on many Docker/Linux filesystems (returns
                    // epoch 0); fall back to mtime for an accurate timestamp.
                    const created = (stats.birthtimeMs && stats.birthtimeMs > 0) ? stats.birthtime : stats.mtime;

                    return {
                        filename: file,
                        path: filePath,
                        size: stats.size,
                        created,
                        modified: stats.mtime
                    };
                })
                .sort((a, b) => new Date(b.created) - new Date(a.created)); // Most recent first

            return backups;
        } catch (error) {
            console.error('Failed to list backups:', error);
            return [];
        }
    }

    /**
     * Restore from a backup file for a specific user
     * @param {string} backupFilename - Name of backup file to restore
     * @param {string} userId - ID of the user
     * @returns {Object} Restore result
     */
    static async restoreBackup(backupFilename, userId) {
        try {
            if (!userId) throw new Error('User ID is required for restore');

            // Validates ownership (filename prefix) and rejects path traversal
            const backupPath = this.getBackupPath(backupFilename, userId);
            if (!backupPath) {
                return {
                    success: false,
                    error: 'Backup file not found or access denied'
                };
            }

            // Create a backup of current state before restoring
            const currentBackup = this.createBackup('pre-restore', userId);

            // Read the backup clusters and decrypt credentials back to usable form
            const rawBackup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
            const restoredClusters = this.mapCredentials(rawBackup, decrypt);

            // Validate that the restored clusters belong to the user
            if (restoredClusters.some(c => c.ownerId !== userId)) {
                return { success: false, error: 'Backup contains data belonging to another user' };
            }

            // Read-modify-write under the cluster store's lock so a concurrent
            // saveCluster/deleteCluster can't clobber (or be clobbered by) this.
            await clusterStore.withLock(async () => {
                let allClusters = [];
                if (fs.existsSync(this.DATA_PATH)) {
                    allClusters = JSON.parse(fs.readFileSync(this.DATA_PATH, 'utf-8'));
                }

                // Remove existing clusters for this user and append the restored ones
                allClusters = allClusters.filter(c => c.ownerId !== userId);
                allClusters.push(...restoredClusters);

                fs.writeFileSync(this.DATA_PATH, JSON.stringify(allClusters, null, 2));
            });

            console.log(`✓ Restored from backup: ${backupFilename} for user ${userId}`);

            return {
                success: true,
                restoredFrom: backupFilename,
                currentBackup: currentBackup?.filename,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('Restore failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Delete old backups, keeping only the most recent N backups
     * @param {number} keepCount - Number of recent backups to keep
     * @returns {Object} Cleanup result
     */
    static cleanupOldBackups(userId, keepCount = 10) {
        try {
            if (!userId) return { success: false, error: 'User ID is required for cleanup' };
            const backups = this.listBackups(userId);

            if (backups.length <= keepCount) {
                return {
                    success: true,
                    message: `Only ${backups.length} backups exist, no cleanup needed`,
                    deleted: 0
                };
            }

            // Delete old backups
            const toDelete = backups.slice(keepCount);
            let deleted = 0;

            toDelete.forEach(backup => {
                try {
                    fs.unlinkSync(backup.path);
                    deleted++;
                } catch (err) {
                    console.error(`Failed to delete ${backup.filename}:`, err);
                }
            });

            console.log(`✓ Cleaned up ${deleted} old backups`);

            return {
                success: true,
                deleted,
                remaining: backups.length - deleted
            };
        } catch (error) {
            console.error('Cleanup failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get backup statistics
     * @returns {Object} Backup statistics
     */
    static getStats(userId) {
        try {
            const backups = this.listBackups(userId);
            const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);

            return {
                totalBackups: backups.length,
                totalSize,
                totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
                oldestBackup: backups.length > 0 ? backups[backups.length - 1].created : null,
                newestBackup: backups.length > 0 ? backups[0].created : null
            };
        } catch (error) {
            console.error('Failed to get stats:', error);
            return null;
        }
    }

    /**
     * Preview what a restore would change, WITHOUT touching anything.
     * Compares the user's current clusters against the backup's clusters.
     * @returns {Object} { added, removed, changed, unchanged } summaries
     */
    static previewRestore(backupFilename, userId) {
        try {
            const backupPath = this.getBackupPath(backupFilename, userId);
            if (!backupPath) return { success: false, error: 'Backup file not found' };

            const backupClusters = JSON.parse(fs.readFileSync(backupPath, 'utf-8')); // creds stay encrypted; not needed here
            let allClusters = [];
            if (fs.existsSync(this.DATA_PATH)) {
                allClusters = JSON.parse(fs.readFileSync(this.DATA_PATH, 'utf-8'));
            }
            const currentClusters = allClusters.filter(c => c.ownerId === userId);

            const summarize = (c) => ({
                id: c.id,
                clusterName: c.clusterName,
                k8sVersion: c.k8sVersion,
                nodeCount: (c.masterNodes?.length || 0) + (c.workerNodes?.length || 0),
                addons: c.addons || [],
                status: c.status
            });
            const fingerprint = (c) => JSON.stringify([
                c.clusterName, c.k8sVersion, c.networkPlugin,
                (c.masterNodes?.length || 0) + (c.workerNodes?.length || 0),
                [...(c.addons || [])].sort()
            ]);

            const curById = new Map(currentClusters.map(c => [c.id, c]));
            const bakById = new Map(backupClusters.map(c => [c.id, c]));

            const added = [];      // in backup, not currently present → will be re-created
            const removed = [];    // currently present, not in backup → will be dropped
            const changed = [];    // same id, different config → will be overwritten
            const unchanged = [];

            for (const b of backupClusters) {
                const cur = curById.get(b.id);
                if (!cur) added.push(summarize(b));
                else if (fingerprint(cur) !== fingerprint(b)) changed.push({ from: summarize(cur), to: summarize(b) });
                else unchanged.push(summarize(b));
            }
            for (const c of currentClusters) {
                if (!bakById.has(c.id)) removed.push(summarize(c));
            }

            return {
                success: true,
                filename: backupFilename,
                counts: { current: currentClusters.length, backup: backupClusters.length,
                          added: added.length, removed: removed.length, changed: changed.length, unchanged: unchanged.length },
                added, removed, changed, unchanged
            };
        } catch (error) {
            console.error('Preview restore failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Run a daily backup for EVERY user that owns clusters, then prune old ones.
     * Derives the user list from clusters.json owners — no auth dependency.
     */
    static async runDailyBackups() {
        try {
            if (!fs.existsSync(this.DATA_PATH)) return;
            const all = JSON.parse(fs.readFileSync(this.DATA_PATH, 'utf-8'));
            if (!Array.isArray(all) || all.length === 0) return;

            // Daily auto-backups are a Pro feature — only back up paid-plan owners.
            const { authService } = await import('./authService.js');
            const { canUseBackups } = await import('../config/planFeatures.js');

            const owners = [...new Set(all.map(c => c.ownerId).filter(Boolean))];
            let count = 0, skipped = 0;
            owners.forEach(uid => {
                const u = authService.getUserById(uid);
                if (!canUseBackups(u?.subscription?.plan, u?.role)) { skipped++; return; }
                const r = this.createBackup('auto', uid);
                if (r.success) { count++; this.cleanupOldBackups(uid, 10); }
            });
            console.log(`[BackupService] Daily auto-backup complete for ${count} paid user(s), skipped ${skipped} free user(s)`);
        } catch (error) {
            console.error('[BackupService] Daily backup run failed:', error.message);
        }
    }

    /**
     * Start the global daily backup scheduler. Runs shortly after boot, then
     * every 24h. Safe to call once at server startup.
     */
    static startDailyScheduler(intervalHours = 24) {
        this.initialize();
        // First run 30s after boot (let the app settle), then on the interval
        setTimeout(() => this.runDailyBackups(), 30000);
        setInterval(() => this.runDailyBackups(), intervalHours * 60 * 60 * 1000);
        console.log(`✓ Daily auto-backup scheduler started (every ${intervalHours}h)`);
    }
}

// Initialize on module load
BackupService.initialize();
