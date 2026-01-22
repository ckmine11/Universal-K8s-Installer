# KubeEZ Backend Tests

This directory contains tests for the KubeEZ backend.

## Structure

```
tests/
├── unit/           # Unit tests for individual functions/modules
├── integration/    # Integration tests for API endpoints
└── e2e/           # End-to-end tests
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- tests/unit/backupService.test.js

# Run with coverage
npm test -- --coverage

# Watch mode
npm test -- --watch
```

## Writing Tests

### Unit Tests

Test individual functions in isolation:

```javascript
// tests/unit/backupService.test.js
import { BackupService } from '../../src/services/backupService.js';

describe('BackupService', () => {
  test('should create backup successfully', () => {
    const result = BackupService.createBackup('test');
    expect(result.success).toBe(true);
  });
});
```

### Integration Tests

Test API endpoints:

```javascript
// tests/integration/health.test.js
import request from 'supertest';
import app from '../../src/server.js';

describe('Health Endpoints', () => {
  test('GET /api/health should return healthy status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
  });
});
```

## Test Coverage Goals

- Unit tests: > 80%
- Integration tests: > 70%
- E2E tests: Critical user flows

## CI/CD Integration

Tests run automatically on:
- Pull requests
- Commits to main branch
- Before deployment
