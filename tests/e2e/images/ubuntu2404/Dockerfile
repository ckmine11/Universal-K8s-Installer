# Test-only stand-in for a VM: this distro + systemd, run privileged by tests/e2e/e2e.sh
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y systemd systemd-sysv dbus iproute2 kmod procps sudo curl ca-certificates iptables gnupg lsb-release hostname && apt-get clean
RUN systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket getty.target console-getty.service systemd-logind.service 2>/dev/null || true
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
