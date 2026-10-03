import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Hash bundle files and directories, record resolved symlink targets, and reject links outside the protected installation.
 * @param directory - Installed bundle package directory.
 * @param allowedRoot - Protected installation root that symlink targets must remain inside.
 * @returns Lowercase SHA-256 digest of the ordered directory entries.
 */
export function hashEnterpriseBundleDirectory(directory: string, allowedRoot = directory): string {
  const root = realpathSync.native(directory)
  const protectedRoot = realpathSync.native(allowedRoot)
  if (!lstatSync(root).isDirectory()) throw new Error('enterprise bundle: expected a directory')
  const packageRelative = relative(protectedRoot, root)
  if (packageRelative === '..' || packageRelative.startsWith(`..${sep}`)) {
    throw new Error('enterprise bundle: package directory must be inside the protected installation')
  }
  const entries: Array<{ readonly path: string; readonly kind: 'directory' | 'file' | 'link' }> = []
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) entries.push({ path, kind: 'link' })
      else if (info.isDirectory()) {
        entries.push({ path, kind: 'directory' })
        visit(path)
      }
      else if (info.isFile()) entries.push({ path, kind: 'file' })
      /* v8 ignore else -- Windows has no FIFO or device-file fixture; POSIX coverage verifies this rejection. */
      else throw new Error('enterprise bundle: only regular files and directories are allowed')
    }
  }
  visit(root)
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(relative(root, left.path).split(sep).join('/')),
    Buffer.from(relative(root, right.path).split(sep).join('/')),
  ))

  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  for (const { path, kind } of entries) {
    const name = Buffer.from(relative(root, path).split(sep).join('/'))
    digest.update(kind === 'file' ? 'F' : kind === 'link' ? 'L' : 'D')
      .update(Buffer.from(`${name.length}:`)).update(name).update(Buffer.from(':'))
    if (kind === 'link') {
      const target = realpathSync.native(path)
      const targetRelative = relative(protectedRoot, target)
      const targetInfo = statSync(target)
      if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || !targetInfo.isFile() && !targetInfo.isDirectory()) {
        throw new Error('enterprise bundle: symbolic links must resolve inside the protected installation')
      }
      digest.update(createHash('sha256').update(targetRelative.split(sep).join('/')).digest())
      continue
    }
    if (kind === 'directory') {
      digest.update(createHash('sha256').digest())
      continue
    }
    const fileDigest = createHash('sha256')
    const descriptor = openSync(path, 'r')
    try {
      let count: number
      while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) {
        fileDigest.update(buffer.subarray(0, count))
      }
    } finally {
      closeSync(descriptor)
    }
    digest.update(fileDigest.digest())
  }
  return digest.digest('hex')
}
