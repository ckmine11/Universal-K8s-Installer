const WebSocket = require('ws');
const { NodeSSH } = require('node-ssh');
const os = require('os');
const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i += 2) argMap[args[i].replace('--','')] = args[i+1];

const { token, 'agent-id': agentId, server } = argMap;

if (!token || !agentId || !server) {
    console.error("Usage: node agent.js --token <TOKEN> --agent-id <AGENT_ID> --server <WSS_URL>");
    process.exit(1);
}

const ips = Object.values(os.networkInterfaces()).flat().filter(n => !n.internal && n.family === 'IPv4').map(n => n.address);
const sshSessions = new Map();

function connect() {
  const ws = new WebSocket(`${server}/ws/agent/${agentId}?token=${token}`);
  
  ws.on('open', () => {
    console.log('[Gateway Agent] Connected to SaaS. Bridging local network...');
    ws.send(JSON.stringify({ type: 'register-ips', ips: ['gateway'] })); // Mark as gateway
    setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 20000);
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data);
    
    if (msg.type === 'execute-ssh') {
        const { commandId, ip, username, password, command, privateKey } = msg;
        try {
            let ssh = sshSessions.get(ip);
            if (!ssh) {
                ssh = new NodeSSH();
                await ssh.connect({
                    host: ip,
                    username,
                    password,
                    privateKey,
                    tryKeyboard: true,
                    readyTimeout: 60000
                });
                sshSessions.set(ip, ssh);
                console.log(`[Gateway Agent] Established SSH connection to ${ip}`);
            }

            console.log(`[Gateway Agent] Executing command on ${ip}: ${command.substring(0, 50)}...`);
            
            const result = await ssh.execCommand(command, {
                options: { pty: true }
            });

            ws.send(JSON.stringify({ 
                type: 'command-result', 
                commandId, 
                stdout: result.stdout, 
                stderr: result.stderr, 
                exitCode: result.code || 0 
            }));

        } catch (error) {
            console.error(`[Gateway Agent] SSH Error on ${ip}:`, error.message);
            ws.send(JSON.stringify({ 
                type: 'command-result', 
                commandId, 
                stdout: '', 
                stderr: error.message, 
                exitCode: 1 
            }));
            sshSessions.delete(ip); // Force reconnect next time
        }
    }
  });

  ws.on('close', () => { 
      console.log('[Gateway Agent] Disconnected. Reconnecting in 5s...'); 
      sshSessions.clear();
      setTimeout(connect, 5000);
  });
  
  ws.on('error', (e) => { console.error('[Gateway Agent] Connection Error:', e.message); });
}

console.log('[Gateway Agent] Starting...');
connect();
