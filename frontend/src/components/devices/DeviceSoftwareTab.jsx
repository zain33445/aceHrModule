import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, RefreshCw, Trash2, Upload } from 'lucide-react';
import api from '../../services/api';
import { Card, CardBody } from '../common/Card';
import { Button } from '../common/Button';
import Modal from '../common/Modal';

const inputClass =
  'w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100';
const labelClass =
  'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-500';

// Must match MAX_PACKAGE_BYTES in nodejs-backend device-software.service.ts
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

const INSTALL_STATUS = {
  queued: { label: 'Waiting for PC', tone: 'text-neutral-600' },
  sent: { label: 'Installing', tone: 'text-blue-700' },
  acked: { label: 'Installing', tone: 'text-blue-700' },
  completed: { label: 'Installed', tone: 'text-emerald-700' },
  failed: { label: 'Failed', tone: 'text-red-700' },
};

function errorMessage(err, fallback) {
  const data = err?.response?.data;
  return data?.error || data?.message || err?.message || fallback;
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-PK');
}

export default function DeviceSoftwareTab() {
  const [packages, setPackages] = useState([]);
  const [installs, setInstalls] = useState([]);
  const [devices, setDevices] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [silentArgs, setSilentArgs] = useState('');
  const [progress, setProgress] = useState(null);
  const [uploadError, setUploadError] = useState('');

  const [installing, setInstalling] = useState(null);
  const [targetType, setTargetType] = useState('devices');
  const [selectedDevices, setSelectedDevices] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState('');

  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [packageRes, installRes, deviceRes, groupRes] = await Promise.all([
        api.getDeviceSoftware(),
        api.getDeviceSoftwareInstalls(),
        api.getDevices(),
        api.getDeviceGroups(),
      ]);
      setPackages(packageRes.data?.packages || []);
      setInstalls(installRes.data?.installs || []);
      setDevices(deviceRes.data?.devices || []);
      setGroups(groupRes.data?.groups || []);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Could not load device software.'));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 15000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  const isExe = file?.name.toLowerCase().endsWith('.exe');
  const tooBig = !!file && file.size > MAX_PACKAGE_BYTES;

  const submitUpload = async (event) => {
    event.preventDefault();
    if (!file || tooBig || progress !== null || (isExe && !silentArgs.trim())) return;
    setUploadError('');
    setProgress(0);
    try {
      await api.uploadDeviceSoftware(file, { name: name.trim(), silentArgs }, (update) => {
        if (update.total) setProgress(Math.round((update.loaded / update.total) * 100));
      });
      setFile(null);
      setName('');
      setSilentArgs('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (err) {
      setUploadError(errorMessage(err, 'The upload failed.'));
    }
    setProgress(null);
  };

  const openInstall = (software) => {
    setInstalling(software);
    setTargetType('devices');
    setSelectedDevices([]);
    setSelectedGroup('');
    setInstallError('');
  };

  const toggleDevice = (id) => {
    setSelectedDevices((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
  };

  const hasTarget = targetType === 'devices' ? selectedDevices.length > 0 : Boolean(selectedGroup);

  const submitInstall = async () => {
    if (!hasTarget || installBusy) return;
    setInstallBusy(true);
    setInstallError('');
    try {
      await api.installDeviceSoftware(
        installing.id,
        targetType === 'devices' ? { device_ids: selectedDevices } : { group_id: selectedGroup },
      );
      setInstalling(null);
      await load();
    } catch (err) {
      setInstallError(errorMessage(err, 'Could not start the install.'));
    }
    setInstallBusy(false);
  };

  const confirmRemove = async () => {
    setRemoveBusy(true);
    try {
      await api.deleteDeviceSoftware(removing.id);
      setRemoving(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the installer.'));
      setRemoving(null);
    }
    setRemoveBusy(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Device Software</h2>
          <p className="text-sm text-neutral-500">
            Upload an installer, then install it silently on managed PCs.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={load}>
          <RefreshCw size={14} className="mr-1.5 inline" />
          Refresh
        </Button>
      </div>

      {error && (
        <p role="alert" className="flex items-center gap-2 text-sm text-red-700">
          <AlertCircle size={15} />
          {error}
        </p>
      )}

      <Card>
        <CardBody>
          <form onSubmit={submitUpload} className="grid gap-3 md:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="software-file">
                Installer (.msi or .exe, up to 2 GB)
              </label>
              <input
                id="software-file"
                ref={fileRef}
                type="file"
                accept=".msi,.exe"
                onChange={(event) => {
                  const chosen = event.target.files?.[0] || null;
                  setFile(chosen);
                  if (chosen && !name) setName(chosen.name.replace(/\.(msi|exe)$/i, ''));
                }}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="software-name">
                Name
              </label>
              <input
                id="software-name"
                type="text"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Google Chrome"
                className={inputClass}
              />
            </div>
            <div className="md:col-span-2">
              <label className={labelClass} htmlFor="software-args">
                Silent install switches {isExe ? '(required for .exe)' : '(optional)'}
              </label>
              <input
                id="software-args"
                type="text"
                maxLength={500}
                required={isExe}
                value={silentArgs}
                onChange={(event) => setSilentArgs(event.target.value)}
                placeholder={isExe ? 'e.g. /S or /quiet' : 'e.g. ALLUSERS=1'}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-neutral-500">
                .msi files install silently on their own. Each .exe has its own switch, so check
                its vendor's documentation. PCs are never restarted automatically.
              </p>
            </div>
            {(tooBig || uploadError) && (
              <p role="alert" className="text-sm text-red-700 md:col-span-2">
                {tooBig ? 'This installer is larger than 2 GB, which is the upload limit.' : uploadError}
              </p>
            )}
            <div className="md:col-span-2">
              <Button type="submit" size="sm" disabled={!file || tooBig || !name.trim() || progress !== null || (isExe && !silentArgs.trim())}>
                <Upload size={14} className="mr-1.5 inline" />
                {progress === null ? 'Upload installer' : `Uploading ${progress}%`}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-neutral-800">Installers</h3>
          {loading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : packages.length === 0 ? (
            <p className="text-sm text-neutral-500">No installers uploaded yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {packages.map((software) => (
                <li key={software.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-neutral-800">{software.name}</p>
                    <p className="break-all text-xs text-neutral-500">
                      {software.filename} · {formatSize(software.size_bytes)}
                      {software.silent_args ? ` · ${software.silent_args}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => openInstall(software)}>
                      <Download size={14} className="mr-1.5 inline" />
                      Install
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Delete ${software.name}`}
                      onClick={() => setRemoving(software)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="mb-3 text-sm font-semibold text-neutral-800">Recent installs</h3>
          {installs.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing has been installed yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {installs.map((install) => {
                const meta = INSTALL_STATUS[install.status] || {
                  label: install.status,
                  tone: 'text-neutral-600',
                };
                return (
                  <li key={install.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-neutral-800">
                        {install.payload?.name || 'Software'} on {install.device?.hostname || 'unknown PC'}
                      </p>
                      <p className="break-words text-xs text-neutral-500">
                        {formatDateTime(install.created_at)}
                        {install.result?.message ? ` · ${install.result.message}` : ''}
                      </p>
                    </div>
                    <span className={`shrink-0 font-semibold ${meta.tone}`}>{meta.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <Modal
        isOpen={Boolean(installing)}
        onClose={() => setInstalling(null)}
        title={installing ? `Install ${installing.name}` : ''}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setInstalling(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={submitInstall} disabled={!hasTarget || installBusy}>
              {installBusy ? 'Starting…' : 'Install now'}
            </Button>
          </div>
        }
      >
        <p className="mb-3 text-sm text-neutral-600">
          This runs the installer with full system rights on the PCs you choose. Offline PCs install
          it when they next connect. Only install software you trust.
        </p>
        <div className="mb-3">
          <label className={labelClass} htmlFor="software-target">
            Install on
          </label>
          <select
            id="software-target"
            value={targetType}
            onChange={(event) => setTargetType(event.target.value)}
            className={inputClass}
          >
            <option value="devices">Selected PCs</option>
            <option value="group">A device group</option>
          </select>
        </div>
        {targetType === 'group' ? (
          <div>
            <label className={labelClass} htmlFor="software-group">
              Group
            </label>
            <select
              id="software-group"
              value={selectedGroup}
              onChange={(event) => setSelectedGroup(event.target.value)}
              className={inputClass}
            >
              <option value="">Choose a group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
        ) : devices.length === 0 ? (
          <p className="text-sm text-neutral-500">No devices are enrolled yet.</p>
        ) : (
          <ul className="max-h-[16rem] space-y-1 overflow-y-auto">
            {devices.map((device) => (
              <li key={device.id}>
                <label className="flex items-center gap-2 text-sm text-neutral-700">
                  <input
                    type="checkbox"
                    checked={selectedDevices.includes(device.id)}
                    onChange={() => toggleDevice(device.id)}
                  />
                  {device.hostname}
                  <span className="text-xs text-neutral-400">{device.status}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {installError && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {installError}
          </p>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={removing ? `Delete ${removing.name}?` : ''}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={confirmRemove} disabled={removeBusy}>
              Delete
            </Button>
          </div>
        }
      >
        <p className="text-sm text-neutral-600">
          This removes the uploaded file. It doesn't uninstall anything from PCs, and installs still
          waiting for this file will fail.
        </p>
      </Modal>
    </div>
  );
}
