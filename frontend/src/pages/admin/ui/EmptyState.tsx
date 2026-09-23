import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * What a list shows when it has nothing in it. Says what would be here and,
 * where there is one, offers the action that puts the first thing there — a
 * blank box reads as "broken", this reads as "nothing yet".
 */
export function EmptyState({
  icon = 'inbox',
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-state__title">{title}</div>
      {body && <div className="empty-state__body small muted">{body}</div>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}
