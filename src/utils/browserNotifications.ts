const PREF_STORAGE_KEY = 'radar_browser_alerts_enabled_v1';
const SENT_KEYS_STORAGE_KEY = 'radar_notified_keys_v1';

const memorySentKeys = new Set<string>();

export type BrowserNotificationKind = 'TRADE_SETUP' | 'SHADOW_V2';

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isNotificationSupported()) return 'unsupported';
  return window.Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isNotificationSupported()) return 'unsupported';
  try {
    return await window.Notification.requestPermission();
  } catch {
    return getNotificationPermission();
  }
}

export function loadNotificationPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PREF_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveNotificationPreference(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREF_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore storage restriction
  }
}

export function buildNotificationKey(
  kind: BrowserNotificationKind,
  ticker: string,
  sessionDate: string,
  extra: string = ''
): string {
  return `${kind}:${ticker.toUpperCase()}:${sessionDate}:${extra}`;
}

export function shouldNotifyOnce(
  key: string,
  registry: Set<string> = memorySentKeys
): boolean {
  if (!key) return false;
  if (registry.has(key)) return false;

  if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
    try {
      const raw = window.sessionStorage.getItem(SENT_KEYS_STORAGE_KEY);
      const parsed: string[] = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        for (const existing of parsed) registry.add(existing);
        if (registry.has(key)) return false;
      }
      registry.add(key);
      const trimmed = Array.from(registry).slice(-200);
      window.sessionStorage.setItem(SENT_KEYS_STORAGE_KEY, JSON.stringify(trimmed));
      return true;
    } catch {
      // fall through to in-memory set
    }
  }

  registry.add(key);
  return true;
}

export function dispatchBrowserNotification(payload: {
  key: string;
  title: string;
  body: string;
  tag?: string;
}): boolean {
  if (!isNotificationSupported()) return false;
  if (window.Notification.permission !== 'granted') return false;
  if (!shouldNotifyOnce(payload.key)) return false;

  try {
    new window.Notification(payload.title, {
      body: payload.body,
      tag: payload.tag ?? payload.key,
      icon: '/favicon.ico',
    });
    return true;
  } catch {
    return false;
  }
}
