# FleetPilot user guide

From an empty installation to a fleet that keeps itself in line. Every step happens in the web
app; nothing needs a terminal after the installation ([README](../README.md#installation)).

## 1. Sign in

Open FleetPilot and create the first administrator with the **setup code**. The Debian installer
prints it at the end; with Docker or Kubernetes it is in the log of the app server
([docs/DEPLOYMENT.md](DEPLOYMENT.md)). Administrators set up two-factor sign-in right away
(any authenticator app); keep the recovery codes somewhere safe.

Then, under **Settings**:

- **Accounts:** add the people who work with FleetPilot. Each gets a first password that works once.
- **Roles:** give them rights. The built-in roles are *Engineer* (builds and runs everything),
  *Operator* (runs existing workflows), *Trainee* (may start workflows, every run waits for an
  approval) and *Viewer*. A role can be limited to some sites and groups.
- **Sign-in rules:** password length, two-factor sign-in for everyone, lockout.

## 2. Put the login of your installation into the vault

A take-over logs in once with the user and password your hosts have after their installation.
**Settings → Vault → Add a secret**, kind *Login*: the user (for example `admin`), its password,
and the root password when the user becomes root with `su`. The vault encrypts every value; showing
one later asks you to confirm that it is you and is recorded in the audit log.

Then open **Automate → Take over a Debian host**, choose this login in the first step
("Connect with a login") and save.

## 3. Sites, groups and hosts

**Hosts → Add a site** (a datacenter, a room, a lab), then groups inside it with the **+** on
the site. Groups can hold groups.

**Add hosts** takes one host, a list (`name address [port]` per line), a range of addresses with
a name pattern (`web-{n}` becomes `web-01`, `web-02`, …) or a CSV file (`name,address,port,tags`).
Choose the group, tags, and whether to take them over right away.

**Proxmox:** *Hosts → Proxmox → Connect a Proxmox cluster.* In Proxmox, make an API token for a
user with the role *PVEAuditor* on `/` (FleetPilot only reads). For a self-signed certificate,
read its fingerprint from the server, compare it with the one on the Proxmox page, and pin it.
*Show the VMs* lists every VM and container with the addresses the guest agent reports; choose
the ones that become hosts.

On the map, drag hosts onto groups to move them and drag a group by its name into another.
Right-click a host for more. The table does the same for many hosts at once.

## 4. Addresses

**Network → Add a subnet** with its gateway, and the DNS servers, search domains and time servers
its hosts should use. FleetPilot records the addresses of the hosts that are already in it.
Add **pools** (ranges inside the subnet) for addresses FleetPilot gives out, for example with the
workflow step *Give the host an address*: it takes the next free address of a pool, writes the
network configuration (ifupdown or netplan) and waits for the host at its new address.

An address is free only when FleetPilot knows nothing about it and nothing answers on it. Use
**Check an address** before you give one out by hand, **Reserve an address** for printers and
switches, and **Scan the subnet** to record what answers.

## 5. Take hosts over

Select hosts (map: right-click; table: check them) and **Run a workflow**, or let the take-over
start when hosts are added. The built-in take-over:

1. logs in with the login from the vault, becomes root, installs Python when it is missing and
   leaves FleetPilot's key;
2. creates the user `fleetpilot` with sudo, makes the host trust FleetPilot's user certificate
   authority, signs the host key (a host certificate) and removes the key of the first login;
3. reads the facts of the host;
4. sets the host name;
5. sets a new random root password and keeps it in the vault;
6. makes an SSH key pair with a certificate for root, kept in the vault;
7. turns SSH password logins off;
8. applies the desired state.

The run page shows every host in every step and the live log. A host that fails keeps its place in
the grid with the reason; *Again on the failed hosts* starts a new run for them only.

## 6. Describe the desired state

**Automate → New template.** *Add a setting* opens the catalog: search for what you need
(users, packages, firewall, nginx, …) and fill in its form. The playbook FleetPilot makes appears
beside the forms while you type. Texts may use FleetPilot's variables, like `{{ fp_name }}` or
`{{ fp_ip }}`; the list is under the settings.

Save the template, then apply it on **Where it applies** to a site, a group or a host. A template
can stay at a version there (*Stay at version 3*) while the newest one is tried elsewhere.

How templates combine on a host: from the site down to the host, settings of the more specific
template win. Settings that are lists (users, packages, firewall rules, cron jobs, …) are put
together, and a row with the same key (the same user, package or port) replaces the earlier one.
A host's **Desired state** tab shows the result, setting by setting, and the playbook for it.

Every save is a new version. Hosts keep the version that was applied to them until it is applied
again: by a workflow, or with **Push** on *Where it applies* (to the hosts that are behind, to all,
or to the ones you choose). *Versions* shows every version's playbook and brings an old one back
into the editor.

## 7. Workflows: what runs, when and how

A workflow is a trigger, the hosts it is for, how many at once, an approval rule and a list of
steps. The sentence at the top of the editor says all of it in one paragraph.

- **When:** by hand, on a schedule (five cron fields, in UTC; the editor says what the line
  means), when a host is added (take-over), or when a template gets a new version (maintenance).
- **On which hosts:** groups and tags; nothing chosen means every host. Take-over workflows only
  run on hosts that are not managed yet, maintenance workflows only on managed hosts.
- **How many at once:** a number of hosts or a percentage per batch. A batch finishes every step
  before the next one starts.
- **Approval:** when the roles of the person who starts it ask for one, or always. The step
  *Wait for an approval* stops a run in the middle until someone approves.
- **Each step:** its values, what happens when it fails (stop for this host, stop the run, or go
  on), and optionally for which hosts it runs (tags, groups, the system).

Built-in maintenance workflows: *Apply desired state*, *Check drift* (every night at 02:30 UTC,
changes nothing), *Rotate passwords*, *Update packages* (then reboots the hosts that need it, ten
percent at a time), *Reboot in batches*. Change them, switch them off, or duplicate them.

## 8. Day to day

The **Overview** shows only what needs someone: runs waiting for an approval, failed runs, hosts
that do not answer, hosts that drifted from their desired state, hosts not taken over yet.

**Drift:** the nightly check compares every managed host with its desired state without changing
anything. A host's *Desired state* tab lists each difference with the lines that would change;
*Apply the desired state* fixes them.

**Logging in yourself:** *Settings → SSH keys → A certificate for yourself* signs your public key
for a few hours. Hosts let you in when a template has the setting *Logins with SSH certificates*
for your FleetPilot user. Add the host certificate authority to your `known_hosts` with
`@cert-authority * ` in front, and SSH never asks about host keys of managed hosts again.

**Passwords:** every password FleetPilot sets is in the vault under the host's name, with its last
ten versions. *Rotate passwords* sets new ones on every host it runs on.
