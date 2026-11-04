/**
 * Shared loading / empty / error states.
 *
 * Every long-running view renders one of these while a request is in flight, so
 * a slow backend reads as "working" instead of "broken". Error states always
 * offer a retry so the reviewer is never stuck on a dead screen.
 */

import { useI18n } from "@/lib/i18n";

export function Loading({
  title = "Loading…",
  sub,
  rows = 3,
}: {
  title?: string;
  sub?: string;
  rows?: number;
}) {
  return (
    <div className="card" role="status" aria-live="polite">
      <div className="state-row" style={{ marginBottom: 12 }}>
        <span className="spin" />
        <span className="state-title">{title}</span>
      </div>
      {sub && <div className="state-sub" style={{ marginBottom: 12 }}>{sub}</div>}
      <div aria-hidden="true">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="skeleton skeleton-line"
            style={{ width: `${92 - i * 12}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  title = "Something went wrong",
}: {
  message?: string;
  onRetry?: () => void;
  title?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="card" role="alert">
      <div className="state">
        <span className="state-title" style={{ color: "var(--red)" }}>{t(title)}</span>
        {message && <span className="state-sub">{message}</span>}
        {onRetry && (
          <button className="ghost retry" onClick={onRetry}>
            {t("Try again")}
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="state" role="status">
      <span className="state-title">{title}</span>
      {sub && <span className="state-sub">{sub}</span>}
    </div>
  );
}

/** Skeleton grid used while a list of cards loads. */
export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid g4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card skeleton skeleton-card" />
      ))}
    </div>
  );
}
