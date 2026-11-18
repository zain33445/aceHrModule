import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import api from '../../services/api';
import { Card, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import Modal from '../common/Modal';

const DEFAULT_CONFIG = {
  mode: 'enforce',
  bitlocker: { enabled: true, encryption_method: 'XtsAes256' },
  firewall: { enabled: true, profiles: ['domain', 'private', 'public'] },
  screen_lock: { enabled: true, timeout_minutes: 10 },
  usb_storage: { enabled: true },
  local_admin: {
    enabled: true,
    disable_builtin_administrator: true,
    remove_other_admins: false,
    allowed_admins: [],
  },
  password_policy: { enabled: true, min_length: 12, max_age_days: 90, lockout_threshold: 5 },
  windows_update: {
    enabled: true,
    auto_update: true,
    defer_quality_days: 0,
    defer_feature_days: 0,
  },
  web_filter: { enabled: false, blocked_domains: [] },
  software_install: { enabled: false },
  firewall_notifications: { enabled: false },
  software_watch: { enabled: false, flagged_names: [] },
};

const STATUS_META = {
  active: { label: 'Active', color: '#047857', bg: '#ecfdf5', border: '#a7f3d0' },
  draft: { label: 'Draft', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0' },
  disabled: { label: 'Disabled', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
  compliant: { label: 'Compliant', color: '#047857', bg: '#ecfdf5', border: '#a7f3d0' },
  applied: { label: 'Applied', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
  non_compliant: { label: 'Non-compliant', color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  failed: { label: 'Failed', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
};

const inputClass =
  'w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100 disabled:bg-neutral-50 disabled:text-neutral-400';
const labelClass =
  'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-500';

function pickList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') {
    return pickList(payload.data, ...keys);
  }
  return [];
}

function errorMessage(err, fallback) {
  const data = err?.response?.data;
  if (typeof data === 'string' && data.trim()) return data;
  return data?.error || data?.message || err?.message || fallback;
}

function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  return {
    mode: c.mode === 'audit' ? 'audit' : 'enforce',
    bitlocker: { ...DEFAULT_CONFIG.bitlocker, ...(c.bitlocker || {}) },
    firewall: {
      ...DEFAULT_CONFIG.firewall,
      ...(c.firewall || {}),
      profiles: Array.isArray(c.firewall?.profiles)
        ? c.firewall.profiles
        : [...DEFAULT_CONFIG.firewall.profiles],
    },
    screen_lock: { ...DEFAULT_CONFIG.screen_lock, ...(c.screen_lock || {}) },
    usb_storage: { ...DEFAULT_CONFIG.usb_storage, ...(c.usb_storage || {}) },
    local_admin: { ...DEFAULT_CONFIG.local_admin, ...(c.local_admin || {}) },
    password_policy: { ...DEFAULT_CONFIG.password_policy, ...(c.password_policy || {}) },
    windows_update: { ...DEFAULT_CONFIG.windows_update, ...(c.windows_update || {}) },
    web_filter: { ...DEFAULT_CONFIG.web_filter, ...(c.web_filter || {}) },
    software_install: { ...DEFAULT_CONFIG.software_install, ...(c.software_install || {}) },
    firewall_notifications: {
      ...DEFAULT_CONFIG.firewall_notifications,
      ...(c.firewall_notifications || {})
    },
    software_watch: { ...DEFAULT_CONFIG.software_watch, ...(c.software_watch || {}) },
  };
}

function ListInput({ id, label, hint, items, onChange, disabled, placeholder }) {
  return (
    <div>
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        value={items.join('\n')}
        onChange={(event) => onChange(event.target.value.split('\n'))}
        placeholder={placeholder}
        className={inputClass}
        disabled={disabled}
      />
      <p className="mt-1 text-xs text-neutral-500">{hint}</p>
    </div>
  );
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

function policyMode(policy) {
  return policy?.config?.mode === 'audit' ? 'Audit' : 'Enforce';
}

function targetName(assignment) {
  return (
    assignment?.target_name ||
    assignment?.device?.hostname ||
    assignment?.group?.name ||
    (assignment?.device_id ? `Device ${assignment.device_id}` : 'Group')
  );
}

function StatusPill({ value }) {
  const meta = STATUS_META[value] || {
    label: value || 'Unknown',
    color: '#64748b',
    bg: '#f8fafc',
    border: '#e2e8f0',
  };
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}
    >
      {meta.label}
    </span>
  );
}

function Section({ title, description, children }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
      <div className="mb-2">
        <p className="text-sm font-semibold text-neutral-800">{title}</p>
        {description && <p className="text-[11px] text-neutral-500">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <label className="flex items-center gap-2 text-sm text-neutral-700">
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-400"
      />
      {label}
    </label>
  );
}

export default function DevicePoliciesTab() {
  const [policies, setPolicies] = useState([]);
  const [groups, setGroups] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: '', config: normalizeConfig() });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [manageOpen, setManageOpen] = useState(false);
  const [manageId, setManageId] = useState(null);
  const [managePolicy, setManagePolicy] = useState(null);
  const [manageStatuses, setManageStatuses] = useState([]);
  const [manageLoading, setManageLoading] = useState(false);
  const [manageError, setManageError] = useState('');
  const [assignmentType, setAssignmentType] = useState('group');
  const [assignmentTarget, setAssignmentTarget] = useState('');
  const [assignmentPriority, setAssignmentPriority] = useState('100');
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [assignmentError, setAssignmentError] = useState('');
  const [assignmentBusy, setAssignmentBusy] = useState(null);

  const fetchAll = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    const [policyResult, groupResult, deviceResult] = await Promise.allSettled([
      api.getDevicePolicies(),
      api.getDeviceGroups(),
      api.getDevices(),
    ]);
    if (policyResult.status === 'fulfilled') {
      setPolicies(pickList(policyResult.value?.data, 'policies'));
    } else {
      setError(errorMessage(policyResult.reason, 'Failed to load device policies.'));
    }
    if (groupResult.status === 'fulfilled') {
      setGroups(pickList(groupResult.value?.data, 'groups'));
    }
    if (deviceResult.status === 'fulfilled') {
      setDevices(pickList(deviceResult.value?.data, 'devices'));
    }
    if (!quiet) setLoading(false);
  }, []);

  const loadManaged = useCallback(async (id) => {
    if (!id) return;
    setManageLoading(true);
    setManageError('');
    const [policyResult, statusResult] = await Promise.allSettled([
      api.getDevicePolicy(id),
      api.getDevicePolicyStatuses(id, { limit: 100 }),
    ]);
    if (policyResult.status === 'fulfilled') {
      setManagePolicy(policyResult.value?.data?.policy || null);
    } else {
      setManageError(errorMessage(policyResult.reason, 'Failed to load the policy.'));
    }
    if (statusResult.status === 'fulfilled') {
      setManageStatuses(pickList(statusResult.value?.data, 'statuses'));
    }
    setManageLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const summary = useMemo(
    () => ({
      total: policies.length,
      active: policies.filter((policy) => policy.status === 'active').length,
      draft: policies.filter((policy) => policy.status === 'draft').length,
      assignments: policies.reduce(
        (total, policy) => total + Number(policy.assignment_count || 0),
        0,
      ),
    }),
    [policies],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm({ name: '', config: normalizeConfig() });
    setSaveError('');
    setEditorOpen(true);
  };

  const openEdit = (policy) => {
    setEditingId(policy.id);
    setForm({ name: policy.name || '', config: normalizeConfig(policy.config) });
    setSaveError('');
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditorOpen(false);
    setSaveError('');
  };

  const updateSection = (section, key, value) => {
    setForm((previous) => ({
      ...previous,
      config: {
        ...previous.config,
        [section]: { ...previous.config[section], [key]: value },
      },
    }));
  };

  const toggleProfile = (profile) => {
    setForm((previous) => {
      const profiles = previous.config.firewall.profiles.includes(profile)
        ? previous.config.firewall.profiles.filter((item) => item !== profile)
        : [...previous.config.firewall.profiles, profile];
      return {
        ...previous,
        config: {
          ...previous.config,
          firewall: {
            ...previous.config.firewall,
            profiles: profiles.length ? profiles : [...DEFAULT_CONFIG.firewall.profiles],
          },
        },
      };
    });
  };

  const submitEditor = async () => {
    if (saving) return;
    const name = form.name.trim();
    if (!name) {
      setSaveError('Policy name is required.');
      return;
    }

    setSaving(true);
    setSaveError('');
    try {
      if (editingId) {
        await api.updateDevicePolicy(editingId, { name, config: form.config });
        setNotice({ type: 'success', text: `Policy "${name}" updated.` });
      } else {
        await api.createDevicePolicy({ name, config: form.config });
        setNotice({ type: 'success', text: `Policy "${name}" created as a draft.` });
      }
      setEditorOpen(false);
      await fetchAll({ quiet: true });
    } catch (err) {
      setSaveError(errorMessage(err, 'Failed to save the policy.'));
    } finally {
      setSaving(false);
    }
  };

  const togglePolicyStatus = async (policy) => {
    const nextStatus = policy.status === 'active' ? 'disabled' : 'active';
    setBusyId(policy.id);
    try {
      await api.updateDevicePolicy(policy.id, { status: nextStatus });
      setNotice({
        type: 'success',
        text:
          nextStatus === 'active'
            ? `Policy "${policy.name}" activated.`
            : `Policy "${policy.name}" disabled.`,
      });
      await fetchAll({ quiet: true });
      if (manageId === policy.id) loadManaged(policy.id);
    } catch (err) {
      setNotice({ type: 'error', text: errorMessage(err, 'Failed to update the policy.') });
    } finally {
      setBusyId(null);
    }
  };

  const removePolicy = async (policy) => {
    if (!window.confirm(`Delete policy "${policy.name}"? This cannot be undone.`)) return;
    setBusyId(policy.id);
    try {
      await api.deleteDevicePolicy(policy.id);
      setNotice({ type: 'success', text: `Policy "${policy.name}" deleted.` });
      if (manageId === policy.id) setManageOpen(false);
      await fetchAll({ quiet: true });
    } catch (err) {
      setNotice({ type: 'error', text: errorMessage(err, 'Failed to delete the policy.') });
    } finally {
      setBusyId(null);
    }
  };

  const openManage = (policy) => {
    setManageOpen(true);
    setManageId(policy.id);
    setManagePolicy(policy);
    setManageStatuses([]);
    setAssignmentType('group');
    setAssignmentTarget('');
    setAssignmentPriority('100');
    setAssignmentError('');
    loadManaged(policy.id);
  };

  const closeManage = () => {
    setManageOpen(false);
    setManageId(null);
    setManagePolicy(null);
    setManageStatuses([]);
    setManageError('');
    setAssignmentError('');
  };

  const targets = assignmentType === 'group' ? groups : devices;

  const targetLabel = (target) =>
    assignmentType === 'group'
      ? target.name
      : target.hostname || target.name || `Device ${target.id}`;

  const submitAssignment = async () => {
    if (!manageId || assignmentSaving) return;
    if (!assignmentTarget) {
      setAssignmentError(`Choose a ${assignmentType} to assign.`);
      return;
    }
    const priority = Number(assignmentPriority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
      setAssignmentError('Priority must be a whole number between 1 and 1000.');
      return;
    }

    setAssignmentSaving(true);
    setAssignmentError('');
    try {
      await api.createDevicePolicyAssignment(manageId, {
        [assignmentType === 'group' ? 'group_id' : 'device_id']: assignmentTarget,
        priority,
      });
      setAssignmentTarget('');
      setNotice({ type: 'success', text: 'Policy assignment saved.' });
      await loadManaged(manageId);
      await fetchAll({ quiet: true });
    } catch (err) {
      setAssignmentError(errorMessage(err, 'Failed to save the assignment.'));
    } finally {
      setAssignmentSaving(false);
    }
  };

  const removeAssignment = async (assignmentId) => {
    if (!manageId || assignmentBusy) return;
    if (!window.confirm('Remove this assignment?')) return;

    setAssignmentBusy(assignmentId);
    setAssignmentError('');
    try {
      await api.deleteDevicePolicyAssignment(manageId, assignmentId);
      setNotice({ type: 'success', text: 'Assignment removed.' });
      await loadManaged(manageId);
      await fetchAll({ quiet: true });
    } catch (err) {
      setAssignmentError(errorMessage(err, 'Failed to remove the assignment.'));
    } finally {
      setAssignmentBusy(null);
    }
  };

  const assignments = Array.isArray(managePolicy?.assignments)
    ? managePolicy.assignments
    : [];

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-neutral-900">
            <ShieldCheck size={22} className="text-primary-600" />
            Device policies
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Enforce security baselines on managed Windows laptops and track compliance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchAll()}
            disabled={loading}
            className="shadow-sm"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreate} className="shadow-sm">
            <Plus size={15} />
            New policy
          </Button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryCard icon={ShieldCheck} label="Policies" value={summary.total} accent="#4f46e5" />
        <SummaryCard icon={CheckCircle2} label="Active" value={summary.active} accent="#059669" />
        <SummaryCard icon={Pencil} label="Drafts" value={summary.draft} accent="#d97706" />
        <SummaryCard icon={Users} label="Assignments" value={summary.assignments} accent="#64748b" />
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
            onClick={() => fetchAll()}
            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {loading && policies.length === 0 ? (
        <Card>
          <CardBody className="flex items-center justify-center gap-2 py-12 text-neutral-500">
            <Loader2 size={20} className="animate-spin" />
            Loading policies…
          </CardBody>
        </Card>
      ) : policies.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <ShieldCheck size={42} className="text-neutral-300" />
            <div>
              <p className="font-semibold text-neutral-800">No policies yet</p>
              <p className="mt-1 text-sm text-neutral-500">
                Create a security baseline and assign it to a group or device.
              </p>
            </div>
            <Button size="sm" onClick={openCreate}>
              <Plus size={15} />
              New policy
            </Button>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Policy</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Mode</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Version</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Assignments</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Devices</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Updated</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {policies.map((policy) => {
                  const busy = busyId === policy.id;
                  return (
                    <tr key={policy.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openManage(policy)}
                          className="text-left font-semibold text-neutral-900 hover:text-primary-600"
                        >
                          {policy.name}
                        </button>
                        <p className="text-[11px] text-neutral-400">
                          {policy.type === 'security_baseline'
                            ? 'Windows security baseline'
                            : policy.type}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill value={policy.status} />
                      </td>
                      <td className="px-4 py-3 text-neutral-700">{policyMode(policy)}</td>
                      <td className="px-4 py-3 text-neutral-700">v{policy.version}</td>
                      <td className="px-4 py-3 text-neutral-700">
                        {policy.assignment_count ?? 0}
                      </td>
                      <td className="px-4 py-3 text-neutral-700">{policy.device_count ?? 0}</td>
                      <td className="px-4 py-3 text-neutral-500">
                        {formatDateTime(policy.updated_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <ActionButton
                            label="Manage assignments and compliance"
                            onClick={() => openManage(policy)}
                          >
                            <Users size={14} />
                          </ActionButton>
                          <ActionButton
                            label="Edit policy"
                            onClick={() => openEdit(policy)}
                            disabled={busy}
                          >
                            <Pencil size={14} />
                          </ActionButton>
                          <ActionButton
                            label={
                              policy.status === 'active'
                                ? 'Disable policy'
                                : 'Activate policy'
                            }
                            onClick={() => togglePolicyStatus(policy)}
                            disabled={busy}
                          >
                            {policy.status === 'active' ? (
                              <ShieldOff size={14} />
                            ) : (
                              <ShieldCheck size={14} />
                            )}
                          </ActionButton>
                          <ActionButton
                            label="Delete policy"
                            danger
                            onClick={() => removePolicy(policy)}
                            disabled={busy}
                          >
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          </ActionButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        isOpen={editorOpen}
        onClose={closeEditor}
        title={editingId ? 'Edit device policy' : 'New device policy'}
        size="full"
        className="w-[min(900px,95vw)]"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeEditor} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={submitEditor} disabled={saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {editingId ? 'Save changes' : 'Create policy'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="policy-name">
                Name
              </label>
              <input
                id="policy-name"
                type="text"
                value={form.name}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, name: event.target.value }))
                }
                placeholder="e.g. Laptop security baseline"
                className={inputClass}
                autoFocus
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="policy-mode">
                Mode
              </label>
              <select
                id="policy-mode"
                value={form.config.mode}
                onChange={(event) =>
                  setForm((previous) => ({
                    ...previous,
                    config: { ...previous.config, mode: event.target.value },
                  }))
                }
                className={inputClass}
              >
                <option value="enforce">Enforce — apply changes automatically</option>
                <option value="audit">Audit — report only, do not change devices</option>
              </select>
            </div>
          </div>

          <Section title="BitLocker" description="Encrypt the Windows system drive.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Toggle
                checked={form.config.bitlocker.enabled}
                onChange={(value) => updateSection('bitlocker', 'enabled', value)}
                label="Enable BitLocker baseline"
              />
              <div>
                <label className={labelClass} htmlFor="bitlocker-method">
                  Encryption method
                </label>
                <select
                  id="bitlocker-method"
                  value={form.config.bitlocker.encryption_method}
                  onChange={(event) =>
                    updateSection('bitlocker', 'encryption_method', event.target.value)
                  }
                  className={inputClass}
                  disabled={!form.config.bitlocker.enabled}
                >
                  <option value="XtsAes256">XTS-AES 256-bit</option>
                  <option value="XtsAes128">XTS-AES 128-bit</option>
                  <option value="Aes256">AES 256-bit</option>
                  <option value="Aes128">AES 128-bit</option>
                </select>
              </div>
            </div>
          </Section>

          <Section title="Firewall" description="Require Windows Defender Firewall profiles.">
            <div className="flex flex-wrap gap-4">
              <Toggle
                checked={form.config.firewall.enabled}
                onChange={(value) => updateSection('firewall', 'enabled', value)}
                label="Enable firewall baseline"
              />
              {['domain', 'private', 'public'].map((profile) => (
                <Toggle
                  key={profile}
                  checked={form.config.firewall.profiles.includes(profile)}
                  onChange={() => toggleProfile(profile)}
                  label={profile.charAt(0).toUpperCase() + profile.slice(1)}
                  disabled={!form.config.firewall.enabled}
                />
              ))}
            </div>
            <div className="mt-2">
              <Toggle
                checked={form.config.firewall_notifications.enabled}
                onChange={(value) => updateSection('firewall_notifications', 'enabled', value)}
                label="Hide 'Windows Firewall has blocked this app' notifications (blocked apps stay blocked)"
              />
            </div>
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Screen lock" description="Lock the workstation after inactivity.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  checked={form.config.screen_lock.enabled}
                  onChange={(value) => updateSection('screen_lock', 'enabled', value)}
                  label="Enable screen lock"
                />
                <div>
                  <label className={labelClass} htmlFor="screen-lock-minutes">
                    Timeout (minutes)
                  </label>
                  <input
                    id="screen-lock-minutes"
                    type="number"
                    min="1"
                    max="120"
                    value={form.config.screen_lock.timeout_minutes}
                    onChange={(event) =>
                      updateSection('screen_lock', 'timeout_minutes', Number(event.target.value))
                    }
                    className={inputClass}
                    disabled={!form.config.screen_lock.enabled}
                  />
                </div>
              </div>
            </Section>

            <Section title="USB storage" description="Block removable storage devices.">
              <Toggle
                checked={form.config.usb_storage.enabled}
                onChange={(value) => updateSection('usb_storage', 'enabled', value)}
                label="Block USB storage"
              />
            </Section>
          </div>

          <Section title="Local administrator" description="Reduce standing local admin access.">
            <Toggle
              checked={form.config.local_admin.enabled}
              onChange={(value) => updateSection('local_admin', 'enabled', value)}
              label="Enable local administrator baseline"
            />
            <div className="mt-2 pl-6">
              <Toggle
                checked={form.config.local_admin.disable_builtin_administrator}
                onChange={(value) =>
                  updateSection('local_admin', 'disable_builtin_administrator', value)
                }
                label="Disable the built-in Administrator account"
                disabled={!form.config.local_admin.enabled}
              />
              <div className="mt-2">
                <Toggle
                  checked={form.config.local_admin.remove_other_admins}
                  onChange={(value) => updateSection('local_admin', 'remove_other_admins', value)}
                  label="Remove admin rights from everyone except approved accounts"
                  disabled={!form.config.local_admin.enabled}
                />
              </div>
              {form.config.local_admin.remove_other_admins && (
                <div className="mt-2">
                  <ListInput
                    id="allowed-admins"
                    label="Approved admin accounts"
                    hint="One per line. If none of these is an enabled admin on a PC, nobody is removed from it and the PC reports non-compliant. Users must sign out and back in for the change to apply."
                    items={form.config.local_admin.allowed_admins}
                    onChange={(value) => updateSection('local_admin', 'allowed_admins', value)}
                    disabled={!form.config.local_admin.enabled}
                    placeholder="it-admin"
                  />
                </div>
              )}
            </div>
          </Section>

          <Section
            title="Website blocking"
            description="Blocks sites in Chrome, Edge, Brave and Firefox. Other browsers are not covered."
          >
            <Toggle
              checked={form.config.web_filter.enabled}
              onChange={(value) => updateSection('web_filter', 'enabled', value)}
              label="Block these websites"
            />
            <div className="mt-2">
              <ListInput
                id="blocked-domains"
                label="Blocked websites"
                hint="One per line, up to 200. Subdomains are blocked too."
                items={form.config.web_filter.blocked_domains}
                onChange={(value) => updateSection('web_filter', 'blocked_domains', value)}
                disabled={!form.config.web_filter.enabled}
                placeholder="facebook.com"
              />
            </div>
          </Section>

          <Section
            title="Software"
            description="Limit installs and find software you don't want on your PCs."
          >
            <Toggle
              checked={form.config.software_install.enabled}
              onChange={(value) => updateSection('software_install', 'enabled', value)}
              label="Block .msi installers for everyone, including admins (also stops .msi-based app updates; software pushed from this console still installs)"
            />
            <div className="mt-2">
              <Toggle
                checked={form.config.software_watch.enabled}
                onChange={(value) => updateSection('software_watch', 'enabled', value)}
                label="Report flagged software (reports only, does not remove it)"
              />
            </div>
            <div className="mt-2">
              <ListInput
                id="flagged-software"
                label="Flagged software names"
                hint="One per line. Matches any installed program whose name contains this text."
                items={form.config.software_watch.flagged_names}
                onChange={(value) => updateSection('software_watch', 'flagged_names', value)}
                disabled={!form.config.software_watch.enabled}
                placeholder="TeamViewer"
              />
            </div>
          </Section>

          <Section title="Password policy" description="Minimum length, maximum age, and lockout.">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="sm:col-span-1">
                <Toggle
                  checked={form.config.password_policy.enabled}
                  onChange={(value) => updateSection('password_policy', 'enabled', value)}
                  label="Enable"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="password-min">
                  Min length
                </label>
                <input
                  id="password-min"
                  type="number"
                  min="8"
                  max="32"
                  value={form.config.password_policy.min_length}
                  onChange={(event) =>
                    updateSection('password_policy', 'min_length', Number(event.target.value))
                  }
                  className={inputClass}
                  disabled={!form.config.password_policy.enabled}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="password-age">
                  Max age (days)
                </label>
                <input
                  id="password-age"
                  type="number"
                  min="0"
                  max="365"
                  value={form.config.password_policy.max_age_days}
                  onChange={(event) =>
                    updateSection('password_policy', 'max_age_days', Number(event.target.value))
                  }
                  className={inputClass}
                  disabled={!form.config.password_policy.enabled}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="password-lockout">
                  Lockout threshold
                </label>
                <input
                  id="password-lockout"
                  type="number"
                  min="0"
                  max="20"
                  value={form.config.password_policy.lockout_threshold}
                  onChange={(event) =>
                    updateSection(
                      'password_policy',
                      'lockout_threshold',
                      Number(event.target.value),
                    )
                  }
                  className={inputClass}
                  disabled={!form.config.password_policy.enabled}
                />
              </div>
            </div>
          </Section>

          <Section title="Windows Update" description="Keep updates enabled and control deferrals.">
            <div className="grid gap-3 sm:grid-cols-4">
              <Toggle
                checked={form.config.windows_update.enabled}
                onChange={(value) => updateSection('windows_update', 'enabled', value)}
                label="Enable baseline"
              />
              <div className="sm:col-span-3">
                <Toggle
                  checked={form.config.windows_update.auto_update}
                  onChange={(value) => updateSection('windows_update', 'auto_update', value)}
                  label="Automatic updates"
                  disabled={!form.config.windows_update.enabled}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="defer-quality">
                  Defer quality (days)
                </label>
                <input
                  id="defer-quality"
                  type="number"
                  min="0"
                  max="30"
                  value={form.config.windows_update.defer_quality_days}
                  onChange={(event) =>
                    updateSection(
                      'windows_update',
                      'defer_quality_days',
                      Number(event.target.value),
                    )
                  }
                  className={inputClass}
                  disabled={!form.config.windows_update.enabled}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="defer-feature">
                  Defer features (days)
                </label>
                <input
                  id="defer-feature"
                  type="number"
                  min="0"
                  max="365"
                  value={form.config.windows_update.defer_feature_days}
                  onChange={(event) =>
                    updateSection(
                      'windows_update',
                      'defer_feature_days',
                      Number(event.target.value),
                    )
                  }
                  className={inputClass}
                  disabled={!form.config.windows_update.enabled}
                />
              </div>
            </div>
          </Section>

          {saveError && (
            <p className="flex items-start gap-1.5 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              {saveError}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={manageOpen}
        onClose={closeManage}
        title={managePolicy?.name || 'Device policy'}
        size="full"
        className="w-[min(960px,95vw)]"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeManage}>
              Close
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => manageId && loadManaged(manageId)}
              disabled={manageLoading}
            >
              <RefreshCw size={14} className={manageLoading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </>
        }
      >
        {manageLoading && !managePolicy ? (
          <div className="flex items-center justify-center gap-2 py-10 text-neutral-500">
            <Loader2 size={18} className="animate-spin" />
            Loading policy…
          </div>
        ) : manageError ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{manageError}</p>
        ) : managePolicy ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusPill value={managePolicy.status} />
              <span className="text-neutral-500">v{managePolicy.version}</span>
              <span className="text-neutral-400">·</span>
              <span className="text-neutral-600">{policyMode(managePolicy)} mode</span>
              <span className="text-neutral-400">·</span>
              <span className="text-neutral-500">
                {managePolicy.assignment_count ?? assignments.length} assignment
                {(managePolicy.assignment_count ?? assignments.length) === 1 ? '' : 's'}
              </span>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-neutral-900">Assignments</h3>
                <p className="text-[11px] text-neutral-400">
                  Lower priority numbers win; device assignments beat group assignments.
                </p>
              </div>
              {assignments.length === 0 ? (
                <p className="rounded-md border border-dashed border-neutral-200 px-3 py-4 text-center text-sm text-neutral-500">
                  No assignments yet.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-neutral-200">
                  <table className="w-full text-sm">
                    <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">Target</th>
                        <th className="px-3 py-2 text-left font-semibold">Type</th>
                        <th className="px-3 py-2 text-left font-semibold">Priority</th>
                        <th className="px-3 py-2 text-right font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {assignments.map((assignment) => (
                        <tr key={assignment.id}>
                          <td className="px-3 py-2 text-neutral-800">
                            {targetName(assignment)}
                          </td>
                          <td className="px-3 py-2 capitalize text-neutral-600">
                            {assignment.target_type || (assignment.device_id ? 'device' : 'group')}
                          </td>
                          <td className="px-3 py-2 text-neutral-600">{assignment.priority}</td>
                          <td className="px-3 py-2 text-right">
                            <ActionButton
                              label="Remove assignment"
                              danger
                              onClick={() => removeAssignment(assignment.id)}
                              disabled={assignmentBusy === assignment.id}
                            >
                              {assignmentBusy === assignment.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Trash2 size={14} />
                              )}
                            </ActionButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-3 grid gap-2 rounded-lg border border-neutral-200 bg-neutral-50/60 p-3 sm:grid-cols-[130px_1fr_100px_auto]">
                <select
                  value={assignmentType}
                  onChange={(event) => {
                    setAssignmentType(event.target.value);
                    setAssignmentTarget('');
                    setAssignmentError('');
                  }}
                  className={inputClass}
                  aria-label="Assignment target type"
                >
                  <option value="group">Group</option>
                  <option value="device">Device</option>
                </select>
                <select
                  value={assignmentTarget}
                  onChange={(event) => setAssignmentTarget(event.target.value)}
                  className={inputClass}
                  aria-label="Assignment target"
                >
                  <option value="">Select {assignmentType}…</option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {targetLabel(target)}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={assignmentPriority}
                  onChange={(event) => setAssignmentPriority(event.target.value)}
                  className={inputClass}
                  aria-label="Assignment priority"
                />
                <Button size="sm" onClick={submitAssignment} disabled={assignmentSaving}>
                  {assignmentSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  Assign
                </Button>
              </div>
              {assignmentError && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-red-700">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  {assignmentError}
                </p>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-neutral-900">Recent compliance</h3>
              {manageStatuses.length === 0 ? (
                <p className="rounded-md border border-dashed border-neutral-200 px-3 py-4 text-center text-sm text-neutral-500">
                  No device has reported this policy yet.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-neutral-200">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold">Device</th>
                        <th className="px-3 py-2 text-left font-semibold">Status</th>
                        <th className="px-3 py-2 text-left font-semibold">Version</th>
                        <th className="px-3 py-2 text-left font-semibold">Applied</th>
                        <th className="px-3 py-2 text-left font-semibold">Checked</th>
                        <th className="px-3 py-2 text-left font-semibold">Errors</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {manageStatuses.map((status) => {
                        const errors = Array.isArray(status.errors)
                          ? status.errors
                          : status.errors?.message
                            ? [status.errors.message]
                            : [];
                        return (
                          <tr key={status.id}>
                            <td className="px-3 py-2 text-neutral-800">
                              {status.device?.hostname || status.device_id}
                            </td>
                            <td className="px-3 py-2">
                              <StatusPill value={status.status} />
                            </td>
                            <td className="px-3 py-2 text-neutral-600">
                              v{status.policy_version}
                            </td>
                            <td className="px-3 py-2 text-neutral-600">
                              {status.applied ? 'Yes' : 'No'}
                            </td>
                            <td className="px-3 py-2 text-neutral-500">
                              {formatDateTime(status.checked_at)}
                            </td>
                            <td
                              className="max-w-[240px] truncate px-3 py-2 text-xs text-neutral-500"
                              title={errors.join('; ')}
                            >
                              {errors.length ? errors.join('; ') : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function SummaryCard({ icon, label, value, accent }) {
  return (
    <Card>
      <CardBody className="flex items-center gap-3 py-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ color: accent, background: `${accent}14` }}
        >
          {React.createElement(icon, { size: 17 })}
        </span>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            {label}
          </p>
          <p className="text-lg font-bold text-neutral-900">{value}</p>
        </div>
      </CardBody>
    </Card>
  );
}

function ActionButton({ label, onClick, disabled = false, danger = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100'
      }`}
    >
      {children}
    </button>
  );
}
