<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import { notify } from '#lib/actions.js';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	interface GuideFormResult {
		command?: string;
		expiresAt?: string;
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as GuideFormResult | null);

	// Operator values. Every snippet below is derived from these, so the guide stays copy-pasteable.
	let nodeName = $state('homelab');
	let endpoint = $state('');
	let wgPort = $state('51820');
	let edgeIp = $state('10.88.0.1');
	let workerIp = $state('10.88.0.2');
	let caddyPort = $state('8080');
	let edgePublicKey = $state('');
	let workerPublicKey = $state('');
	let pending = $state(false);

	const edgeEndpoint = $derived(endpoint.trim() || data.platformHost);
	const tunnelAddress = $derived(`${workerIp.trim()}:${caddyPort.trim()}`);
	const probeHost = $derived(`probe.${data.contentDomain || 'example.com'}`);

	const keygen = `sudo apt-get install -y wireguard
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/wg0.key'
# Print this machine's public key; paste it into the field above.
sudo wg pubkey < /etc/wireguard/wg0.key`;

	const edgeConfig = $derived(`[Interface]
Address = ${edgeIp}/24
ListenPort = ${wgPort}
# The private key never leaves /etc/wireguard/wg0.key.
PostUp = wg set %i private-key /etc/wireguard/wg0.key

[Peer]
# ${nodeName}
PublicKey = ${workerPublicKey.trim() || '<worker public key>'}
AllowedIPs = ${workerIp}/32`);

	const edgeFirewall =
		$derived(`# nftables: add to the input chain in /etc/nftables.conf, then: sudo systemctl reload nftables
udp dport ${wgPort} accept
iifname "wg0" ip saddr ${workerIp} tcp dport 443 accept

# or, with ufw:
sudo ufw allow ${wgPort}/udp
sudo ufw allow in on wg0 from ${workerIp} to any port 443 proto tcp`);

	const workerConfig = $derived(`[Interface]
Address = ${workerIp}/24
PostUp = wg set %i private-key /etc/wireguard/wg0.key

[Peer]
# edge
PublicKey = ${edgePublicKey.trim() || '<edge public key>'}
Endpoint = ${edgeEndpoint}:${wgPort}
AllowedIPs = ${edgeIp}/32
# Keeps the NAT mapping open so the edge can always reach this node.
PersistentKeepalive = 25`);

	const wgUp = `sudo systemctl enable --now wg-quick@wg0`;

	const wgVerify = $derived(`ping -c 3 ${edgeIp}
sudo wg show wg0 latest-handshakes`);

	const hostsPin = $derived(`echo '${edgeIp} ${data.platformHost}' | sudo tee -a /etc/hosts
getent hosts ${data.platformHost}   # should print ${edgeIp}
curl -sS -o /dev/null -w '%{http_code}\\n' ${data.platformOrigin}/`);

	const caddyInstall = `sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \\
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \\
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy`;

	const layout = `sudo groupadd --system skiff
sudo useradd --system --gid skiff --home-dir /var/lib/skiff --shell /usr/sbin/nologin skiff
sudo usermod -aG caddy skiff
sudo install -d -m 0755 /opt/skiff/current/agent
sudo install -d -m 0750 -o root -g skiff /etc/skiff
sudo install -d -m 0751 -o skiff -g skiff /var/lib/skiff
sudo install -d -m 0750 -o skiff -g skiff /var/lib/skiff/agent
echo 'd /run/skiff 2770 root caddy -' | sudo tee /etc/tmpfiles.d/skiff.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/skiff.conf`;

	const caddyConfig = `# The agent replaces the whole Caddy config over this socket; it is never exposed on TCP.
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
{
	admin unix//var/lib/caddy/admin.sock|0660
}
EOF

# Caddy serves release files from the agent cache, so it needs the skiff group.
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\\nSupplementaryGroups=skiff\\n' \\
  | sudo tee /etc/systemd/system/caddy.service.d/skiff.conf >/dev/null
sudo systemctl daemon-reload && sudo systemctl restart caddy
ls -l /var/lib/caddy/admin.sock   # srw-rw---- caddy caddy`;

	const binaryFromEdge = $derived(`# Both machines must print the same architecture.
uname -m && ssh root@${edgeIp} uname -m
scp root@${edgeIp}:/opt/skiff/current/agent/skiff-agent /tmp/skiff-agent
sudo install -m 0755 /tmp/skiff-agent /opt/skiff/current/agent/skiff-agent && rm /tmp/skiff-agent`);

	const binaryFromSource = $derived(`curl -fsSL https://bun.sh/install | bash
git clone https://github.com/${data.sourceRepo}.git && cd skiff
~/.bun/bin/bun install --frozen-lockfile
~/.bun/bin/bun run --cwd apps/agent build
sudo install -m 0755 apps/agent/dist/skiff-agent /opt/skiff/current/agent/skiff-agent`);

	const agentEnv = $derived(`sudo tee /etc/skiff/skiff.env >/dev/null <<'EOF'
NODE_ENV=production
SKIFF_DATA_DIR=/var/lib/skiff/agent
# Plain HTTP on the tunnel address only: the edge terminates TLS and WireGuard encrypts the hop.
SKIFF_TLS=0
SKIFF_CADDY_LISTEN=${tunnelAddress}
SKIFF_CERT_PROBE_ADDR=off
SKIFF_CADDY_ADMIN_SOCKET=/var/lib/caddy/admin.sock
SKIFF_AGENT_SOCKET=/run/skiff/agent.sock
EOF
sudo chown root:skiff /etc/skiff/skiff.env && sudo chmod 0640 /etc/skiff/skiff.env`);

	const agentUnit = `sudo tee /etc/systemd/system/skiff-agent.service >/dev/null <<'EOF'
[Unit]
Description=Skiff node agent
After=network-online.target caddy.service wg-quick@wg0.service
Wants=network-online.target wg-quick@wg0.service
ConditionPathExists=/etc/skiff/agent.env
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
SupplementaryGroups=caddy
UMask=0007
WorkingDirectory=/opt/skiff/current/agent
EnvironmentFile=/etc/skiff/skiff.env
EnvironmentFile=-/etc/skiff/agent.env
ExecStart=/opt/skiff/current/agent/skiff-agent
Restart=on-failure
RestartSec=2
TimeoutStopSec=20
LimitNOFILE=65535
TasksMax=128
MemoryMax=192M
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectClock=yes
ProtectHostname=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service io_uring_setup io_uring_enter io_uring_register
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=/var/lib/skiff /run/skiff

[Install]
WantedBy=multi-user.target
EOF`;

	// Same unit the installer writes on the edge (scripts/systemd/builder.ts). It idles until the
	// node has the Builder role, so it is safe to install on every worker.
	const builderUnit = `sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin skiff-build
# Marks an agent binary with the builder subcommand; the unit only starts when it exists.
sudo ln -sf skiff-agent /opt/skiff/current/agent/skiff-builder
sudo tee /etc/systemd/system/skiff-builder.service >/dev/null <<'EOF'
[Unit]
Description=Skiff git Builder (idle unless this node has the Builder role)
After=network-online.target skiff-agent.service
Wants=network-online.target
ConditionPathExists=/etc/skiff/agent.env
ConditionPathExists=/opt/skiff/current/agent/skiff-builder
PartOf=skiff-agent.service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
EnvironmentFile=/etc/skiff/agent.env
Environment=SKIFF_BUILD_DIR=/var/lib/skiff-builder
Environment=SKIFF_BUILDER_USER=skiff-build
Environment=HOME=/var/lib/skiff-builder
StateDirectory=skiff-builder
StateDirectoryMode=0711
WorkingDirectory=/var/lib/skiff-builder
ExecStart=/opt/skiff/current/agent/skiff-builder builder
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillSignal=SIGTERM
MemoryMax=1G
TasksMax=256
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER

[Install]
WantedBy=multi-user.target
EOF`;

	// Same units as scripts/systemd/storage.ts: lets the dashboard move this node's data (D48).
	const storageUnits = `sudo ln -sf skiff-agent /opt/skiff/current/agent/skiff-storage
sudo tee /etc/systemd/system/skiff-storage.path >/dev/null <<'EOF'
[Unit]
Description=Move Skiff node storage when the agent requests it
ConditionPathExists=/etc/skiff/agent.env
ConditionPathExists=/opt/skiff/current/agent/skiff-storage

[Path]
PathExists=/run/skiff/storage.request
Unit=skiff-storage.service

[Install]
WantedBy=paths.target
EOF
sudo tee /etc/systemd/system/skiff-storage.service >/dev/null <<'EOF'
[Unit]
Description=Skiff node storage move (requested from the dashboard)
ConditionPathExists=/etc/skiff/agent.env
ConditionPathExists=/opt/skiff/current/agent/skiff-storage

[Service]
Type=oneshot
ExecStartPre=/bin/rm -f /run/skiff/storage.request
ExecStart=/opt/skiff/current/agent/skiff-storage storage apply
SuccessExitStatus=1
TimeoutStartSec=6h
Nice=10
IOSchedulingClass=idle
EOF`;

	const startAgent = `sudo systemctl daemon-reload
sudo systemctl enable --now skiff-agent skiff-builder skiff-storage.path
journalctl -u skiff-agent -u skiff-builder -f`;

	const workerFirewall =
		$derived(`# Optional nftables rule on the worker: only the edge may reach Caddy.
iifname "wg0" ip saddr ${edgeIp} tcp dport ${caddyPort} accept`);

	const edgeProbe =
		$derived(`# On the edge: any HTTP status (usually 404) means the edge reaches the worker's Caddy.
curl -sS -o /dev/null -w '%{http_code}\\n' -H 'Host: ${probeHost}' http://${tunnelAddress}/`);

	const steps = [
		{ id: 'keys', title: 'Generate WireGuard keys on both machines' },
		{ id: 'edge', title: 'Configure the tunnel on the edge' },
		{ id: 'worker', title: 'Configure the tunnel on the worker' },
		{ id: 'pin', title: 'Send control-plane traffic through the tunnel' },
		{ id: 'install', title: 'Install Caddy and the agent on the worker' },
		{ id: 'join', title: 'Join the node' },
		{ id: 'verify', title: 'Verify and place a project' }
	];
