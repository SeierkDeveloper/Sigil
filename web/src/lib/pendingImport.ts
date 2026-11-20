// A file dropped on the Import page waits here until the vault's Import tab
// picks it up. It lives in memory only and never leaves this browser tab.

let pending: File | null = null;

export function setPendingImport(file: File): void {
  pending = file;
}

/** Returns the waiting file once, then forgets it. */
export function takePendingImport(): File | null {
  const file = pending;
  pending = null;
  return file;
}
