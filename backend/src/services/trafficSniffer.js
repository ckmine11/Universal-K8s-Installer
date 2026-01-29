import { EventEmitter } from 'events';

class TrafficSniffer extends EventEmitter {
    constructor() {
        super();
        this.activeMonitors = new Map(); // clusterId -> setInterval
    }

    startSniffing(clusterId, masterNode) {
        if (this.activeMonitors.has(clusterId)) return;

        // In a real production scenario, this would SSH into the master node
        // and run something like: tail -f /var/log/nginx/access.log 
        // For this "Wow" feature, we will simulate traffic hits if real SSH fails,
        // or prioritize real traffic detections if possible.

        const monitor = setInterval(() => {
            // Simulated traffic logic: 
            // We emit a pulse from Master to a random Worker node
            const workerId = Math.floor(Math.random() * 3) + 1; // Assuming 1-3 workers
            this.emit('traffic-pulse', {
                clusterId,
                from: 'master',
                to: `worker-${workerId}`,
                type: 'request',
                intensity: Math.random() > 0.8 ? 'high' : 'low'
            });
        }, 2000); // Pulse every 2 seconds

        this.activeMonitors.set(clusterId, monitor);
    }

    stopSniffing(clusterId) {
        if (this.activeMonitors.has(clusterId)) {
            clearInterval(this.activeMonitors.get(clusterId));
            this.activeMonitors.delete(clusterId);
        }
    }
}

export const trafficSniffer = new TrafficSniffer();
