export interface VersionStatus {
  state: 'update-available' | 'up-to-date' | 'ahead' | 'unknown';
  updateAvailable: boolean;
  message: string;
}

/** Only compare stable numeric releases. Build metadata does not change precedence. */
function stableVersion(value: unknown): { parts: number[]; label: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!match || match[0] !== value) return undefined;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return undefined;
  return { parts, label: value.replace(/^v/, '') };
}

/** A different version is not necessarily newer, and an unreadable version is not current. */
export function getVersionStatus(current: unknown, latest: unknown): VersionStatus {
  const running = stableVersion(current);
  const published = stableVersion(latest);
  if (!running || !published) {
    return { state: 'unknown', updateAvailable: false, message: 'Version status unavailable' };
  }

  for (let i = 0; i < 3; i++) {
    if (published.parts[i] > running.parts[i]) {
      return {
        state: 'update-available',
        updateAvailable: true,
        message: `v${published.label} available`,
      };
    }
    if (published.parts[i] < running.parts[i]) {
      return {
        state: 'ahead',
        updateAvailable: false,
        message: 'Running newer than latest release',
      };
    }
  }
  return { state: 'up-to-date', updateAvailable: false, message: 'Up to date' };
}

/** Never treat an HTTP error or an invalid payload as a successful update check. */
export async function readLatestVersionResponse(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`latest-version fetch failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid latest-version response');
  }
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid latest-version response');
  }
  const version = (data as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Invalid latest-version response');
  }
  return version;
}
