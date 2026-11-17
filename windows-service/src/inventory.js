'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { requestJson } = require('./http');

const execFileAsync = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 20_000;

function round(value) {
  return Math.round(value * 100) / 100;
}

function firstArrayValue(values) {
  if (!Array.isArray(values)) return null;
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

async function readWindowsDetails() {
  if (process.platform !== 'win32') return {};

  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    '$bios = Get-CimInstance -ClassName Win32_BIOS',
    '$volumes = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {',
    '  [pscustomobject]@{',
    '    device_id = $_.DeviceID',
    '    volume_name = $_.VolumeName',
    '    file_system = $_.FileSystem',
    '    size_bytes = [double]$_.Size',
    '    free_bytes = [double]$_.FreeSpace',
    '  }',
    '})',
    '$adapters = @(Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" | ForEach-Object {',
    '  [pscustomobject]@{',
    '    description = $_.Description',
    '    mac_address = $_.MACAddress',
    '    ip_addresses = @($_.IPAddress)',
    '    dhcp_enabled = [bool]$_.DHCPEnabled',
    '    dns_servers = @($_.DNSServerSearchOrder)',
    '  }',
    '})',
    '$softwarePaths = @(',
    '  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
    '  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"',
    ')',
    '$software = @(Get-ItemProperty $softwarePaths | Where-Object { $_.DisplayName } | Sort-Object DisplayName | Select-Object -First 300 | ForEach-Object {',
    '  [pscustomobject]@{',
    '    name = $_.DisplayName',
    '    version = $_.DisplayVersion',
    '    publisher = $_.Publisher',
    '    install_date = $_.InstallDate',
    '  }',
    '})',
    '[pscustomobject]@{',
    '  os_name = $os.Caption',
    '  os_version = $os.Version',
    '  os_build = $os.BuildNumber',
    '  os_arch = $os.OSArchitecture',
    '  logged_in_user = $cs.UserName',
    '  domain = $cs.Domain',
    '  manufacturer = $cs.Manufacturer',
    '  model = $cs.Model',
    '  serial_number = $bios.SerialNumber',
    '  volumes = $volumes',
    '  network_adapters = $adapters',
    '  installed_software = $software',
    '  installed_software_count = $software.Count',
    '} | ConvertTo-Json -Depth 6 -Compress'
  ].join('\n');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function collectInventory(options = {}) {
  const { agentVersion } = options;
  const cpus = os.cpus();
  const windowsDetails = await readWindowsDetails();
  const adapters = Array.isArray(windowsDetails.network_adapters)
    ? windowsDetails.network_adapters
    : [];
  const software = Array.isArray(windowsDetails.installed_software)
    ? windowsDetails.installed_software
    : [];
  const primaryAdapter =
    adapters.find((adapter) => firstArrayValue(adapter.ip_addresses)) || adapters[0] || {};

  return {
    hostname: os.hostname(),
    os_name: windowsDetails.os_name || (process.platform === 'win32' ? 'Windows' : os.type()),
    os_version: windowsDetails.os_version || os.release(),
    os_build: windowsDetails.os_build || null,
    os_arch: windowsDetails.os_arch || os.arch(),
    platform: process.platform,
    arch: os.arch(),
    cpu_count: cpus.length,
    cpu_model: cpus[0]?.model || null,
    total_memory_bytes: os.totalmem(),
    free_memory_bytes: os.freemem(),
    uptime_seconds: round(os.uptime()),
    logged_in_user: windowsDetails.logged_in_user || null,
    domain: windowsDetails.domain || null,
    manufacturer: windowsDetails.manufacturer || null,
    model: windowsDetails.model || null,
    serial_number: windowsDetails.serial_number || null,
    mac_address: primaryAdapter.mac_address || null,
    ip_addresses: firstArrayValue(primaryAdapter.ip_addresses)
      ? primaryAdapter.ip_addresses
      : [],
    volumes: Array.isArray(windowsDetails.volumes) ? windowsDetails.volumes : [],
    network_adapters: adapters,
    installed_software: software,
    installed_software_count: windowsDetails.installed_software_count ?? software.length,
    agent_version: agentVersion || null,
    collected_at: new Date().toISOString()
  };
}

async function sendInventory(options) {
  const { config, credentials, logger } = options;

  if (!credentials?.deviceToken) {
    throw new Error('Cannot send inventory without a device token');
  }

  const snapshot = await collectInventory({ agentVersion: config.agentVersion });

  await requestJson(`${config.apiBase}/device/inventory`, {
    method: 'POST',
    token: credentials.deviceToken,
    body: { snapshot },
    timeoutMs: config.httpTimeoutMs
  });

  logger?.info(`Inventory uploaded (hostname=${snapshot.hostname}, cpus=${snapshot.cpu_count})`);
  return snapshot;
}

module.exports = { collectInventory, sendInventory };
