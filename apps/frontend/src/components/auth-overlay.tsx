import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { apiClient } from '../api/client';
import type { ThemePresetId } from '../constants/theme';
import { useAuthStore } from '../stores/auth-store';

const LAST_THEME_PRESET_STORAGE_KEY = 'ahcc:lastThemePreset';

type RecoveryMode = { kind: 'forgot' } | { kind: 'reset' | 'invite'; token: string };

function recoveryFromLocation(): RecoveryMode | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    return null;
  }
  if (window.location.pathname === '/reset-password') {
    return { kind: 'reset', token };
  }
  if (window.location.pathname === '/accept-invite') {
    return { kind: 'invite', token };
  }
  return null;
}

export function AuthOverlay() {
  const { status, isSubmitting, error, disclaimer, postLoginNotice, userThemePreset } =
    useAuthStore((state) => ({
      status: state.status,
      isSubmitting: state.isSubmitting,
      error: state.error,
      disclaimer: state.disclaimer,
      postLoginNotice: state.postLoginNotice,
      userThemePreset: state.user?.preferences?.themePreset ?? null,
    }));
  const login = useAuthStore((state) => state.login);
  const acceptLegal = useAuthStore((state) => state.acceptLegal);
  const verifyTwoFactor = useAuthStore((state) => state.verifyTwoFactor);
  const clearError = useAuthStore((state) => state.clearError);
  const logout = useAuthStore((state) => state.logout);
  const clearPostLoginNotice = useAuthStore((state) => state.clearPostLoginNotice);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [ackChecked, setAckChecked] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [honeypotValue, setHoneypotValue] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [preferredPreset, setPreferredPreset] = useState<ThemePresetId>('tactical_ops');
  const [recovery, setRecovery] = useState<RecoveryMode | null>(recoveryFromLocation);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const formStartRef = useRef<number>(Date.now());

  const overlayVisible = status !== 'authenticated';
  const showLegalStep = status === 'legal';
  const showTwoFactorStep = status === 'twoFactor';

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (userThemePreset === 'classic' || userThemePreset === 'tactical_ops') {
      setPreferredPreset(userThemePreset);
      window.localStorage.setItem(LAST_THEME_PRESET_STORAGE_KEY, userThemePreset);
      return;
    }
    const stored = window.localStorage.getItem(LAST_THEME_PRESET_STORAGE_KEY);
    if (stored === 'classic' || stored === 'tactical_ops') {
      setPreferredPreset(stored);
    }
  }, [status, userThemePreset]);

  useEffect(() => {
    if (status === 'login') {
      formStartRef.current = Date.now();
      setHoneypotValue('');
    }
  }, [status]);

  useEffect(() => {
    if (showLegalStep) {
      setHasScrolled(false);
      setAckChecked(false);
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    }
  }, [showLegalStep]);

  useEffect(() => {
    if (!showTwoFactorStep) {
      setTwoFactorCode('');
    }
  }, [showTwoFactorStep]);

  useEffect(() => {
    if (status === 'authenticated' && postLoginNotice) {
      window.alert(postLoginNotice);
      clearPostLoginNotice();
    }
  }, [status, postLoginNotice, clearPostLoginNotice]);

  const handleLogin = (event: FormEvent) => {
    event.preventDefault();
    clearError();
    void login(email, password, {
      submittedAt: formStartRef.current,
      honeypot: honeypotValue,
      rememberMe,
    });
    formStartRef.current = Date.now();
  };

  const handleAccept = (event: FormEvent) => {
    event.preventDefault();
    clearError();
    void acceptLegal();
  };

  const handleVerifyTwoFactor = (event: FormEvent) => {
    event.preventDefault();
    if (!twoFactorCode.trim()) {
      return;
    }
    clearError();
    void verifyTwoFactor(twoFactorCode.trim());
  };

  const leaveRecovery = (message: string | null) => {
    if (window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }
    setRecovery(null);
    setNewPassword('');
    setConfirmPassword('');
    setRecoveryError(null);
    setNotice(message);
  };

  const handleRecovery = async (event: FormEvent) => {
    event.preventDefault();
    if (!recovery) {
      return;
    }
    setRecoveryError(null);
    if (recovery.kind !== 'forgot' && newPassword !== confirmPassword) {
      setRecoveryError('Passwords do not match.');
      return;
    }
    setRecoveryBusy(true);
    try {
      if (recovery.kind === 'forgot') {
        await apiClient.post('/auth/forgot-password', { email: recoveryEmail.trim() });
        leaveRecovery('If that email has an account, a reset link is on its way.');
      } else if (recovery.kind === 'reset') {
        await apiClient.post('/auth/reset-password', {
          token: recovery.token,
          password: newPassword,
        });
        leaveRecovery('Password changed. Sign in with your new password.');
      } else {
        await apiClient.post('/auth/accept-invite', {
          token: recovery.token,
          password: newPassword,
        });
        leaveRecovery('Account created. Sign in to continue.');
      }
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRecoveryBusy(false);
    }
  };

  const legalReady = useMemo(() => hasScrolled && ackChecked, [hasScrolled, ackChecked]);

  if (!overlayVisible) {
    return null;
  }

  const overlayClassName =
    preferredPreset === 'tactical_ops' ? 'auth-overlay auth-overlay--tactical' : 'auth-overlay';

  return (
    <div className={overlayClassName} role="dialog" aria-modal="true">
      <div className="auth-overlay__panel">
        <header className="auth-overlay__header">
          <img
            className="auth-overlay__logo-mark"
            src="/logo111.png"
            alt="AntiHunter Shield Logo"
          />
        </header>

        {error && !recovery ? <div className="auth-overlay__error">{error}</div> : null}
        {recoveryError ? <div className="auth-overlay__error">{recoveryError}</div> : null}
        {notice && !recovery ? <p className="auth-overlay__hint">{notice}</p> : null}

        {status === 'checking' ? (
          <div className="auth-overlay__loading">Validating session.</div>
        ) : recovery ? (
          <form onSubmit={handleRecovery} className="auth-overlay__form">
            {recovery.kind === 'forgot' ? (
              <label>
                <span>Email</span>
                <input
                  type="email"
                  value={recoveryEmail}
                  autoComplete="username"
                  onChange={(event) => setRecoveryEmail(event.target.value)}
                />
              </label>
            ) : (
              <>
                <label>
                  <span>{recovery.kind === 'invite' ? 'Choose a password' : 'New password'}</span>
                  <input
                    type="password"
                    value={newPassword}
                    minLength={8}
                    autoComplete="new-password"
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <label>
                  <span>Confirm password</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    minLength={8}
                    autoComplete="new-password"
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </label>
              </>
            )}
            <button
              type="submit"
              className="submit-button"
              disabled={
                recoveryBusy ||
                (recovery.kind === 'forgot'
                  ? !recoveryEmail.trim()
                  : newPassword.length < 8 || !confirmPassword)
              }
            >
              {recoveryBusy
                ? 'Working.'
                : recovery.kind === 'forgot'
                  ? 'Send reset link'
                  : recovery.kind === 'invite'
                    ? 'Create account'
                    : 'Set password'}
            </button>
            <button
              type="button"
              className="auth-overlay__text-link"
              onClick={() => leaveRecovery(null)}
            >
              Back to sign in
            </button>
          </form>
        ) : showLegalStep ? (
          <form onSubmit={handleAccept} className="auth-overlay__form">
            <div
              className="auth-overlay__disclaimer"
              ref={scrollRef}
              onScroll={(event) => {
                const target = event.currentTarget;
                if (target.scrollTop + target.clientHeight >= target.scrollHeight - 8) {
                  setHasScrolled(true);
                }
              }}
            >
              <pre>{disclaimer}</pre>
            </div>
            <label className="auth-overlay__checkbox">
              <input
                type="checkbox"
                checked={ackChecked}
                onChange={(event) => setAckChecked(event.target.checked)}
              />
              <span>I have read and accept the legal agreement above.</span>
            </label>
            <button type="submit" className="submit-button" disabled={!legalReady || isSubmitting}>
              {isSubmitting ? 'Saving.' : 'Accept and Continue'}
            </button>
          </form>
        ) : showTwoFactorStep ? (
          <form onSubmit={handleVerifyTwoFactor} className="auth-overlay__form">
            <p className="auth-overlay__hint">
              Enter the 6-digit code from your authenticator app or one of your recovery codes.
              Codes are not case-sensitive.
            </p>
            <label>
              <span>Authenticator or Recovery Code</span>
              <input
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                value={twoFactorCode}
                onChange={(event) => setTwoFactorCode(event.target.value)}
                placeholder="123456 or ABCD-EFGH-IJKL-MNOP"
              />
            </label>
            <div className="auth-overlay__actions">
              <button
                type="submit"
                className="submit-button"
                disabled={isSubmitting || twoFactorCode.trim().length < 6}
              >
                {isSubmitting ? 'Verifying.' : 'Verify Code'}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  clearError();
                  logout();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="auth-overlay__form">
            <div className="auth-overlay__honeypot" aria-hidden="true">
              <label htmlFor="auth-overlay-website">Website</label>
              <input
                id="auth-overlay-website"
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={honeypotValue}
                onChange={(event) => setHoneypotValue(event.target.value)}
              />
            </div>
            <input type="hidden" name="submittedAt" value={String(formStartRef.current)} />
            <label>
              <span>Email</span>
              <input
                type="email"
                value={email}
                autoComplete="username"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label className="checkbox-label auth-overlay__remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              Keep me signed in for 10 days
            </label>
            <button type="submit" className="submit-button" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in.' : 'Sign In'}
            </button>
            <button
              type="button"
              className="auth-overlay__text-link"
              onClick={() => {
                clearError();
                setNotice(null);
                setRecoveryEmail(email);
                setRecovery({ kind: 'forgot' });
              }}
            >
              Forgot password?
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
