import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  HardDrive,
  Loader2,
  Lock,
  Monitor,
  Network,
  Package,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import api from '../../services/api';
import { Card, CardBody } from '../common/Card';
import { Button } from '../common/Button';

const STATUS_META = {
  online: { label: 'Online', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', Icon: Wifi },
  active: { label: 'Active', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', Icon: Wifi },
  connected: { label: 'Connected', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', Icon: Wifi },
  pending: { label: 'Pending', color: '#b45309', bg: '#fffbeb', border: '#fde68a', Icon: Clock },
  offline: { label: 'Offline', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0', Icon: WifiOff },
  disabled: { label: 'Disabled', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca', Icon: WifiOff },
  unknown: { label: 'Unknown', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0', Icon: WifiOff },
};

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'online', label: 'Online' },
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'offline', label: 'Offline' },
  { value: 'disabled', label: 'Disabled' },
];

const COMMAND_META = {
  lock: {
    label: 'Lock',
    title: 'Lock device?',
    description: 'The workstation will be locked immediately.',
    done: 'Lock command sent to',
    Icon: Lock,
  },
  restart: {
    label: 'Restart',
    title: 'Restart device?',
    description: 'The device will restart and may be unavailable for a short while.',
    done: 'Restart command sent to',
    Icon: RotateCcw,
  },
  shutdown: {
    label: 'Shut down',
    title: 'Shut down device?',
    description: 'The device will power off and stay offline until someone turns it back on.',
    done: 'Shutdown command sent to',
    Icon: Power,
  },
};

const GRID_COLUMNS =
  'minmax(215px, 1.6fr) 112px 150px minmax(140px, 1fr) minmax(120px, 0.9fr) 132px 104px 176px';

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asText(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    return firstValue(
      value.name,
      value.full_name,
      value.username,
      value.email,
      value.hostname,
      value.label,
    );
  }
  return undefined;
}

function pickList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  const nested = firstValue(payload.data, payload.result, payload.response);
  if (nested && typeof nested === 'object') {
    return pickList(nested, ...keys);
  }
  return [];
}

function errorMessage(err, fallback) {
  const data = err?.response?.data;
  if (typeof data === 'string' && data.trim()) return data;
  return data?.error || data?.message || err?.message || fallback;
}

function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getDeviceStatus(device) {
  const raw = firstValue(
    device?.status,
    device?.state,
    device?.connection_status,
    device?.connectionStatus,
  );
  if (raw !== undefined) return normalizeStatus(raw);
  const flag = firstValue(device?.is_online, device?.online, device?.connected);
  if (flag === true) return 'online';
  if (flag === false) return 'offline';
  return 'unknown';
}

function statusMeta(status) {
  const key = normalizeStatus(status);
  if (STATUS_META[key]) return { ...STATUS_META[key], key };
  if (key === 'inactive') return { ...STATUS_META.offline, key };
  if (key.includes('online') || key.includes('active') || key.includes('connected')) {
    return { ...STATUS_META.online, key };
  }
  if (key.includes('pending') || key.includes('provision') || key.includes('enroll')) {
    return { ...STATUS_META.pending, key };
  }
  if (key.includes('disable') || key.includes('revok')) {
    return { ...STATUS_META.disabled, key };
  }
  return { ...STATUS_META.unknown, label: status ? String(status) : 'Unknown', key };
}

function isOnlineStatus(key) {
  return key === 'online' || key === 'active' || key === 'connected' || key.includes('online');
}

function isPendingStatus(key) {
  return key.includes('pending') || key.includes('provision') || key.includes('enroll');
}

function deviceIdOf(device) {
  return firstValue(device?.id, device?.device_id, device?.deviceId);
}

function deviceNameOf(device) {
  const name = asText(
    firstValue(
      device?.hostname,
      device?.name,
      device?.computer_name,
      device?.device_name,
      device?.machine_name,
    ),
  );
  if (name) return name;
  const id = deviceIdOf(device);
  return id !== undefined ? `Device #${id}` : 'Unnamed device';
}

function isUnassigned(device) {
  return (
    firstValue(
      device?.assigned_user_id,
      device?.user_id,
      device?.assigned_user?.id,
      device?.user?.id,
      device?.assigned_user_name,
      device?.assigned_to_name,
      device?.last_user,
      device?.username,
    ) === undefined
  );
}

function deviceFields(device) {
  const d = device || {};
  return {
    hostname: deviceNameOf(d),
    os:
      asText(firstValue(d.os_name, d.os, d.operating_system, d.platform)) ||
      '—',
    osVersion: asText(firstValue(d.os_version, d.osVersion)),
    agentVersion: asText(
      firstValue(
        d.agent_version,
        d.agentVersion,
        d.agent?.version,
        d.version,
      ),
    ),
    ip: asText(firstValue(d.ip_address, d.ip, d.local_ip, d.last_ip)),
    mac: asText(firstValue(d.mac_address, d.mac, d.macAddress)),
    serial: asText(firstValue(d.serial_number, d.serialNumber, d.serial)),
    group: firstValue(
      asText(d.group),
      asText(d.group_name),
      asText(d.groupName),
    ),
    assigned: firstValue(
      asText(d.assigned_user),
      asText(d.user),
      asText(d.assigned_user_name),
      asText(d.assigned_to_name),
      asText(d.last_user),
      asText(d.username),
      asText(d.assigned_to),
    ),
    lastSeen: firstValue(d.last_seen_at, d.last_seen, d.lastSeen, d.last_heartbeat_at),
    enrolledAt: firstValue(
      d.enrolled_at,
      d.enrollment_at,
      d.enrolledAt,
      d.created_at,
      d.createdAt,
    ),
  };
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-PK', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatLastSeen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return formatDateTime(value);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDateTime(value);
}

function unwrapDevice(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.device && typeof payload.device === 'object') return payload.device;
  if (payload.data) {
    if (payload.data.device && typeof payload.data.device === 'object') {
      return payload.data.device;
    }
    if (typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      return payload.data;
    }
  }
  return payload;
}

function groupIdOf(group) {
  return firstValue(group?.id, group?.group_id, group?.groupId);
}

function groupNameOf(group) {
  return (
    asText(firstValue(group?.name, group?.group_name, group?.groupName)) ||
    'Unnamed group'
  );
}

function groupValueOf(device) {
  const value = firstValue(device?.group_id, device?.group?.id, device?.groupId);
  return value === undefined ? '' : String(value);
}

