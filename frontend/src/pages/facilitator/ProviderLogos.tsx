/** Official brand marks, inline so they render crisp and need no network. */

export function GoogleMeetLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size * (72 / 87.5)} viewBox="0 0 87.5 72" role="img" aria-label="Google Meet">
      <path fill="#00832d" d="M49.5 36l8.53 9.75 11.47 7.33 2-17.02-2-16.64-11.69 6.44z" />
      <path fill="#0066da" d="M0 51.5V66c0 3.315 2.685 6 6 6h14.5l3-10.96-3-9.54-9.95-3z" />
      <path fill="#e94235" d="M20.5 0L0 20.5l10.55 3 9.95-3 2.95-9.41z" />
      <path fill="#2684fc" d="M20.5 20.5H0v31h20.5z" />
      <path
        fill="#00ac47"
        d="M82.6 8.68L69.5 19.42v33.66l13.16 10.79c1.97 1.54 4.85.135 4.85-2.37V11c0-2.535-2.945-3.925-4.91-2.32zM49.5 36v15.5h-29V72h43c3.315 0 6-2.685 6-6V53.08z"
      />
      <path fill="#ffba00" d="M63.5 0h-43v20.5h29V36l20-16.57V6c0-3.315-2.685-6-6-6z" />
    </svg>
  );
}

export function ZoomLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Zoom">
      <rect width="64" height="64" rx="14" fill="#0B5CFF" />
      <path
        fill="#fff"
        d="M14 23.5A3.5 3.5 0 0 1 17.5 20h18A6.5 6.5 0 0 1 42 26.5v14a3.5 3.5 0 0 1-3.5 3.5h-18A6.5 6.5 0 0 1 14 37.5zM44.5 29.2l6.3-4.6c1-.7 2.2 0 2.2 1.2v12.4c0 1.2-1.2 1.9-2.2 1.2l-6.3-4.6z"
      />
    </svg>
  );
}

export function GoogleCalendarLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label="Google Calendar">
      <path fill="#fff" d="M152.6 47.4H47.4v105.2h105.2z" />
      <path fill="#ea4335" d="M152.6 200L200 152.6h-47.4z" />
      <path fill="#fbbc04" d="M200 47.4h-47.4v105.2H200z" />
      <path fill="#34a853" d="M152.6 152.6H47.4V200h105.2z" />
      <path fill="#188038" d="M0 152.6v31.6C0 192.9 7.1 200 15.8 200h31.6v-47.4z" />
      <path fill="#1967d2" d="M200 47.4V15.8C200 7.1 192.9 0 184.2 0h-31.6v47.4z" />
      <path fill="#4285f4" d="M152.6 0H15.8C7.1 0 0 7.1 0 15.8v136.8h47.4V47.4h105.2z" />
      <text x="100" y="128" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="62" fill="#1a73e8">
        31
      </text>
    </svg>
  );
}
