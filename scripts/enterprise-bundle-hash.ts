import { hashEnterpriseBundleDirectory } from '../packages/boot/app-boot/src/enterprise-bundle-integrity.ts'

const [directory, ...extra] = process.argv.slice(2)
const root = extra.length === 0 ? directory
  : extra.length === 2 && extra[0] === '--root' ? extra[1] : undefined
if (directory === undefined || root === undefined) {
  throw new Error('Usage: pnpm run enterprise:bundle-hash <package-directory> [--root <installation-directory>]')
}
process.stdout.write(`${hashEnterpriseBundleDirectory(directory, root)}\n`)