function groupCountOf(group) {
  const value = firstValue(
    group?.device_count,
    group?.deviceCount,
    group?._count?.devices,
    0,
  );
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function groupOnlineCountOf(group) {
  const value = firstValue(group?.online_count, group?.onlineCount, 0);
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function inventorySnapshotOf(device) {
  const inventory = device?.inventory;
  if (Array.isArray(inventory) && inventory.length > 0) {
    const latest = inventory[0];
    if (latest?.snapshot && typeof latest.snapshot === 'object') {
      return latest.snapshot;
    }
    if (latest && typeof latest === 'object') return latest;
  }
  const fallback = firstValue(
    device?.inventory_snapshot,
    device?.latest_inventory?.snapshot,
  );
  return fallback && typeof fallback === 'object' ? fallback : {};
}

function firstIpAddress(snapshot) {
  const values = Array.isArray(snapshot?.ip_addresses)
    ? snapshot.ip_addresses
    : [];
  return (
    values.find((value) => typeof value === 'string' && value.includes('.')) ||
    values.find((value) => typeof value === 'string' && value.trim()) ||
    undefined
  );
}

function inventoryFields(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const network = Array.isArray(s.network_adapters) ? s.network_adapters : [];
  const primaryNetwork = network[0] || {};
  const software = Array.isArray(s.installed_software)
    ? s.installed_software
    : [];
  const softwareCount = Number(
    firstValue(s.installed_software_count, s.software_count, software.length),
  );

  return {
    collectedAt: firstValue(s.collected_at, s.collectedAt),
    osBuild: asText(firstValue(s.os_build, s.osBuild, s.build)),
    osArch: asText(firstValue(s.os_arch, s.osArch, s.arch)),
    manufacturer: asText(s.manufacturer),
    model: asText(s.model),
    serial: asText(firstValue(s.serial_number, s.serial, s.serialNumber)),
    cpuModel: asText(firstValue(s.cpu_model, s.cpuModel, s.cpu)),
    cpuCount: firstValue(s.cpu_count, s.cpuCount),
    memoryTotalBytes: firstValue(
      s.total_memory_bytes,
      s.totalMemoryBytes,
      s.memory_bytes,
    ),
    memoryFreeBytes: firstValue(s.free_memory_bytes, s.freeMemoryBytes),
    uptimeSeconds: firstValue(s.uptime_seconds, s.uptimeSeconds, s.uptime),
    loggedInUser: asText(
      firstValue(s.logged_in_user, s.loggedInUser, s.user),
    ),
    domain: asText(s.domain),
    mac: asText(
      firstValue(s.mac_address, s.macAddress, primaryNetwork.mac_address),
    ),
    ip: asText(firstValue(firstIpAddress(s), primaryNetwork.ip_address)),
    volumes: Array.isArray(s.volumes) ? s.volumes : [],
    network,
    software,
    softwareCount: Number.isFinite(softwareCount)
      ? softwareCount
      : software.length,
  };
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatUptime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function DevicesTab({ user }) {
  const mountedRef = useRef(true);

  const [devices, setDevices] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollHours, setEnrollHours] = useState('24');
  const [enrollMaxUses, setEnrollMaxUses] = useState('1');
  const [enrollSaving, setEnrollSaving] = useState(false);
  const [enrollError, setEnrollError] = useState('');
  const [enrollToken, setEnrollToken] = useState(null);
  const [copied, setCopied] = useState(false);

  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupError, setGroupError] = useState('');

  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editGroupName, setEditGroupName] = useState('');
  const [editGroupDescription, setEditGroupDescription] = useState('');
  const [groupActionBusy, setGroupActionBusy] = useState(null);
  const [groupActionError, setGroupActionError] = useState('');

  const [confirmAction, setConfirmAction] = useState(null);
  const [commandBusy, setCommandBusy] = useState(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailDevice, setDetailDevice] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [groupDraft, setGroupDraft] = useState('');
  const [groupSaveBusy, setGroupSaveBusy] = useState(false);
  const [groupSaveError, setGroupSaveError] = useState('');
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [recoveryKeys, setRecoveryKeys] = useState(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchDevices = useCallback(
    async ({ quiet = false } = {}) => {
      if (quiet) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const params = {};
        if (statusFilter !== 'all') params.status = statusFilter;
        if (groupFilter !== 'all') params.group_id = groupFilter;
        if (search.trim()) params.search = search.trim();

        const res = await api.getDevices(params);
        if (!mountedRef.current) return;
        setDevices(pickList(res?.data, 'devices', 'items', 'results', 'data'));
        setError('');
      } catch (err) {
        if (!mountedRef.current) return;
        setError(errorMessage(err, 'Failed to load devices.'));
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [statusFilter, groupFilter, search],
  );

  const fetchGroups = useCallback(async () => {
    try {
      const res = await api.getDeviceGroups();
      if (!mountedRef.current) return;
      setGroups(pickList(res?.data, 'groups', 'device_groups', 'items', 'results', 'data'));
    } catch (err) {
      console.warn('[DevicesTab] Failed to load groups:', err?.message);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    const delay = search.trim() ? 300 : 0;
    const timer = setTimeout(() => {
      fetchDevices();
    }, delay);
    return () => clearTimeout(timer);
  }, [fetchDevices, search]);

  useEffect(() => {
    const timer = setInterval(() => {
      fetchDevices({ quiet: true });
    }, 20000);
    return () => clearInterval(timer);
  }, [fetchDevices]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const summary = useMemo(() => {
    let online = 0;
    let pending = 0;
    let unassigned = 0;
    devices.forEach((device) => {
      const key = getDeviceStatus(device);
      if (isOnlineStatus(key)) online += 1;
      if (isPendingStatus(key)) pending += 1;
      if (isUnassigned(device)) unassigned += 1;
    });
    return { total: devices.length, online, pending, unassigned };
  }, [devices]);

  const hasFilters =
    Boolean(search.trim()) || statusFilter !== 'all' || groupFilter !== 'all';

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setGroupFilter('all');
  };

  const openEnrollment = () => {
    setEnrollOpen(true);
    setEnrollHours('24');
    setEnrollMaxUses('1');
    setEnrollError('');
    setEnrollToken(null);
    setCopied(false);
  };

  const closeEnrollment = () => {
    if (enrollSaving) return;
    setEnrollOpen(false);
    setEnrollError('');
    setEnrollToken(null);
    setCopied(false);
  };

  const submitEnrollment = async (event) => {
    event.preventDefault();
    if (enrollSaving) return;

    const hours = Number(enrollHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      setEnrollError('Expiry must be a positive number of hours.');
      return;
    }
    let maxUses;
    if (String(enrollMaxUses).trim() !== '') {
      maxUses = Number(enrollMaxUses);
      if (!Number.isInteger(maxUses) || maxUses < 1) {
        setEnrollError('Max uses must be a whole number of at least 1.');
        return;
      }
    }

    setEnrollSaving(true);
    setEnrollError('');
    try {
      const payload = { expires_in_hours: hours };
      if (maxUses !== undefined) payload.max_uses = maxUses;

      const res = await api.createDeviceEnrollmentToken(payload);
      if (!mountedRef.current) return;

      const data = res?.data ?? {};
      const token =
        typeof data === 'string'
          ? data
          : firstValue(
              data.token,
              data.enrollment_token,
              data.enrollmentToken,
              data.data?.token,
            );
      if (!token) {
        throw new Error('The server did not return an enrollment token.');
      }
      const expiresAt =
        typeof data === 'object'
          ? firstValue(data.expires_at, data.expiresAt, data.data?.expires_at)
          : undefined;

      setEnrollToken({
        token,
        expiresAt,
        maxUses: firstValue(data.max_uses, data.maxUses, maxUses),
      });
      setCopied(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setEnrollError(errorMessage(err, 'Failed to create an enrollment token.'));
    } finally {
      if (mountedRef.current) setEnrollSaving(false);
    }
  };

  const copyEnrollmentToken = async () => {
    if (!enrollToken?.token) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(enrollToken.token);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = enrollToken.token;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const openGroupModal = () => {
    setGroupOpen(true);
    setGroupName('');
    setGroupDescription('');
    setGroupError('');
  };

  const closeGroupModal = () => {
    if (groupSaving) return;
    setGroupOpen(false);
    setGroupError('');
  };

  const submitGroup = async (event) => {
    event.preventDefault();
    if (groupSaving) return;
    const name = groupName.trim();
    if (!name) {
      setGroupError('Group name is required.');
      return;
    }

    setGroupSaving(true);
    setGroupError('');
    try {
      await api.createDeviceGroup({
        name,
        description: groupDescription.trim() || undefined,
      });
      if (!mountedRef.current) return;
      setGroupOpen(false);
      setNotice({ type: 'success', text: `Group "${name}" created.` });
      await fetchGroups();
      fetchDevices({ quiet: true });
    } catch (err) {
      if (!mountedRef.current) return;
      setGroupError(errorMessage(err, 'Failed to create the group.'));
    } finally {
      if (mountedRef.current) setGroupSaving(false);
    }
  };

  const openGroupManager = () => {
    setGroupManagerOpen(true);
    setEditingGroupId(null);
    setEditGroupName('');
    setEditGroupDescription('');
    setGroupActionError('');
  };

  const closeGroupManager = () => {
    if (groupActionBusy !== null) return;
    setGroupManagerOpen(false);
    setEditingGroupId(null);
    setGroupActionError('');
  };

  const startEditGroup = (group) => {
    const id = groupIdOf(group);
    if (id === undefined || id === null) return;
    setEditingGroupId(String(id));
    setEditGroupName(groupNameOf(group));
    setEditGroupDescription(asText(group?.description) || '');
    setGroupActionError('');
  };

  const cancelEditGroup = () => {
    if (groupActionBusy !== null) return;
    setEditingGroupId(null);
    setEditGroupName('');
    setEditGroupDescription('');
    setGroupActionError('');
  };

  const saveGroupEdit = async (event) => {
    event.preventDefault();
    if (editingGroupId === null || groupActionBusy !== null) return;

    const name = editGroupName.trim();
    if (!name) {
      setGroupActionError('Group name is required.');
      return;
    }

    setGroupActionBusy(editingGroupId);
    setGroupActionError('');
    try {
      await api.updateDeviceGroup(editingGroupId, {
        name,
        description: editGroupDescription.trim() || null,
      });
      if (!mountedRef.current) return;
      setNotice({ type: 'success', text: `Group "${name}" updated.` });
      setEditingGroupId(null);
      await fetchGroups();
      fetchDevices({ quiet: true });
    } catch (err) {
      if (!mountedRef.current) return;
      setGroupActionError(errorMessage(err, 'Failed to update the group.'));
    } finally {
      if (mountedRef.current) setGroupActionBusy(null);
    }
  };

  const removeGroup = async (group) => {
    const id = groupIdOf(group);
    if (id === undefined || id === null || groupActionBusy !== null) return;

    const name = groupNameOf(group);
    const count = groupCountOf(group);
    const message =
      count > 0
        ? `Delete "${name}"? ${count} device${count === 1 ? '' : 's'} will become ungrouped.`
        : `Delete "${name}"?`;

    if (!window.confirm(message)) return;

    setGroupActionBusy(String(id));
    setGroupActionError('');
    try {
      await api.deleteDeviceGroup(id);
      if (!mountedRef.current) return;
      setNotice({
        type: 'success',
        text:
          count > 0
            ? `Group "${name}" deleted; ${count} device${count === 1 ? '' : 's'} ungrouped.`
            : `Group "${name}" deleted.`,
      });
      if (String(groupFilter) === String(id)) {
        setGroupFilter('all');
      }
      setEditingGroupId(null);
      await fetchGroups();
      if (String(groupFilter) !== String(id)) {
        fetchDevices({ quiet: true });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setGroupActionError(errorMessage(err, 'Failed to delete the group.'));
    } finally {
      if (mountedRef.current) setGroupActionBusy(null);
    }
  };

  const saveDeviceGroup = async () => {
    if (!detailDevice || groupSaveBusy) return;
    const id = deviceIdOf(detailDevice);
    if (id === undefined || id === null) {
      setGroupSaveError('This device has no id.');
      return;
    }

    setGroupSaveBusy(true);
    setGroupSaveError('');
    try {
      const res = await api.updateDevice(id, {
        group_id: groupDraft ? groupDraft : null,
      });
      if (!mountedRef.current) return;

      const updated = unwrapDevice(res?.data);
      setDetailDevice((previous) => ({ ...(previous || {}), ...updated }));
      setGroupDraft(groupValueOf(updated));
      setDevices((previous) =>
        previous.map((device) =>
          String(deviceIdOf(device)) === String(id)
            ? { ...device, ...updated }
            : device,
        ),
      );
      setNotice({
        type: 'success',
        text: groupDraft
          ? `Device moved to ${groupNameOf(updated.group || { id: groupDraft })}.`
          : 'Device removed from its group.',
      });
      await fetchGroups();
      fetchDevices({ quiet: true });
    } catch (err) {
      if (!mountedRef.current) return;
      setGroupSaveError(errorMessage(err, 'Failed to update the device group.'));
    } finally {
      if (mountedRef.current) setGroupSaveBusy(false);
    }
  };

  const showRecoveryKeys = async () => {
    setRecoveryBusy(true);
    setRecoveryError('');
    try {
      const res = await api.getDeviceRecoveryKeys(deviceIdOf(detailDevice));
      if (mountedRef.current) setRecoveryKeys(res.data?.keys || []);
    } catch (err) {
      if (mountedRef.current) {
        setRecoveryError(errorMessage(err, 'Could not load the recovery key.'));
      }
    }
    if (mountedRef.current) setRecoveryBusy(false);
  };

  const openDetails = async (device) => {
    const id = deviceIdOf(device);
    setRecoveryKeys(null);
    setRecoveryError('');
    setDetailOpen(true);
    setDetailDevice(device);
    setDetailError('');
    setGroupDraft(groupValueOf(device));
    setGroupSaveError('');
    setAuditEntries([]);
    setAuditError('');
    setDetailLoading(true);
    setAuditLoading(true);

    if (id === undefined || id === null) {
      setDetailLoading(false);
      setAuditLoading(false);
      setDetailError('This device has no id.');
      return;
    }

    const [deviceResult, auditResult] = await Promise.allSettled([
      api.getDevice(id),
      api.getDeviceAudit({ device_id: id, limit: 25 }),
    ]);
    if (!mountedRef.current) return;

    if (deviceResult.status === 'fulfilled') {
      const loaded = unwrapDevice(deviceResult.value?.data);
      setDetailDevice(loaded);
      setGroupDraft(groupValueOf(loaded));
    } else {
      setDetailError(
        errorMessage(deviceResult.reason, 'Failed to load the full device record.'),
      );
    }
    setDetailLoading(false);

    if (auditResult.status === 'fulfilled') {
      setAuditEntries(
        pickList(auditResult.value?.data, 'audit', 'logs', 'entries', 'items', 'results', 'data'),
      );
    } else {
      setAuditError(errorMessage(auditResult.reason, 'Audit log unavailable.'));
    }
    setAuditLoading(false);
  };

  const closeDetails = () => {
    setRecoveryKeys(null);
    setRecoveryError('');
    setDetailOpen(false);
    setDetailDevice(null);
    setDetailError('');
    setGroupDraft('');
    setGroupSaveError('');
    setAuditEntries([]);
    setAuditError('');
  };

  const runConfirmedCommand = async () => {
    if (!confirmAction) return;
    const { device, type } = confirmAction;
    const id = deviceIdOf(device);
    if (id === undefined || id === null) {
      setNotice({ type: 'error', text: 'This device has no id.' });
      setConfirmAction(null);
      return;
    }

    setCommandBusy(String(id));
    try {
      await api.sendDeviceCommand(id, { type });
      if (!mountedRef.current) return;
      const meta = COMMAND_META[type] ?? COMMAND_META.lock;
      setNotice({
        type: 'success',
        text: `${meta.done} ${deviceNameOf(device)}.`,
      });
      setConfirmAction(null);
      fetchDevices({ quiet: true });
    } catch (err) {
      if (!mountedRef.current) return;
      setNotice({
        type: 'error',
        text: errorMessage(err, 'Failed to send the command.'),
      });
    } finally {
      if (mountedRef.current) setCommandBusy(null);
    }
  };

  const detailInfo = useMemo(() => deviceFields(detailDevice), [detailDevice]);
  const detailInventory = useMemo(
    () => inventoryFields(inventorySnapshotOf(detailDevice)),
    [detailDevice],
  );

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-neutral-900">
            <Monitor size={22} className="text-primary-600" />
            Devices
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Manage enrolled desktop agents, issue commands, and enroll new devices.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchDevices()}
            disabled={loading}
            className="shadow-sm"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
          <Button size="sm" onClick={openEnrollment} className="shadow-sm">
            <Plus size={15} />
            Enroll device
          </Button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryCard icon={Monitor} label="Total devices" value={summary.total} accent="#4f46e5" />
        <SummaryCard icon={Wifi} label="Online / active" value={summary.online} accent="#059669" />
        <SummaryCard icon={Clock} label="Pending" value={summary.pending} accent="#d97706" />
        <SummaryCard icon={Users} label="Unassigned" value={summary.unassigned} accent="#64748b" />
      </div>

      {notice && (
        <div
          className={`mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
            notice.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {notice.type === 'error' ? (
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          )}
          <span className="flex-1 break-words">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded p-0.5 hover:bg-black/5"
            aria-label="Dismiss message"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={() => fetchDevices()}
            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-[200px] flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search hostname, user, OS…"
            aria-label="Search devices"
            className="w-full rounded-lg border border-neutral-200 bg-white py-2 pl-9 pr-9 text-sm text-neutral-800 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter by status"
          className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={groupFilter}
          onChange={(event) => setGroupFilter(event.target.value)}
          aria-label="Filter by group"
          className="max-w-[15rem] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
        >
          <option value="all">All groups</option>
          {groups.map((group, index) => {
            const id = groupIdOf(group);
            return (
              <option key={id ?? `group-${index}`} value={id ?? ''}>
                {groupNameOf(group)} ({groupCountOf(group)})
              </option>
            );
          })}
        </select>

        <button
          type="button"
          onClick={openGroupManager}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
        >
          <Settings2 size={15} className="text-neutral-500" />
          Manage groups
        </button>

        <button
          type="button"
          onClick={openGroupModal}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
        >
          <Users size={15} className="text-neutral-500" />
          New group
        </button>
      </div>

      {loading && devices.length === 0 ? (
        <Card>
          <CardBody className="flex items-center justify-center gap-2 py-12 text-neutral-500">
            <Loader2 size={20} className="animate-spin" />
            Loading devices…
          </CardBody>
        </Card>
      ) : devices.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Monitor size={42} className="text-neutral-300" />
            <div>
              <p className="font-semibold text-neutral-800">
                {hasFilters ? 'No matching devices' : 'No devices enrolled yet'}
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                {hasFilters
                  ? 'Try changing your search or filters.'
                  : 'Generate an enrollment token and install the agent on a desktop.'}
              </p>
            </div>
            {hasFilters ? (
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <Button size="sm" onClick={openEnrollment}>
                <Plus size={15} />
                Enroll device
              </Button>
            )}
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {devices.length} device{devices.length === 1 ? '' : 's'}
              </p>
              {refreshing && (
                <span className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <Loader2 size={11} className="animate-spin" />
                  Updating…
                </span>
              )}
            </div>
            <p className="text-[11px] text-neutral-400">
              Remote control is available in Phase 4
            </p>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[980px]">
              <div
                className="grid items-center gap-3 bg-neutral-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500"
                style={{ gridTemplateColumns: GRID_COLUMNS }}
              >
                <span>Device</span>
                <span>Status</span>
                <span>OS</span>
                <span>Assigned to</span>
                <span>Group</span>
                <span>Last seen</span>
                <span>Agent</span>
                <span className="text-right">Actions</span>
              </div>

              <div className="divide-y divide-neutral-100">
                {devices.map((device, index) => {
                  const id = deviceIdOf(device);
                  const name = deviceNameOf(device);
                  const fields = deviceFields(device);
                  const status = getDeviceStatus(device);
                  const meta = statusMeta(status);
                  const busy = commandBusy !== null && String(commandBusy) === String(id);
                  const osLabel = fields.osVersion
                    ? `${fields.os} ${fields.osVersion}`
                    : fields.os;

                  return (
                    <div
                      key={id ?? `device-${index}`}
                      className="grid items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                      style={{ gridTemplateColumns: GRID_COLUMNS }}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                          <Monitor size={17} />
                        </div>
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => openDetails(device)}
                            className="block max-w-full truncate text-left text-sm font-semibold text-neutral-900 hover:text-primary-600"
                            title={name}
                          >
                            {name}
                          </button>
                          <p className="truncate text-[11px] text-neutral-400">
                            {id !== undefined ? `ID ${id}` : 'No id'}
                            {fields.ip ? ` · ${fields.ip}` : ''}
                          </p>
                        </div>
                      </div>

                      <StatusPill meta={meta} />

                      <span className="truncate text-sm text-neutral-700" title={osLabel}>
                        {osLabel}
                      </span>

                      <span
                        className="truncate text-sm text-neutral-700"
                        title={fields.assigned || 'Unassigned'}
                      >
                        {fields.assigned || (
                          <span className="text-neutral-400">Unassigned</span>
                        )}
                      </span>

                      <span
                        className="truncate text-sm text-neutral-700"
                        title={fields.group || 'No group'}
                      >
                        {fields.group || <span className="text-neutral-400">No group</span>}
                      </span>

                      <span
                        className="truncate text-sm text-neutral-700"
                        title={formatDateTime(fields.lastSeen)}
                      >
                        {formatLastSeen(fields.lastSeen)}
                      </span>

                      <span
                        className="truncate text-xs text-neutral-500"
                        title={fields.agentVersion || 'Unknown'}
                      >
                        {fields.agentVersion || '—'}
                      </span>

                      <div className="flex items-center justify-end gap-1">
                        <ActionIcon
                          label="View details"
                          onClick={() => openDetails(device)}
                        >
                          <ChevronRight size={15} />
                        </ActionIcon>
                        <ActionIcon
                          label="Lock device"
                          onClick={() =>
                            setConfirmAction({ device, type: 'lock' })
                          }
                          disabled={busy}
                        >
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                        </ActionIcon>
                        <ActionIcon
                          label="Restart device"
                          onClick={() =>
                            setConfirmAction({ device, type: 'restart' })
                          }
                          disabled={busy}
                        >
                          <RotateCcw size={14} />
                        </ActionIcon>
                        <ActionIcon
                          label="Shut down device"
                          danger
                          onClick={() =>
                            setConfirmAction({ device, type: 'shutdown' })
                          }
                          disabled={busy}
                        >
                          <Power size={14} />
                        </ActionIcon>
                        <ActionIcon
                          label="Remote control — available in Phase 4"
                          disabled
                        >
                          <Monitor size={14} />
                        </ActionIcon>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>
      )}

      {enrollOpen && (
        <Dialog
          title={enrollToken ? 'Enrollment token' : 'Enroll a device'}
          subtitle={
            enrollToken
              ? 'Paste this token into the aceHRM agent on the target machine.'
              : 'Generate a token, then run the aceHRM agent installer on the device.'
          }
          onClose={closeEnrollment}
          width={560}
          footer={
            enrollToken ? (
              <Button size="sm" onClick={closeEnrollment}>
                Done
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={closeEnrollment}
                  disabled={enrollSaving}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  form="enrollment-form"
                  isLoading={enrollSaving}
                  disabled={enrollSaving}
                >
                  Generate token
                </Button>
              </>
            )
          }
        >
          {enrollToken ? (
            <div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-start gap-2">
                  <Shield size={16} className="mt-0.5 shrink-0 text-amber-700" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                      Copy this token now
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
                      <code className="min-w-0 flex-1 select-all break-all rounded-md border border-amber-200 bg-white px-3 py-2 font-mono text-xs text-neutral-800">
                        {enrollToken.token}
                      </code>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={copyEnrollmentToken}
                        className="shrink-0"
                      >
                        {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <p className="mt-2 text-[11px] text-amber-800">
                      This token will not be shown again. Store it securely.
                    </p>
                  </div>
                </div>
              </div>

              <dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    Expires
                  </dt>
                  <dd className="text-neutral-800">
                    {enrollToken.expiresAt
                      ? formatDateTime(enrollToken.expiresAt)
                      : 'See server policy'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    Max uses
                  </dt>
                  <dd className="text-neutral-800">
                    {enrollToken.maxUses ?? '—'}
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <form id="enrollment-form" onSubmit={submitEnrollment} className="space-y-4">
              <div>
                <label
                  htmlFor="enroll-hours"
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-500"
                >
                  Expires in (hours)
                </label>
                <input
                  id="enroll-hours"
                  type="number"
                  min="1"
                  step="1"
                  value={enrollHours}
                  onChange={(event) => setEnrollHours(event.target.value)}
                  className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
                />
                <p className="mt-1 text-[11px] text-neutral-400">
                  How long the token stays valid. Defaults to 24 hours.
                </p>
              </div>

              <div>
                <label
                  htmlFor="enroll-max-uses"
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-500"
                >
                  Max uses
                </label>
                <input
                  id="enroll-max-uses"
                  type="number"
                  min="1"
                  step="1"
                  value={enrollMaxUses}
                  onChange={(event) => setEnrollMaxUses(event.target.value)}
                  className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
                />
                <p className="mt-1 text-[11px] text-neutral-400">
                  Number of devices that can enroll with this token.
                </p>
              </div>

              {enrollError && (
                <p className="flex items-start gap-1.5 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  {enrollError}
                </p>
              )}
            </form>
          )}
        </Dialog>
      )}

      {groupOpen && (
        <Dialog
          title="Create device group"
          subtitle="Groups make it easier to filter and manage devices."
          onClose={closeGroupModal}
          width={460}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={closeGroupModal}
                disabled={groupSaving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                form="device-group-form"
                isLoading={groupSaving}
                disabled={groupSaving}
              >
                Create group
              </Button>
            </>
          }
        >
          <form id="device-group-form" onSubmit={submitGroup} className="space-y-4">
            <div>
              <label
                htmlFor="device-group-name"
                className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-500"
              >
                Name
              </label>
              <input
                id="device-group-name"
                type="text"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="e.g. Head Office"
                autoFocus
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
              />
            </div>
            <div>
              <label
                htmlFor="device-group-description"
                className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-500"
              >
                Description <span className="font-normal lowercase text-neutral-400">(optional)</span>
              </label>
              <textarea
                id="device-group-description"
                rows={3}
                value={groupDescription}
                onChange={(event) => setGroupDescription(event.target.value)}
                placeholder="What belongs in this group?"
                className="w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
              />
            </div>

            {groupError && (
              <p className="flex items-start gap-1.5 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {groupError}
              </p>
            )}
          </form>
        </Dialog>
      )}

      {groupManagerOpen && (
        <Dialog
          title="Device groups"
          subtitle="Rename groups or remove them. Devices become ungrouped when their group is deleted."
          onClose={closeGroupManager}
          width={720}
          footer={
            <Button size="sm" onClick={closeGroupManager} disabled={groupActionBusy !== null}>
              Close
            </Button>
          }
        >
          {groupActionError && (
            <p className="mb-3 flex items-start gap-1.5 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              {groupActionError}
            </p>
          )}

          {groups.length === 0 ? (
            <div className="rounded-lg border border-neutral-200 px-4 py-8 text-center">
              <Users size={32} className="mx-auto text-neutral-300" />
              <p className="mt-2 text-sm font-semibold text-neutral-800">No groups yet</p>
              <p className="mt-1 text-xs text-neutral-500">
                Create a group to organize devices by office, department, or role.
              </p>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => {
                  closeGroupManager();
                  openGroupModal();
                }}
              >
                <Plus size={14} />
                New group
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {groups.map((group, index) => {
                const id = groupIdOf(group);
                const busy =
                  groupActionBusy !== null &&
                  String(groupActionBusy) === String(id);
                const editing =
                  editingGroupId !== null &&
                  String(editingGroupId) === String(id);

                if (editing) {
                  return (
                    <form
                      key={id ?? `group-${index}`}
                      onSubmit={saveGroupEdit}
                      className="rounded-lg border border-primary-200 bg-primary-50/40 p-3"
                    >
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={editGroupName}
                          onChange={(event) => setEditGroupName(event.target.value)}
                          aria-label="Group name"
                          autoFocus
                          className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
                        />
                        <textarea
                          rows={2}
                          value={editGroupDescription}
                          onChange={(event) => setEditGroupDescription(event.target.value)}
                          aria-label="Group description"
                          placeholder="Description (optional)"
                          className="w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
                        />
                      </div>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          onClick={cancelEditGroup}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" size="sm" isLoading={busy} disabled={busy}>
                          Save
                        </Button>
                      </div>
                    </form>
                  );
                }

                return (
                  <div
                    key={id ?? `group-${index}`}
                    className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-neutral-900">
                        {groupNameOf(group)}
                      </p>
                      {asText(group?.description) && (
                        <p className="mt-0.5 break-words text-xs text-neutral-500">
                          {asText(group.description)}
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-neutral-400">
                        {groupCountOf(group)} device{groupCountOf(group) === 1 ? '' : 's'}
                        {groupOnlineCountOf(group) > 0
                          ? `, ${groupOnlineCountOf(group)} online`
                          : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <ActionIcon
                        label="Edit group"
                        onClick={() => startEditGroup(group)}
                        disabled={groupActionBusy !== null}
                      >
                        <Pencil size={14} />
                      </ActionIcon>
                      <ActionIcon
                        label="Delete group"
                        danger
                        onClick={() => removeGroup(group)}
                        disabled={groupActionBusy !== null}
                      >
                        {busy ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </ActionIcon>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Dialog>
      )}

      {confirmAction && (
        <Dialog
          title={COMMAND_META[confirmAction.type]?.title ?? 'Confirm command'}
          subtitle={deviceNameOf(confirmAction.device)}
          onClose={() => setConfirmAction(null)}
          width={440}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmAction(null)}
                disabled={commandBusy !== null}
              >
                Cancel
              </Button>
              <Button
                variant={
                  confirmAction.type === 'shutdown' ? 'danger' : 'primary'
                }
                size="sm"
                onClick={runConfirmedCommand}
                isLoading={commandBusy !== null}
                disabled={commandBusy !== null}
              >
                {COMMAND_META[confirmAction.type]?.label ?? 'Confirm'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-neutral-700">
            {COMMAND_META[confirmAction.type]?.description}
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            The command will be delivered to the agent on{' '}
            <span className="font-semibold text-neutral-700">
              {deviceNameOf(confirmAction.device)}
            </span>
            .
          </p>
        </Dialog>
      )}

      {detailOpen && (
        <Dialog
          title={detailInfo.hostname || 'Device details'}
          subtitle={
            detailDevice
              ? `ID ${deviceIdOf(detailDevice) ?? '—'}`
              : 'Loading device details…'
          }
          onClose={closeDetails}
          width={680}
          footer={
            <Button size="sm" onClick={closeDetails}>
              Close
            </Button>
          }
        >
          {detailLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-neutral-500">
              <Loader2 size={18} className="animate-spin" />
              Loading device details…
            </div>
          ) : (
            <>
              {detailError && (
                <p className="mb-3 flex items-start gap-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  {detailError}
                </p>
              )}

              <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                <DetailRow label="Hostname" value={detailInfo.hostname} />
                <DetailRow label="Assigned to" value={detailDevice?.assigned_user_name || detailDevice?.assigned_user_id || 'Not assigned'} />
                <DetailRow label="Last user" value={detailDevice?.last_user_name || detailDevice?.last_user_id || 'None yet'} />
                <DetailRow label="Status">
                  <StatusPill meta={statusMeta(getDeviceStatus(detailDevice))} />
                </DetailRow>
                <DetailRow
                  label="Operating system"
                  value={
                    [
                      detailInfo.os,
                      detailInfo.osVersion,
                      detailInventory.osBuild
                        ? `build ${detailInventory.osBuild}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ') || '—'
                  }
                />
                <DetailRow label="Agent version" value={detailInfo.agentVersion || '—'} />
                <DetailRow
                  label="Assigned user"
                  value={detailInfo.assigned || detailInventory.loggedInUser || 'Unassigned'}
                />
                <DetailRow label="Group">
                  <div className="flex items-center gap-2">
                    <select
                      value={groupDraft}
                      onChange={(event) => setGroupDraft(event.target.value)}
                      disabled={groupSaveBusy}
                      aria-label="Device group"
                      className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
                    >
                      <option value="">No group</option>
                      {groups.map((group, index) => {
                        const id = groupIdOf(group);
                        return (
                          <option key={id ?? `detail-group-${index}`} value={id ?? ''}>
                            {groupNameOf(group)}
                          </option>
                        );
                      })}
                    </select>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={saveDeviceGroup}
                      isLoading={groupSaveBusy}
                      disabled={groupSaveBusy}
                    >
                      Save
                    </Button>
                  </div>
                  {groupSaveError && (
                    <p className="mt-1 text-xs text-red-600">{groupSaveError}</p>
                  )}
                </DetailRow>
                <DetailRow
                  label="Manufacturer"
                  value={detailInventory.manufacturer || '—'}
                />
                <DetailRow label="Model" value={detailInventory.model || '—'} />
                <DetailRow
                  label="Serial number"
                  value={detailInventory.serial || detailInfo.serial || '—'}
                />
                <DetailRow
                  label="CPU"
                  value={
                    [
                      detailInventory.cpuModel,
                      detailInventory.cpuCount
                        ? `${detailInventory.cpuCount} cores`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' / ') || '—'
                  }
                />
                <DetailRow
                  label="Memory"
                  value={
                    detailInventory.memoryTotalBytes !== undefined
                      ? `${formatBytes(detailInventory.memoryTotalBytes)} total${
                          detailInventory.memoryFreeBytes !== undefined
                            ? `, ${formatBytes(detailInventory.memoryFreeBytes)} free`
                            : ''
                        }`
                      : '—'
                  }
                />
                <DetailRow
                  label="Uptime"
                  value={
                    detailInventory.uptimeSeconds !== undefined
                      ? formatUptime(detailInventory.uptimeSeconds)
                      : '—'
                  }
                />
                <DetailRow
                  label="Last logged-in user"
                  value={detailInventory.loggedInUser || '—'}
                />
                <DetailRow label="Domain" value={detailInventory.domain || '—'} />
                <DetailRow label="IP address" value={detailInfo.ip || detailInventory.ip || '—'} />
                <DetailRow label="MAC address" value={detailInfo.mac || detailInventory.mac || '—'} />
                <DetailRow label="Last seen" value={formatDateTime(detailInfo.lastSeen)} />
                <DetailRow label="Enrolled" value={formatDateTime(detailInfo.enrolledAt)} />
                <DetailRow
                  label="Last inventory"
                  value={formatDateTime(detailInventory.collectedAt)}
                />
                <DetailRow label="Remote control" value="Available in Phase 4" />
              </div>

              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-neutral-200 p-3">
                  <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    <HardDrive size={13} />
                    Storage
                  </h4>
                  {detailInventory.volumes.length === 0 ? (
                    <p className="text-xs text-neutral-500">No disk inventory reported.</p>
                  ) : (
                    <ul className="space-y-2">
                      {detailInventory.volumes.map((volume, index) => (
                        <li
                          key={volume?.device_id ?? volume?.drive ?? `volume-${index}`}
                          className="text-xs text-neutral-700"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">
                              {asText(firstValue(volume?.device_id, volume?.drive)) || `Disk ${index + 1}`}
                              {asText(volume?.file_system) ? ` (${asText(volume.file_system)})` : ''}
                            </span>
                            <span className="text-neutral-500">
                              {formatBytes(volume?.size_bytes)} total
                            </span>
                          </div>
                          <p className="text-neutral-500">
                            {formatBytes(volume?.free_bytes)} free
                            {asText(volume?.volume_name)
                              ? ` / ${asText(volume.volume_name)}`
                              : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-neutral-200 p-3">
                  <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    <Network size={13} />
                    Network
                  </h4>
                  {detailInventory.network.length === 0 ? (
                    <p className="text-xs text-neutral-500">No network inventory reported.</p>
                  ) : (
                    <ul className="space-y-2">
                      {detailInventory.network.slice(0, 4).map((adapter, index) => (
                        <li
                          key={adapter?.mac_address ?? adapter?.description ?? `adapter-${index}`}
                          className="text-xs text-neutral-700"
                        >
                          <p className="font-semibold">
                            {asText(adapter?.description) || `Adapter ${index + 1}`}
                          </p>
                          <p className="break-words text-neutral-500">
                            {Array.isArray(adapter?.ip_addresses) &&
                            adapter.ip_addresses.length > 0
                              ? adapter.ip_addresses.slice(0, 3).join(', ')
                              : 'No IP address'}
                            {asText(adapter?.mac_address)
                              ? ` / ${asText(adapter.mac_address)}`
                              : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="mt-4 rounded-lg border border-neutral-200 p-3">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  <Package size={13} />
                  Installed software
                  {detailInventory.softwareCount > 0
                    ? ` (${detailInventory.softwareCount})`
                    : ''}
                </h4>
                {detailInventory.software.length === 0 ? (
                  <p className="text-xs text-neutral-500">No software inventory reported.</p>
                ) : (
                  <details>
                    <summary className="cursor-pointer text-xs font-semibold text-primary-600">
                      Show installed applications
                    </summary>
                    <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs text-neutral-700">
                      {detailInventory.software.slice(0, 50).map((app, index) => (
                        <li
                          key={`${app?.name ?? 'app'}-${app?.version ?? index}`}
                          className="flex items-start justify-between gap-2"
                        >
                          <span className="min-w-0 break-words">
                            {asText(app?.name) || 'Unnamed application'}
                          </span>
                          <span className="shrink-0 text-neutral-400">
                            {asText(app?.version) || ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {detailInventory.software.length > 50 && (
                      <p className="mt-2 text-[11px] text-neutral-400">
                        Showing 50 of {detailInventory.software.length} applications.
                      </p>
                    )}
                  </details>
                )}
              </div>

              <div className="mt-4 rounded-lg border border-neutral-200 p-3">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  <ShieldCheck size={13} />
                  Policy compliance
                </h4>
                {Array.isArray(detailDevice?.policy_statuses) &&
                detailDevice.policy_statuses.length > 0 ? (
                  <ul className="space-y-2">
                    {detailDevice.policy_statuses.map((status, index) => {
                      const tone =
                        status?.status === 'compliant' || status?.status === 'applied'
                          ? 'text-emerald-700'
                          : status?.status === 'failed'
                            ? 'text-red-700'
                            : 'text-amber-700';
                      return (
                        <li
                          key={status?.id ?? `policy-status-${index}`}
                          className="flex items-start justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-neutral-800">
                              {status?.policy?.name || status?.policy_id || 'Policy'}
                            </p>
                            <p className="text-neutral-500">
                              v{status?.policy_version ?? '—'} · checked{' '}
                              {formatDateTime(status?.checked_at)}
                            </p>
                            {Array.isArray(status?.errors) &&
                              status.errors.map((message, messageIndex) => (
                                <p key={messageIndex} className="mt-0.5 break-words text-neutral-600">
                                  {String(message)}
                                </p>
                              ))}
                          </div>
                          <span className={`shrink-0 font-semibold capitalize ${tone}`}>
                            {String(status?.status || 'unknown').replace(/_/g, ' ')}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-neutral-500">
                    No policy has been reported for this device yet.
                  </p>
                )}
              </div>

              <div className="mt-4 rounded-lg border border-neutral-200 p-3">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  <ShieldCheck size={13} />
                  BitLocker recovery key
                </h4>
                {recoveryKeys === null ? (
                  <>
                    <p className="mb-2 text-xs text-neutral-500">
                      Viewing a recovery key is recorded in this device's activity.
                    </p>
                    <Button size="sm" onClick={showRecoveryKeys} disabled={recoveryBusy}>
                      {recoveryBusy ? 'Loading…' : 'Show recovery key'}
                    </Button>
                  </>
                ) : recoveryKeys.length > 0 ? (
                  <ul className="space-y-2">
                    {recoveryKeys.map((key) => (
                      <li key={key.protector_id} className="text-xs">
                        <p className="break-all font-mono font-semibold text-neutral-800">
                          {key.recovery_password}
                        </p>
                        <p className="break-all text-neutral-500">
                          Key ID {key.protector_id} · stored {formatDateTime(key.updated_at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-neutral-500">
                    No recovery key has been stored for this device.
                  </p>
                )}
                {recoveryError && (
                  <p role="alert" className="mt-2 text-xs text-red-700">
                    {recoveryError}
                  </p>
                )}
              </div>

              <div className="mt-5">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  <Shield size={13} />
                  Recent activity
                </h4>

                {auditLoading ? (
                  <div className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-3 text-sm text-neutral-500">
                    <Loader2 size={14} className="animate-spin" />
                    Loading activity…
                  </div>
                ) : auditError ? (
                  <p className="rounded-lg border border-neutral-200 px-3 py-3 text-xs text-neutral-500">
                    {auditError}
                  </p>
                ) : auditEntries.length === 0 ? (
                  <p className="rounded-lg border border-neutral-200 px-3 py-3 text-xs text-neutral-500">
                    No activity recorded yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
                    {auditEntries.slice(0, 25).map((entry, index) => {
                      const action =
                        asText(
                          firstValue(
                            entry?.action,
                            entry?.type,
                            entry?.event,
                            entry?.command,
                          ),
                        ) || 'Activity';
                      const actor = asText(
                        firstValue(
                          entry?.actor,
                          entry?.actor_name,
                          entry?.user,
                          entry?.user_name,
                        ),
                      );
                      const timestamp = firstValue(
                        entry?.created_at,
                        entry?.timestamp,
                        entry?.at,
                      );
                      return (
                        <li
                          key={entry?.id ?? `audit-${index}`}
                          className="flex items-start justify-between gap-3 px-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="break-words text-sm text-neutral-800">
                              {String(action)}
                            </p>
                            <p className="text-[11px] text-neutral-500">
                              {actor ? `${actor} · ` : ''}
                              {formatDateTime(timestamp)}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {user?.name && (
                <p className="mt-3 text-[11px] text-neutral-400">
                  Signed in as {user.name}
                </p>
              )}
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, accent }) {
  const Icon = icon;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm">
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `${accent}14`, color: accent }}
      >
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          {label}
        </p>
        <p className="text-xl font-bold leading-tight text-neutral-900">{value}</p>
      </div>
    </div>
  );
}

function StatusPill({ meta }) {
  const Icon = meta.Icon ?? WifiOff;
  return (
    <span
      className="inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
      }}
    >
      <Icon size={11} />
      {meta.label}
    </span>
  );
}

function ActionIcon({ label, onClick, disabled = false, danger = false, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 w-7 items-center justify-center rounded-md border transition ${
        disabled
          ? 'cursor-not-allowed border-neutral-100 bg-neutral-50 text-neutral-300'
          : danger
            ? 'border-red-100 bg-red-50 text-red-600 hover:bg-red-100'
            : 'border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700'
      }`}
    >
      {children}
    </button>
  );
}

function DetailRow({ label, value, children }) {
  return (
    <div className="border-b border-neutral-100 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <div className="mt-0.5 break-words text-sm text-neutral-800">
        {children ?? value ?? '—'}
      </div>
    </div>
  );
}

function Dialog({ title, subtitle, onClose, footer, children, width = 520 }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex w-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        style={{ maxWidth: width, maxHeight: '90vh' }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-neutral-200 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-neutral-900">{title}</h3>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-neutral-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-neutral-200 bg-neutral-50 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
