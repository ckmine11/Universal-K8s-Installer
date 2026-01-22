import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

    /**
     * Create a backup of clusters.json
     * @param {string} reason - Reason for backup (optional)
     * @returns {Object} Backup result with path and timestamp
     */
    static createBackup(reason = 'manual') {
        try {
            this.initialize();

            // Check if source file exists
            if (!fs.existsSync(this.DATA_PATH)) {
                return {
                    success: false,
                    error: 'No clusters.json file found to backup'
                };
            }

            // Create timestamp-based filename
            const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
            const backupFilename = `clusters-${timestamp}-${reason}.json`;
            const backupPath = path.join(this.BACKUP_DIR, backupFilename);

            // Copy file
            fs.copyFileSync(this.DATA_PATH, backupPath);

            // Get file stats
            const stats = fs.statSync(backupPath);

            console.log(`✓ Backup created: ${backupFilename}`);

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
     * List all available backups
     * @returns {Array} List of backup files with metadata
     */
    static listBackups() {
        try {
            this.initialize();

            if (!fs.existsSync(this.BACKUP_DIR)) {
                return [];
            }

            const files = fs.readdirSync(this.BACKUP_DIR);
            const backups = files
                .filter(file => file.endsWith('.json'))
                .map(file => {
                    const filePath = path.join(this.BACKUP_DIR, file);
                    const stats = fs.statSync(filePath);

                    return {
                        filename: file,
                        path: filePath,
                        size: stats.size,
                        created: stats.birthtime,
                        modified: stats.mtime
                    };
                })
                .sort((a, b) => b.created - a.created); // Most recent first

            return backups;
        } catch (error) {
            console.error('Failed to list backups:', error);
            return [];
        }
    }

    /**
     * Restore from a backup file
     * @param {string} backupFilename - Name of backup file to restore
     * @returns {Object} Restore result
     */
    static restoreBackup(backupFilename) {
        try {
            const backupPath = path.join(this.BACKUP_DIR, backupFilename);

            // Check if backup exists
            if (!fs.existsSync(backupPath)) {
                return {
                    success: false,
                    error: 'Backup file not found'
                };
            }

            // Create a backup of current state before restoring
            const currentBackup = this.createBackup('pre-restore');

            // Restore the backup
            fs.copyFileSync(backupPath, this.DATA_PATH);

            console.log(`✓ Restored from backup: ${backupFilename}`);

            return {
                success: true,
                restoredFrom: backupFilename,
                currentBackup: currentBackup.filename,
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
    static cleanupOldBackups(keepCount = 10) {
        try {
            const backups = this.listBackups();

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
    static getStats() {
        try {
            const backups = this.listBackups();
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
     * Schedule automatic backups (call this periodically)
     * @param {number} intervalHours - Backup interval in hours
     */
    static scheduleAutoBackup(intervalHours = 24) {
        // Create initial backup
        this.createBackup('auto');

        // Schedule periodic backups
        setInterval(() => {
            this.createBackup('auto');
            this.cleanupOldBackups(10); // Keep last 10 backups
        }, intervalHours * 60 * 60 * 1000);

        console.log(`✓ Auto-backup scheduled every ${intervalHours} hours`);
    }
}

// Initialize on module load
BackupService.initialize();
