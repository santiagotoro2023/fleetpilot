# A fresh Debian 12 "installation" for the take-over test (test/unit/takeover.test.mjs):
# systemd, an SSH server with password logins, the user admin and a root password, no sudo, no Python.
FROM debian:12
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv openssh-server iproute2 >/dev/null && apt-get clean \
 && systemctl mask getty@tty1.service serial-getty@ttyS0.service >/dev/null 2>&1 || true
RUN useradd -m -s /bin/bash admin && echo 'admin:install-pw' | chpasswd && echo 'root:root-pw' | chpasswd \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
