'use client';

import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useConfig } from '@/hooks/use-config';
import { productName } from '@/lib/product-name';
import { appPasswordDescription } from '@/lib/plugin-secrets/credentials';
import { useAuthStore } from '@/stores/auth-store';
import {
  currentConnect,
  originFromInput,
  saveCredential,
  subscribeConnect,
  type SaveCredentialInput,
} from '@/lib/plugin-sandbox/connect-dialog';

/**
 * The host's own "Connect account" dialog (see lib/plugin-sandbox/connect-dialog.ts).
 * Everything here is rendered by the host: the plugin can't change the text,
 * and what the user types goes to the server, never to the plugin.
 */
export function PluginConnectDialog() {
  const request = useSyncExternalStore(subscribeConnect, currentConnect, () => null);
  const t = useTranslations('plugins.connect');
  const appName = productName(useConfig().appName);
  const account = useAuthStore((s) => s.username) ?? '';
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const titleId = useId();
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setServer(request?.suggestedOrigin ?? '');
    setUsername(request?.suggestedUsername ?? '');
    setSecret('');
    setError(null);
    setSaving(false);
  }, [request?.id, request?.suggestedOrigin, request?.suggestedUsername]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') request.resolve({ connected: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;

  const { spec, mode, pluginName } = request;
  // The server makes an app password on the account the user is signed in
  // to: nothing to type, and that account's server is the origin.
  const appPassword = mode === 'appPassword';
  const fixedOrigin = spec.origin ?? (appPassword && serverUrl ? originFromInput(serverUrl) ?? undefined : undefined);
  const needsUsername = mode === 'password' && spec.inject.type === 'basic';
  const needsSecret = mode === 'password' && spec.inject.type !== 'none';
  const origin = fixedOrigin ?? originFromInput(server);
  const canSubmit = (appPassword || !!origin) && (!needsSecret || !!secret) && (!needsUsername || !!username.trim()) && !saving;

  const submit = async () => {
    const base = { pluginId: request.pluginId, credentialId: request.credentialId, label: spec.label };
    const input: SaveCredentialInput | null = appPassword
      ? { ...base, appPassword: true }
      : origin
        ? {
          ...base,
          origin,
          inject: spec.inject,
          ...(needsUsername ? { username: username.trim() } : {}),
          ...(needsSecret ? { secret } : {}),
        }
        : null;
    if (!input) {
      setError(t('error_server'));
      return;
    }
    setSaving(true);
    setError(null);
    const failure = await saveCredential(input);
    setSaving(false);
    if (failure) {
      setError(t('error_save', { error: failure }));
      return;
    }
    request.resolve({ connected: mode !== 'signin', ...(origin ? { origin } : {}) });
  };

  const host = origin ? new URL(origin).host : null;
  const intro = appPassword
    ? t('intro_app_password', { name: pluginName, account, description: appPasswordDescription(pluginName), appName })
    : mode === 'signin'
      ? t('intro_signin', { name: pluginName, label: spec.label, appName })
      : host
        ? t('intro_password', { name: pluginName, label: spec.label, host, appName })
        : t('intro_password_any', { name: pluginName, label: spec.label, appName });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) request.resolve({ connected: false });
      }}
    >
      <div className="flex w-full max-w-[440px] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-xl">
        <form className="p-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="mb-3 flex items-center gap-2">
            <KeyRound className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <h2 id={titleId} className="text-base font-semibold">{t('title', { label: spec.label })}</h2>
          </div>
          <p className="mb-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">{intro}</p>
          <div className="mb-4 flex flex-col gap-3">
            {!fixedOrigin && !appPassword && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">{t('server')}</span>
                {/* Not type="url": the browser would refuse "cloud.example.com"
                    without https://, which originFromInput adds. */}
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={server}
                  placeholder={t('server_hint')}
                  autoFocus
                  onChange={(e) => setServer(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
            )}
            {needsUsername && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">{t('username')}</span>
                <input
                  type="text"
                  value={username}
                  autoComplete="username"
                  autoFocus={!!fixedOrigin}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
            )}
            {needsSecret && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">{t('secret')}</span>
                <input
                  type="password"
                  value={secret}
                  autoComplete="off"
                  autoFocus={!!fixedOrigin && !needsUsername}
                  onChange={(e) => setSecret(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => request.resolve({ connected: false })}>{t('cancel')}</Button>
            <Button type="submit" disabled={!canSubmit} autoFocus={appPassword}>
              {saving ? t('saving') : mode === 'signin' ? t('continue') : t('connect')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
