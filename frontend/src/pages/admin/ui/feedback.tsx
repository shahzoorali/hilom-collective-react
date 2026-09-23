/**
 * Admin feedback primitives: toasts and the confirmation dialog.
 *
 * Toasts replace the silent "it worked, I think" of a list quietly reloading.
 * A toast can carry an **Undo** action, which is how reversible actions
 * (hide, archive, unpublish) should be offered — cheaper for the operator than
 * a confirmation they click through without reading.
 *
 * `useConfirm()` replaces `window.confirm`. The browser dialog can't say what
 * is about to happen in any structure, can't be styled as dangerous, and is
 * read by someone who has already decided. This one states the consequence,
 * marks destructive actions red, and — for the truly irreversible — can
 * require typing a word before the button unlocks.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// --- toasts ---------------------------------------------------------------

type ToastTone = 'success' | 'error' | 'info';

interface ToastInput {
  message: string;
  tone?: ToastTone;
  /** Shown as a button inside the toast, e.g. { label: 'Undo', run: restore }. */
  action?: { label: string; run: () => void | Promise<void> };
  /** ms before auto-dismiss. Defaults: 4s, 8s with an action, 7s for errors. */
  duration?: number;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (t: ToastInput) => void;
  success: (message: string, action?: ToastInput['action']) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// --- confirm --------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  /** The consequence, in plain words. Newlines are kept. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red button, for anything that loses data or moves money. */
  danger?: boolean;
  /** If set, the operator must type this exact text to enable the button. */
  typeToConfirm?: string;
}

type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

let nextId = 1;

// Module-level handles so code outside a component body (or deep in an
// existing handler) can ask without threading a hook through. Registered by
// the provider; before it mounts they fall back to the browser dialog.
let globalConfirm: ConfirmFn | null = null;
let globalToast: ToastApi | null = null;

/** Imperative confirm — `if (!(await adminConfirm({...}))) return;` */
export const adminConfirm: ConfirmFn = (o) =>
  globalConfirm
    ? globalConfirm(o)
    : Promise.resolve(window.confirm(typeof o === 'string' ? o : [o.title, typeof o.body === 'string' ? o.body : ''].join(String.fromCharCode(10, 10))));

/** Imperative toast. */
export const adminToast: ToastApi = {
  show: (t) => globalToast?.show(t),
  success: (m, a) => globalToast?.success(m, a),
  error: (m) => globalToast?.error(m),
};

export function AdminFeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const id = nextId++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      const duration = t.duration ?? (t.action ? 8000 : t.tone === 'error' ? 7000 : 4000);
      window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const toastApi = useRef<ToastApi>({
    show: () => {},
    success: () => {},
    error: () => {},
  });
  toastApi.current.show = show;
  toastApi.current.success = (message, action) => show({ message, tone: 'success', action });
  toastApi.current.error = (message) => show({ message, tone: 'error' });

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        const o = typeof opts === 'string' ? { title: opts } : opts;
        setPending({ ...o, resolve });
      }),
    [],
  );

  useEffect(() => {
    globalConfirm = confirm;
    globalToast = toastApi.current;
    return () => {
      globalConfirm = null;
      globalToast = null;
    };
  }, [confirm]);

  function settle(v: boolean) {
    pending?.resolve(v);
    setPending(null);
  }

  return (
    <ToastContext.Provider value={toastApi.current}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <div className="admin-toast-container" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`admin-toast admin-toast--${t.tone ?? 'success'}`}>
              <span>{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  className="admin-toast__action"
                  onClick={() => {
                    dismiss(t.id);
                    void t.action!.run();
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                className="admin-toast__close"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {pending && <ConfirmDialog opts={pending} onSettle={settle} />}
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

function ConfirmDialog({
  opts,
  onSettle,
}: {
  opts: ConfirmOptions;
  onSettle: (v: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const locked = Boolean(opts.typeToConfirm) && typed.trim() !== opts.typeToConfirm;

  useEffect(() => {
    (opts.typeToConfirm ? inputRef.current : confirmRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSettle(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts.typeToConfirm, onSettle]);

  return (
    <div className="admin-modal-overlay" onClick={() => onSettle(false)}>
      <div
        className="admin-modal admin-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-modal-body">
          <h3 id="admin-confirm-title" className="admin-confirm__title">
            {opts.danger && <span className="admin-confirm__icon" aria-hidden="true">!</span>}
            {opts.title}
          </h3>
          {opts.body && <div className="admin-confirm__body">{opts.body}</div>}
          {opts.typeToConfirm && (
            <label className="admin-confirm__type">
              <span className="small muted">
                Type <strong>{opts.typeToConfirm}</strong> to confirm
              </span>
              <input
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !locked) onSettle(true);
                }}
              />
            </label>
          )}
        </div>
        <div className="admin-confirm__actions">
          <button type="button" className="btn btn-ghost" onClick={() => onSettle(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={locked}
            onClick={() => onSettle(true)}
          >
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

const noopToast: ToastApi = {
  show: () => {},
  success: () => {},
  error: () => {},
};

/** Toasts. Safe outside the provider (no-ops), so shared components can use it. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noopToast;
}

/** Promise-based confirm. Outside the provider it falls back to window.confirm. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return (
    ctx ??
    (async (o) =>
      window.confirm(typeof o === 'string' ? o : [o.title, typeof o.body === 'string' ? o.body : ''].join('\n\n')))
  );
}
