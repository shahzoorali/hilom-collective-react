/**
 * "Scheduled for <date>" pill — shared by PagesTab, PostsTab, and BlockEditor
 * so a scheduled item reads the same everywhere it appears, not "scheduled"
 * as a bare status word with the actual date buried in a tooltip.
 */
export default function ScheduledBadge({ at }: { at: string | null }) {
  if (!at) return <span className="pill pill-warn">scheduled</span>;

  const date = new Date(at);
  const overdue = date.getTime() < Date.now();

  return (
    <span
      className={overdue ? 'pill pill-bad' : 'pill pill-warn'}
      title={overdue ? 'Past its scheduled time — the publish sweep runs every few minutes' : undefined}
    >
      {overdue ? '⏱ overdue — ' : '🕒 '}
      {date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}
    </span>
  );
}
