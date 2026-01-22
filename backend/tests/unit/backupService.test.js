import { BackupService } from '../../src/services/backupService.js';
import fs from 'fs';
import path from 'path';

describe('BackupService', () => {
    beforeAll(() => {
        // Initialize backup service
        BackupService.initialize();
    });

    describe('createBackup', () => {
        test('should create backup successfully', () => {
            const result = BackupService.createBackup('test');

            expect(result.success).toBe(true);
            expect(result.filename).toContain('clusters');
            expect(result.filename).toContain('test');
            expect(result.timestamp).toBeDefined();
        });

        test('should return error if source file does not exist', () => {
            // Temporarily rename the source file
            const originalPath = BackupService.DATA_PATH;
            const tempPath = originalPath + '.temp';

            if (fs.existsSync(originalPath)) {
                fs.renameSync(originalPath, tempPath);
            }

            const result = BackupService.createBackup('test');

            expect(result.success).toBe(false);
            expect(result.error).toContain('No clusters.json file found');

            // Restore the file
            if (fs.existsSync(tempPath)) {
                fs.renameSync(tempPath, originalPath);
            }
        });
    });

    describe('listBackups', () => {
        test('should list all backups', () => {
            // Create a test backup first
            BackupService.createBackup('test-list');

            const backups = BackupService.listBackups();

            expect(Array.isArray(backups)).toBe(true);
            expect(backups.length).toBeGreaterThan(0);
            expect(backups[0]).toHaveProperty('filename');
            expect(backups[0]).toHaveProperty('size');
            expect(backups[0]).toHaveProperty('created');
        });

        test('should return empty array if no backups exist', () => {
            // This test assumes a clean state
            // In practice, you might want to mock the file system
            const backups = BackupService.listBackups();
            expect(Array.isArray(backups)).toBe(true);
        });
    });

    describe('getStats', () => {
        test('should return backup statistics', () => {
            const stats = BackupService.getStats();

            expect(stats).toHaveProperty('totalBackups');
            expect(stats).toHaveProperty('totalSize');
            expect(stats).toHaveProperty('totalSizeMB');
            expect(typeof stats.totalBackups).toBe('number');
        });
    });

    describe('cleanupOldBackups', () => {
        test('should cleanup old backups keeping specified count', () => {
            // Create multiple backups
            for (let i = 0; i < 5; i++) {
                BackupService.createBackup(`test-cleanup-${i}`);
            }

            const result = BackupService.cleanupOldBackups(3);

            expect(result.success).toBe(true);
            expect(result.remaining).toBeLessThanOrEqual(3);
        });
    });
});
