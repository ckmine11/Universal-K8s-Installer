# Test-only stand-in for a VM: this distro + systemd, run privileged by tests/e2e/e2e.sh
FROM rockylinux:9
RUN dnf install -y systemd iproute kmod procps-ng sudo hostname iptables-nft findutils which tar gzip && (dnf install -y curl --allowerasing || true) && dnf clean all
RUN systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket getty.target console-getty.service systemd-logind.service 2>/dev/null || true
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
