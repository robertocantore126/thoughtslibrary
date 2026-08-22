const fs = require('node:fs')
const path = require('node:path')
const process = require('node:process')

// Writing a file in place truncates it the instant the call starts, so an
// interrupted write - a full disk (ENOSPC throws part-way through), a crash, a
// locked file, power loss - destroys the old contents and leaves a partial file
// with nothing to fall back on. The bytes go to a temp file in the same
// directory, are flushed to disk, and only then replace the target in a single
// rename. The previous contents are kept alongside as `.bak`, so even a rename
// that goes wrong leaves a recoverable copy.
function writeFileAtomicSync(filePath, data, encoding) {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)

  try {
    const fd = fs.openSync(tmpPath, 'w')
    try {
      fs.writeFileSync(fd, data, encoding ? { encoding } : undefined)
      // Without the flush the rename can land before the bytes do, which on a
      // power loss leaves an intact-looking file full of zeroes.
      fs.fsyncSync(fd)
    }
    finally {
      fs.closeSync(fd)
    }

    if (fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`)
      }
      catch (error) {
        // A backup that cannot be written is not a reason to refuse the save;
        // the rename below is still atomic.
        console.warn('Could not write the backup copy:', error)
      }
    }

    // Atomic on NTFS and on POSIX when both paths are on the same volume, which
    // they are: the temp file is created in the target's own directory.
    fs.renameSync(tmpPath, filePath)
  }
  catch (error) {
    try {
      fs.unlinkSync(tmpPath)
    }
    catch {
      // Already gone, or never created.
    }
    throw error
  }
}

module.exports = { writeFileAtomicSync }
