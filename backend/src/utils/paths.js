import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Runtime data: users, clusters, agents, license, encryption key, backups.
// Override with KUBEEZ_DATA_DIR (tests, custom deployments). Must be set in the
// process environment — it is read once, when this module is first imported.
export const DATA_DIR = process.env.KUBEEZ_DATA_DIR
    ? path.resolve(process.env.KUBEEZ_DATA_DIR)
    : path.join(__dirname, '../../data')
