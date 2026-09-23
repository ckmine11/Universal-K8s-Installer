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

            // Create timestamp-based filename isolated by user
            const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
            const backupFilename = `clusters-${userId}-${timestamp}-${reason}.json`;
            const backupPath = path.join(this.BACKUP_DIR, backupFilename);

            // Write only this user's clusters to the backup file
            fs.writeFileSync(backupPath, JSON.stringify(userClusters, null, 2));

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
     * Restore from a backup file for a specific user
     * @param {string} backupFilename - Name of backup file to restore
     * @param {string} userId - ID of the user
     * @returns {Object} Restore result
     */
    static restoreBackup(backupFilename, userId) {
        try {
            if (!userId) throw new Error('User ID is required for restore');
            const backupPath = path.join(this.BACKUP_DIR, backupFilename);

            // Check if backup exists and belongs to the user
            if (!fs.existsSync(backupPath)) {
                return {
                    success: false,
                    error: 'Backup file not found'
                };
            }
            if (!backupFilename.includes(`clusters-${userId}-`)) {
                return {
                    success: false,
                    error: 'Unauthorized to restore this backup'
                };
            }

            // Create a backup of current state before restoring
            const currentBackup = this.createBackup('pre-restore', userId);

            // Read the backup clusters
            const restoredClusters = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
            
            // Validate that the restored clusters belong to the user
            if (restoredClusters.some(c => c.ownerId !== userId)) {
                return { success: false, error: 'Backup contains data belonging to another user' };
            }

            // Read all current clusters
            let allClusters = [];
            if (fs.existsSync(this.DATA_PATH)) {
                allClusters = JSON.parse(fs.readFileSync(this.DATA_PATH, 'utf-8'));
            }

            // Remove existing clusters for this user and append the restored ones
            allClusters = allClusters.filter(c => c.ownerId !== userId);
            allClusters.push(...restoredClusters);

            // Write back to clusters.json
            fs.writeFileSync(this.DATA_PATH, JSON.stringify(allClusters, null, 2));

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
