const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function tempPathFor(filePath, label = 'tmp') {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.${label}`;
}

function atomicWriteBuffer(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

function isValidJsonBuffer(buffer) {
  try {
    JSON.parse(buffer.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * 同目录临时文件 + fsync + rename，避免进程中断留下半截 JSON。
 * 每次覆盖前将上一份合法 JSON 原子保存为 .bak。
 */
function atomicWriteJson(filePath, value, options = {}) {
  const { backup = true } = options;
  const serialized = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  if (backup && fs.existsSync(filePath)) {
    const previous = fs.readFileSync(filePath);
    if (isValidJsonBuffer(previous)) atomicWriteBuffer(filePath + '.bak', previous);
  }
  atomicWriteBuffer(filePath, serialized);
}

function parseAndValidate(filePath, validate) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (validate && !validate(value)) throw new Error(`JSON 数据结构不合法: ${filePath}`);
  return value;
}

/**
 * 主文件损坏时读取 .bak 并自动恢复主文件；主备份都不可用时抛错。
 */
function readJsonFile(filePath, options = {}) {
  const { validate } = options;
  try {
    return parseAndValidate(filePath, validate);
  } catch (primaryError) {
    const backupPath = filePath + '.bak';
    try {
      const backupValue = parseAndValidate(backupPath, validate);
      atomicWriteJson(filePath, backupValue, { backup: false });
      console.warn(`JSON 主文件损坏，已从备份恢复: ${filePath}`);
      return backupValue;
    } catch {
      throw primaryError;
    }
  }
}

module.exports = { atomicWriteBuffer, atomicWriteJson, readJsonFile };
