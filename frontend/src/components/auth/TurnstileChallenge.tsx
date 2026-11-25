'use client';

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';

export interface TurnstileChallengeRef {
  reset: () => void;
  /**
   * The token for one submission. A token is single-use, so it is handed out once; the widget's green tick alone
   * proves nothing. Waits for the challenge when no unused token exists. '' = no widget could run here (local
   * development without the script: the backend decides); null = the learner still has to complete the challenge.
   */
  freshToken: (timeoutMs?: number) => Promise<string | null>;
}

interface TurnstileChallengeProps {
  onVerify: (token: string) => void;
  onError?: (errorCode?: string) => void;
  action?: string;
  className?: string;
}

// Prevent silent test key fallback in production
const rawConfiguredSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const isTestSiteKey = (key?: string) => !key || /^[123]x0{10,}/.test(key);

const resolvedSiteKey = (() => {
  if (process.env.NODE_ENV === 'production') {
    if (!rawConfiguredSiteKey || isTestSiteKey(rawConfiguredSiteKey)) {
      if (typeof window !== 'undefined') {
        console.error('[Turnstile:Fatal] Production requires a valid Turnstile site key. Test key fallback is prohibited in production.');
      }
      return '';
    }
    return rawConfiguredSiteKey;
  }
  // Local development only fallback
  return rawConfiguredSiteKey || '3x00000000000000000000FF';
})();

