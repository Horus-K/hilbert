const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const pkg = require('../../package.json');
const {
  DATA_DIR,
  DATA_FILE,
  GROUPS_FILE,
  ROLES_FILE,
  BACKUPS_DIR,
  operations
} = require('../config');
const { AppError } = require('../utils/errors');
const { getEncryptionStatus } = require('../utils/secret-crypto');
const { atomicWriteBuffer } = require('../utils/json-file');
const { decryptPageSecrets } = require('../utils/page-secret-store');
const pagesRepo = require('../repositories/pages.repository');
const groupsRepo = require('../repositories/groups.repository');
const rolesRepo = require('../repositories/roles.repository');

const BACKUP_NAME_RE = /^hilbert-\d{8}-\d{6}-[a-f0-9]{8}\.zip$/;
const RESTORE_DIRS = ['pages', 'page-docs', 'custom-pages', 'favorites', 'audit'];
const MAX_RESTORE_BYTES = 500 * 1024 * 1024;

function ensureBackupDir() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function backupName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `hilbert-${stamp}-${crypto.randomBytes(4).toString('hex')}.zip`;
}

function shouldSkip(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized === 'backups' || normalized.startsWith('backups/') ||
    normalized === 'sessions.json' || normalized === 'sessions.json.bak' ||
    normalized.endsWith('.bak') || /\.\d+\.[a-f0-9]+\.tmp$/.test(normalized);
}

function walkFiles(root, current = root, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full);
    if (shouldSkip(relative)) continue;
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push({ full, relative: relative.split(path.sep).join('/') });
  }
  return out;
}

function pruneBackups() {
  const backups = listBackups();
  for (const backup of backups.slice(operations.backup_retention)) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, backup.name)); } catch { /* ignore */ }
  }
}

function createBackup(options = {}) {
  ensureBackupDir();
  const name = backupName();
  const destination = path.join(BACKUPS_DIR, name);
  const zip = new AdmZip();
  const files = walkFiles(DATA_DIR);
  for (const file of files) zip.addLocalFile(file.full, path.posix.dirname('data/' + file.relative));
  const manifest = {
    format: 1,
    appVersion: pkg.version,
    createdAt: new Date().toISOString(),
    reason: options.reason || 'manual',
    encryption: getEncryptionStatus(),
    files: files.map(file => 'data/' + file.relative)
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  atomicWriteBuffer(destination, zip.toBuffer());
  pruneBackups();
  return describeBackup(name);
}

function describeBackup(name) {
  const file = backupPath(name);
  const stat = fs.statSync(file);
  return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUPS_DIR)
    .filter(name => BACKUP_NAME_RE.test(name))
    .map(name => describeBackup(name))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function backupPath(name) {
  if (!BACKUP_NAME_RE.test(String(name || ''))) throw new AppError('备份文件名不合法');
  const resolved = path.resolve(BACKUPS_DIR, name);
  if (!resolved.startsWith(path.resolve(BACKUPS_DIR) + path.sep)) throw new AppError('备份路径不合法');
  if (!fs.existsSync(resolved)) throw new AppError('备份不存在', 404);
  return resolved;
}

function safeEntryPath(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || segments.includes('..') || normalized.includes('\0')) {
    throw new AppError('备份包含不安全路径');
  }
  return normalized;
}

function replaceDirectory(source, target) {
  const dataRoot = path.resolve(DATA_DIR) + path.sep;
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(dataRoot)) throw new Error('恢复目标越过数据目录');
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, resolvedTarget, { recursive: true, force: true });
}

function restoreBackup(name, options = {}) {
  if (options.confirm !== 'RESTORE') throw new AppError('恢复确认文本不正确');
  const file = backupPath(name);
  const zip = new AdmZip(file);
  const entries = zip.getEntries();
  const manifestEntry = entries.find(entry => entry.entryName === 'manifest.json');
  if (!manifestEntry) throw new AppError('备份缺少 manifest.json');
  let manifest;
  try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); } catch { throw new AppError('备份 manifest 无法解析'); }
  if (manifest.format !== 1) throw new AppError('不支持的备份格式');

  const totalBytes = entries.reduce((sum, entry) => sum + (entry.header && entry.header.size || 0), 0);
  if (totalBytes > MAX_RESTORE_BYTES) throw new AppError('备份解压后体积超过限制');

  const staging = fs.mkdtempSync(path.join(path.dirname(DATA_DIR), 'hilbert-restore-'));
  try {
    for (const entry of entries) {
      const name = safeEntryPath(entry.entryName);
      if (name === 'manifest.json' || entry.isDirectory) continue;
      if (!name.startsWith('data/')) throw new AppError('备份包含未知文件');
      const relative = name.slice('data/'.length);
      if (shouldSkip(relative)) continue;
      const target = path.resolve(staging, relative);
      if (!target.startsWith(path.resolve(staging) + path.sep)) throw new AppError('备份包含越界路径');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }

    const pagesFile = path.join(staging, path.basename(DATA_FILE));
    const groupsFile = path.join(staging, path.basename(GROUPS_FILE));
    const rolesFile = path.join(staging, path.basename(ROLES_FILE));
    if (!fs.existsSync(pagesFile) || !fs.existsSync(groupsFile) || !fs.existsSync(rolesFile)) {
      throw new AppError('备份缺少核心 JSON 文件');
    }
    const rawPages = JSON.parse(fs.readFileSync(pagesFile, 'utf8'));
    const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf8'));
    const roles = JSON.parse(fs.readFileSync(rolesFile, 'utf8'));
    if (!Array.isArray(rawPages) || !Array.isArray(groups) || !roles || !Array.isArray(roles.roles) || !Array.isArray(roles.assignments)) {
      throw new AppError('备份核心 JSON 数据结构不合法');
    }
    const pages = decryptPageSecrets(rawPages);
    const safetyBackup = createBackup({ reason: 'pre-restore' });

    for (const dir of RESTORE_DIRS) {
      replaceDirectory(path.join(staging, dir), path.join(DATA_DIR, dir));
    }
    pagesRepo.write(pages);
    groupsRepo.write(groups);
    rolesRepo.write(roles);
    return { restored: name, safetyBackup: safetyBackup.name, manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function deleteBackup(name) {
  const file = backupPath(name);
  fs.unlinkSync(file);
  return { deleted: name };
}

module.exports = { backupPath, createBackup, deleteBackup, listBackups, restoreBackup };
