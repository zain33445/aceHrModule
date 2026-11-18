/**
 * Installer packages an admin uploads and pushes to managed devices.
 *
 * The service runs installers as LocalSystem, so devices verify the SHA-256
 * recorded here before running anything, and a device can only download a
 * package it has a pending install command for.
 */

import { createHash, randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import prisma from '../prisma';

export const SOFTWARE_INSTALL_COMMAND = 'software_install';
export const SOFTWARE_DIR = path.join(process.cwd(), 'uploads', 'device-software');
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

export class SoftwarePackageError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'SoftwarePackageError';
  }
}

function serialize<T extends { size_bytes: bigint }>(row: T) {
  return { ...row, size_bytes: Number(row.size_bytes) };
}

export async function storePackage(
  body: Readable,
  meta: { name: string; filename: string; silentArgs: string; createdBy?: string }
) {
  const kind = path.extname(meta.filename).slice(1).toLowerCase();
  if (kind !== 'msi' && kind !== 'exe') {
    throw new SoftwarePackageError('Only .msi and .exe installers are supported.');
  }
  // An .exe with no silent switch would wait forever for a click nobody can see.
  if (kind === 'exe' && !meta.silentArgs) {
    throw new SoftwarePackageError(
      'An .exe installer needs its silent install switch, such as /S or /quiet.'
    );
  }

  const id = randomUUID();
  const target = path.join(SOFTWARE_DIR, id);
  const hash = createHash('sha256');
  let size = 0;

  await mkdir(SOFTWARE_DIR, { recursive: true });
  try {
    await pipeline(
      body,
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_PACKAGE_BYTES) {
            callback(new SoftwarePackageError('Installer is larger than 2 GB.', 413));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(target)
    );
    if (size === 0) throw new SoftwarePackageError('The uploaded file is empty.');

    const row = await prisma.deviceSoftwarePackage.create({
      data: {
        id,
        name: meta.name,
        filename: meta.filename,
        kind,
        sha256: hash.digest('hex'),
        size_bytes: BigInt(size),
        silent_args: meta.silentArgs,
        created_by: meta.createdBy ?? null,
      },
    });
    return serialize(row);
  } catch (err) {
    await rm(target, { force: true });
    throw err;
  }
}

export async function listPackages() {
  const rows = await prisma.deviceSoftwarePackage.findMany({
    orderBy: { created_at: 'desc' },
  });
  return rows.map(serialize);
}

export async function getPackage(id: string) {
  const row = await prisma.deviceSoftwarePackage.findUnique({ where: { id } });
  return row ? serialize(row) : null;
}

export async function deletePackage(id: string) {
  const row = await prisma.deviceSoftwarePackage.findUnique({ where: { id } });
  if (!row) return null;
  await prisma.deviceSoftwarePackage.delete({ where: { id } });
  await rm(path.join(SOFTWARE_DIR, id), { force: true });
  return serialize(row);
}

export async function resolveInstallTargets(options: {
  deviceIds?: string[];
  groupId?: string;
}) {
  return prisma.device.findMany({
    where: options.groupId
      ? { group_id: options.groupId }
      : { id: { in: options.deviceIds ?? [] } },
    select: { id: true, hostname: true },
  });
}

export async function deviceMayDownload(deviceId: string, packageId: string) {
  const pending = await prisma.deviceCommand.findFirst({
    where: {
      device_id: deviceId,
      type: SOFTWARE_INSTALL_COMMAND,
      status: { in: ['queued', 'sent'] },
      payload: { path: ['package_id'], equals: packageId },
    },
    select: { id: true },
  });
  return Boolean(pending);
}

export async function listInstalls(limit: number) {
  return prisma.deviceCommand.findMany({
    where: { type: SOFTWARE_INSTALL_COMMAND },
    orderBy: { created_at: 'desc' },
    take: limit,
    select: {
      id: true,
      status: true,
      payload: true,
      result: true,
      created_at: true,
      ack_at: true,
      device: { select: { id: true, hostname: true } },
    },
  });
}