export const TurnstileChallenge = forwardRef<TurnstileChallengeRef, TurnstileChallengeProps>(
  function TurnstileChallenge({ onVerify, onError, action, className = '' }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);

    const onVerifyRef = useRef(onVerify);
    const onErrorRef = useRef(onError);
    const tokenRef = useRef('');
    const spentRef = useRef(false);
    const scriptFailedRef = useRef(false);
    const waitersRef = useRef(new Set<(token: string | null) => void>());

    const settle = (token: string | null) => {
      const waiters = Array.from(waitersRef.current);
      waitersRef.current.clear();
      waiters.forEach((resolve) => resolve(token));
    };
    const resetWidget = () => {
      tokenRef.current = '';
      spentRef.current = false;
      if (typeof window !== 'undefined' && (window as any).turnstile && widgetIdRef.current) {
        try {
          (window as any).turnstile.reset(widgetIdRef.current);
        } catch (err) {
          console.warn('[Turnstile] Failed to reset widget:', err);
        }
      }
    };

    useEffect(() => {
      onVerifyRef.current = onVerify;
    }, [onVerify]);

    useEffect(() => {
      onErrorRef.current = onError;
    }, [onError]);

    const siteKey = resolvedSiteKey;

    useImperativeHandle(ref, () => ({
      reset: () => {
        onVerifyRef.current('');
        resetWidget();
      },
      freshToken: (timeoutMs = 12000) => {
        const turnstile = typeof window !== 'undefined' ? (window as any).turnstile : null;
        const id = widgetIdRef.current;
        const expired = !!(turnstile && id && turnstile.isExpired?.(id));
        const token = tokenRef.current;
        if (token && !expired) {
          tokenRef.current = '';
          spentRef.current = true;
          onVerifyRef.current('');
          return Promise.resolve(token);
        }
        if (scriptFailedRef.current) return Promise.resolve(process.env.NODE_ENV !== 'production' ? '' : null);
        if (expired || spentRef.current) resetWidget();
        return new Promise<string | null>((resolve) => {
          const done = (value: string | null) => {
            clearTimeout(timer);
            waitersRef.current.delete(done);
            // A waiter gets the token for itself: nothing else may submit it again.
            if (value) { tokenRef.current = ''; spentRef.current = true; onVerifyRef.current(''); }
            resolve(value);
          };
          const timer = setTimeout(() => done(null), timeoutMs);
          waitersRef.current.add(done);
        });
      },
    }));

    if (!siteKey && process.env.NODE_ENV === 'production') {
      return (
        <div className="w-full text-center py-2">
          <p className="text-xs text-rose-400 bg-rose-950/40 border border-rose-800 p-2.5 rounded-xl">
            Lỗi cấu hình bảo mật: Thiếu Turnstile Site Key hợp lệ.
          </p>
        </div>
      );
    }

    useEffect(() => {
      let isMounted = true;
      let interval: ReturnType<typeof setInterval> | null = null;

      const renderWidget = () => {
        if (!containerRef.current || !isMounted) return;
        if (widgetIdRef.current) return; // already rendered

        const turnstile = (window as any).turnstile;
        if (!turnstile) return;

        try {
          // Presentation only (Cloudflare's supported options): the widget takes the page's theme — the same saved
          // choice AuthShell applies — so a light card never carries a black block; 'flexible' spans the card
          // (minimum 300 px), 'compact' where the card is narrower than that.
          let theme: 'light' | 'dark' = 'light';
          try {
            const saved = localStorage.getItem('theme');
            const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            theme = saved === 'dark' || (!saved && prefersDark) ? 'dark' : 'light';
          } catch {
            theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
          }
          const size = containerRef.current.clientWidth >= 300 ? 'flexible' : 'compact';
          const id = turnstile.render(containerRef.current, {
            sitekey: siteKey,
            action: action || undefined,
            theme,
            size,
            callback: (token: string) => {
              if (isMounted) {
                tokenRef.current = token;
                spentRef.current = false;
                onVerifyRef.current(token);
                settle(token);
              }
            },
            'error-callback': (code: string) => {
              console.warn('[Turnstile] Challenge error:', code);
              if (isMounted) {
                tokenRef.current = '';
                onErrorRef.current?.(code);
              }
            },
            'expired-callback': () => {
              console.warn('[Turnstile] Token expired, requesting re-verification');
              if (isMounted) {
                tokenRef.current = '';
                onErrorRef.current?.('TOKEN_EXPIRED');
              }
            },
            'timeout-callback': () => {
              console.warn('[Turnstile] Challenge timed out');
              if (isMounted) {
                resetWidget();
                onErrorRef.current?.('TOKEN_TIMEOUT');
              }
            },
          });
          widgetIdRef.current = id;
        } catch (e) {
          console.warn('[Turnstile] Failed to render challenge widget:', e);
        }
      };

      if (typeof window !== 'undefined') {
        if ((window as any).turnstile) {
          renderWidget();
        } else {
          // Check if script tag already exists
          const existingScript = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
          if (!existingScript) {
            const script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            script.async = true;
            script.defer = true;
            script.onload = () => {
              if (isMounted && (window as any).turnstile) {
                renderWidget();
              }
            };
            script.onerror = () => {
              console.warn('[Turnstile] Cloudflare script failed to load (offline / blocked). In dev, allowing fallback.');
              scriptFailedRef.current = true;
              settle(process.env.NODE_ENV !== 'production' ? '' : null);
              if (process.env.NODE_ENV !== 'production') {
                onVerifyRef.current('');
              } else {
                onErrorRef.current?.('SCRIPT_LOAD_ERROR');
              }
            };
            document.head.appendChild(script);
          } else {
            // Script already loaded or loading
            interval = setInterval(() => {
              if ((window as any).turnstile) {
                if (interval) clearInterval(interval);
                renderWidget();
              }
            }, 100);
          }
        }
      }

      return () => {
        isMounted = false;
        if (interval) clearInterval(interval);
        tokenRef.current = '';
        settle(null);
        if (typeof window !== 'undefined' && (window as any).turnstile && widgetIdRef.current) {
          try {
            (window as any).turnstile.remove(widgetIdRef.current);
          } catch {}
          widgetIdRef.current = null;
        }
      };
    }, [siteKey, action]);

    return (
      <div
        className={`w-full flex justify-center py-2 ${className}`}
        data-purpose="turnstile-verification-container"
      >
        <div ref={containerRef} className="w-full min-h-[65px] flex items-center justify-center" />
      </div>
    );
  }
);

export default TurnstileChallenge;
