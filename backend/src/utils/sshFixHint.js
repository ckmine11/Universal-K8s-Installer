// Copy-paste fixes for "SSH connection refused". Each is ONE line joined with
// && — the UI may collapse line breaks, and separate commands pasted onto one
// line break apt ("--now is not understood in combination with the other options").
// The firewall part never fails: it only runs when ufw / firewalld exists.
export const SSH_FIX_DEBIAN =
    'sudo apt-get update && sudo apt-get install -y openssh-server && sudo systemctl enable --now ssh && ' +
    '{ command -v ufw >/dev/null && sudo ufw allow ssh || true; }'

export const SSH_FIX_RHEL =
    'sudo dnf install -y openssh-server && sudo systemctl enable --now sshd && ' +
    '{ command -v firewall-cmd >/dev/null && sudo firewall-cmd --permanent --add-service=ssh && sudo firewall-cmd --reload || true; }'

export function sshRefusedMessage(where) {
    return `SSH Connection Refused on ${where}.\n\n` +
        `FIX — run this ONE line on the node (Ubuntu/Debian):\n  ${SSH_FIX_DEBIAN}\n\n` +
        `Rocky/Alma/RHEL/Fedora:\n  ${SSH_FIX_RHEL}`
}