</script>

<svelte:head>
	<title>Worker over WireGuard · Nodes · Skiff</title>
</svelte:head>

{#snippet stepTitle(index: number)}
	<Card.Title class="flex items-center gap-3">
		<span
			class="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs font-medium"
			>{index + 1}</span
		>
		{steps[index]!.title}
	</Card.Title>
{/snippet}

<div class="space-y-6">
	<PageHeader
		eyebrow="Nodes"
		title="Add a worker over WireGuard"
		description="Enrol a machine behind NAT, such as a homelab VM, as a worker. It dials out to the edge over WireGuard, so it needs no open ports. The edge terminates TLS and proxies that node's sites through the tunnel."
	>
		<Button href={resolve('/(dashboard)/nodes')} variant="outline">
			<ArrowLeftIcon />
			Back to nodes
		</Button>
	</PageHeader>

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Platform admin required"
			description="Enrolling nodes is a platform-level action. Ask a platform admin to add the worker."
		>
			<Button href={resolve('/(dashboard)/nodes')} variant="outline" size="sm">Back to nodes</Button
			>
		</EmptyState>
	{:else}
		{#if !data.hasEdge}
			<Notice tone="warning" title="No edge node yet">
				The first node to join becomes the edge. Finish the server install (it enrols the edge
				automatically) before you add a worker, or this machine will join as the edge.
			</Notice>
		{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title>How it fits together</Card.Title>
				<Card.Description>
					The worker opens the tunnel and keeps it alive. Everything the edge sends it travels
					inside WireGuard.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<pre
					class="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">Internet ──► edge Caddy :443 (TLS) ── reverse_proxy ──► {tunnelAddress} worker Caddy (HTTP)
                ▲                                              │
                │  wg0 {edgeIp}  ◄═══ WireGuard (UDP {wgPort}) ═══  wg0 {workerIp}
                │                                              │
   control plane {data.platformHost} ◄── agent: desired state, heartbeats, releases</pre>
				<ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
					<li>
						The edge proxies a worker-placed site to the address the node reported at join time. If
						it can't reach that address, visitors get a branded 503 with <code class="font-mono"
							>Retry-After</code
						> and the edge keeps serving everything else.
					</li>
					<li>
						The worker's agent pulls desired state from <code class="font-mono"
							>{data.platformOrigin}</code
						>. Step 4 pins that hostname to the tunnel, so the agent's traffic never crosses the
						public internet, and TLS still validates against the real certificate.
					</li>
					<li>
						Static sites only need the agent and Caddy. App workloads (tier 2/3) on the worker also
						need the privileged <code class="font-mono">skiff-helper</code> service.
					</li>
				</ul>
			</Card.Content>
		</Card.Root>

		<Panel
			title="Your values"
			icon={SlidersHorizontalIcon}
			description="Every command below updates as you type. The defaults work for a single worker."
		>
			<Field.Group>
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<Field.Field>
						<Field.Label for="vpn-name">Node name</Field.Label>
						<Input id="vpn-name" bind:value={nodeName} maxlength={64} />
						<Field.Description>Shown on the Nodes page.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="vpn-endpoint">Edge public address</Field.Label>
						<Input id="vpn-endpoint" bind:value={endpoint} placeholder={data.platformHost} />
						<Field.Description
							>Hostname or IP the worker dials. Must not be proxied (grey cloud).</Field.Description
						>
					</Field.Field>
					<Field.Field>
						<Field.Label for="vpn-port">WireGuard UDP port</Field.Label>
						<Input id="vpn-port" bind:value={wgPort} inputmode="numeric" />
					</Field.Field>
					<Field.Field>
						<Field.Label for="vpn-edge-ip">Edge tunnel IP</Field.Label>
						<Input id="vpn-edge-ip" bind:value={edgeIp} class="font-mono" />
					</Field.Field>
					<Field.Field>
						<Field.Label for="vpn-worker-ip">Worker tunnel IP</Field.Label>
						<Input id="vpn-worker-ip" bind:value={workerIp} class="font-mono" />
						<Field.Description>Use a different IP for each worker.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="vpn-caddy-port">Worker Caddy port</Field.Label>
						<Input id="vpn-caddy-port" bind:value={caddyPort} inputmode="numeric" />
						<Field.Description>Bound to the tunnel IP only.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="vpn-edge-key">Edge public key</Field.Label>
						<Input
							id="vpn-edge-key"
							bind:value={edgePublicKey}
							placeholder="from step 1, on the edge"
							class="font-mono"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="vpn-worker-key">Worker public key</Field.Label>
						<Input
							id="vpn-worker-key"
							bind:value={workerPublicKey}
							placeholder="from step 1, on the worker"
							class="font-mono"
						/>
					</Field.Field>
				</div>
			</Field.Group>
		</Panel>

		<Card.Root>
			<Card.Header>
				{@render stepTitle(0)}
				<Card.Description>
					Run this on the edge and on the worker. Only public keys are shared; each private key
					stays in its own <code class="font-mono">/etc/wireguard/wg0.key</code>.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<CodeBlock label="edge and worker" code={keygen} />
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				{@render stepTitle(1)}
				<Card.Description>
					The edge listens for the worker. Open the WireGuard port publicly, and allow HTTPS from
					the worker on <code class="font-mono">wg0</code> so its agent can reach the control plane.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				<CodeBlock label="edge · /etc/wireguard/wg0.conf" code={edgeConfig} />
				<CodeBlock label="edge" code={wgUp} />
				<CodeBlock label="edge · firewall" code={edgeFirewall} />
				<p class="text-xs text-muted-foreground">
					Adding another worker later? Append another <code class="font-mono">[Peer]</code> block
					and run <code class="font-mono">sudo systemctl reload wg-quick@wg0</code>.
				</p>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				{@render stepTitle(2)}
				<Card.Description>
					The worker dials the edge. Its router needs no port forwarding, and it works behind CGNAT.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-3">
				<CodeBlock label="worker · /etc/wireguard/wg0.conf" code={workerConfig} />
				<CodeBlock label="worker" code={wgUp} />
				<CodeBlock label="worker · check the tunnel" code={wgVerify} />
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				{@render stepTitle(3)}
				<Card.Description>
					Resolve the platform hostname to the edge's tunnel IP on the worker. The edge's Caddy
					already listens on every interface, so the same certificate is served over the tunnel.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<CodeBlock label="worker" code={hostsPin} />
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				{@render stepTitle(4)}
				<Card.Description>
					Use the same layout as an edge install, so upgrades and troubleshooting look the same on
					every node.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div class="space-y-2">
					<h3 class="text-sm font-medium">Caddy (the official repository, same as the edge)</h3>
					<CodeBlock label="worker" code={caddyInstall} />
				</div>
				<div class="space-y-2">
					<h3 class="text-sm font-medium">User and directories</h3>
					<CodeBlock label="worker" code={layout} />
				</div>
				<div class="space-y-2">
					<h3 class="text-sm font-medium">Hand Caddy to the agent</h3>
					<CodeBlock label="worker" code={caddyConfig} />
				</div>
				<div class="space-y-2">
					<h3 class="text-sm font-medium">The agent binary</h3>
					<Tabs.Root value="edge">
						<Tabs.List>
							<Tabs.Trigger value="edge">Copy from the edge</Tabs.Trigger>
							<Tabs.Trigger value="source">Build from source</Tabs.Trigger>
						</Tabs.List>
						<Tabs.Content value="edge" class="space-y-2">
							<p class="text-sm text-muted-foreground">
								Fastest when both machines share a CPU architecture. The copy goes over the tunnel.
							</p>
							<CodeBlock label="worker" code={binaryFromEdge} />
						</Tabs.Content>
						<Tabs.Content value="source" class="space-y-2">
							<p class="text-sm text-muted-foreground">
								For a different architecture. Check out the commit the edge runs (this control plane
								is <span class="font-mono">v{data.platformVersion}</span>) so the agent matches.
							</p>
							<CodeBlock label="worker" code={binaryFromSource} />
						</Tabs.Content>
					</Tabs.Root>
				</div>
				<div class="space-y-2">
					<h3 class="text-sm font-medium">Agent environment</h3>
					<CodeBlock label="worker · /etc/skiff/skiff.env" code={agentEnv} />
				</div>
				<div class="space-y-2">
					<h3 class="text-sm font-medium">systemd unit</h3>
					<CodeBlock label="worker · /etc/systemd/system/skiff-agent.service" code={agentUnit} />
				</div>
				<div class="space-y-2">
					<h3 class="text-sm font-medium">Builder unit</h3>
					<p class="text-sm text-muted-foreground">
						Lets this node run git builds once you give it the Builder role on the Nodes page. Until
						then it idles. Builds run as <code class="font-mono">skiff-build</code> in a sandboxed
						transient unit (2 GB, 200% CPU, 10 minutes), so install the toolchains they need, such as
						Node or Bun, on the worker.
					</p>
					<CodeBlock label="worker · /etc/systemd/system/skiff-builder.service" code={builderUnit} />
				</div>
				<div class="space-y-2">
					<h3 class="text-sm font-medium">Storage units</h3>
					<p class="text-sm text-muted-foreground">
						Let you move this node's release cache and build directory to another disk later from
						<span class="font-medium">Edit node</span>. The move itself runs as root on the worker.
					</p>
					<CodeBlock label="worker · skiff-storage.path + skiff-storage.service" code={storageUnits} />
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				{@render stepTitle(5)}
				<Card.Description>
					The join command registers the node with its tunnel address,
					<code class="font-mono">{tunnelAddress}</code>, which the edge then proxies to. The
					address is set at join time; change it later with <span class="font-medium">Edit node</span> on
					the Nodes page.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<form
					method="POST"
					action="?/createToken"
					class="flex flex-wrap items-center gap-3"
					use:enhance={() => {
						pending = true;
						return async ({ result: actionResult, update }) => {
							await update({ reset: false });
							pending = false;
							if (actionResult.type === 'success') notify(actionResult);
						};
					}}
				>
					<input type="hidden" name="name" value={nodeName.trim()} />
					<input type="hidden" name="publicAddress" value={tunnelAddress} />
					<Button type="submit" disabled={pending}>
						{#if pending}<Spinner />{:else}<KeyRoundIcon />{/if}
						Generate join command
					</Button>
					<span class="text-xs text-muted-foreground">
						Single-use, expires after one hour. Joins as <span class="font-mono"
							>{nodeName.trim()}</span
						>.
					</span>
				</form>

				{#if result?.message}
					<Notice tone="danger">
						{result.message}
						{#if result.fieldErrors}
							{#each Object.values(result.fieldErrors) as error (error)}
								<span class="block">{error}</span>
							{/each}
						{/if}
					</Notice>
				{/if}

				{#if result?.command}
					<CodeBlock label="worker · join" code={result.command} />
					{#if result.expiresAt}
						<p class="text-xs text-muted-foreground">
							Expires <time datetime={result.expiresAt}>{formatDateTime(result.expiresAt)}</time>.
						</p>
					{/if}
				{/if}

				<div class="space-y-2">
					<h3 class="text-sm font-medium">Then start the agent</h3>
					<CodeBlock label="worker" code={startAgent} />
				</div>
				<CodeBlock label="worker · firewall" code={workerFirewall} />
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				{@render stepTitle(6)}
				<Card.Description>
					The node appears on the Nodes page as a worker after its first heartbeat, with
					<code class="font-mono">{tunnelAddress}</code> as its address.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<CodeBlock label="edge" code={edgeProbe} />
				<p class="text-sm text-muted-foreground">
					To serve a project from the worker, open the project, set <span class="font-medium"
						>Placement</span
					> to this node and save. The edge then proxies that project's hostnames through the tunnel.
				</p>

				{#if data.workers.length > 0}
					<div class="space-y-2">
						<h3 class="text-sm font-medium">Workers enrolled now</h3>
						<ul class="divide-y rounded-md border">
							{#each data.workers as worker (worker.id)}
								<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
									<span class="flex items-center gap-2 text-sm">
										<ServerIcon class="size-4 text-muted-foreground" />
										{worker.name}
									</span>
									<span class="flex items-center gap-3">
										<span class="font-mono text-xs text-muted-foreground"
											>{worker.publicAddress ?? 'no address reported'}</span
										>
										<StatusBadge status={worker.status} />
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="space-y-2">
					<h3 class="text-sm font-medium">If something is wrong</h3>
					<dl class="divide-y rounded-md border text-sm">
						{#each [{ symptom: 'Join fails with “Could not reach”', fix: `Check the tunnel (sudo wg show), the /etc/hosts pin, and that the edge allows TCP 443 on wg0 from ${workerIp}.` }, { symptom: 'Node shows offline', fix: 'A handshake older than about 2 minutes means the tunnel dropped: check Endpoint and PersistentKeepalive. Otherwise read journalctl -u skiff-agent.' }, { symptom: 'Sites on the worker return 503', fix: `The edge can't dial ${tunnelAddress}. Run the probe above from the edge, and check Caddy on the worker with ss -ltn | grep ${caddyPort}. A wrong address on the node card needs a fresh join.` }, { symptom: 'Agent logs “Caddy admin … failed”', fix: 'ls -l /var/lib/caddy/admin.sock must show group rw, and id skiff must list the caddy group.' }, { symptom: 'Release downloads fail', fix: 'With the R2 object store the worker downloads artifacts from Cloudflare directly, so it needs outbound HTTPS to the internet.' }] as row (row.symptom)}
							<div class="grid gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr] sm:gap-4">
								<dt class="font-medium">{row.symptom}</dt>
								<dd class="text-muted-foreground">{row.fix}</dd>
							</div>
						{/each}
					</dl>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
