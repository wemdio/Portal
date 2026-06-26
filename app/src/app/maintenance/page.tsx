// Mirror of deploy/nginx/50x.html design so the visual stays identical
// whether the page is served by Next.js (admin enabled MAINTENANCE_MODE)
// or by Nginx (backend rolling during deploy).
//
// Auto-refresh every 15 s — when maintenance ends, the next reload takes
// the user back into the app without any user click.

export const metadata = {
  title: 'Обновление портала',
  other: {
    refresh: '15',
  },
};

export default function MaintenancePage() {
  return (
    <main
      style={{
        margin: 0,
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background:
          'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(255, 255, 255, 0.10), transparent 70%), #0a0a0a',
        color: '#fafafa',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <section
        style={{
          width: 'min(460px, 100%)',
          padding: '48px 36px',
          background: '#111213',
          border: '1px solid #1f2023',
          borderRadius: '20px',
          textAlign: 'center',
          boxShadow:
            '0 0 80px rgba(255, 255, 255, 0.06), 0 20px 60px rgba(0, 0, 0, 0.6)',
        }}
      >
        <div
          style={{
            width: '64px',
            height: '64px',
            margin: '0 auto 24px',
            display: 'grid',
            placeItems: 'center',
            background: '#18191c',
            border: '1px solid #1f2023',
            borderRadius: '16px',
            fontSize: '28px',
            lineHeight: 1,
          }}
        >
          ⚙
        </div>
        <span
          style={{
            display: 'inline-block',
            padding: '6px 12px',
            marginBottom: '18px',
            borderRadius: '999px',
            background: '#18191c',
            border: '1px solid #1f2023',
            color: '#a1a1a3',
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}
        >
          Technical update
        </span>
        <h1
          style={{
            margin: '0 0 12px',
            fontSize: '28px',
            lineHeight: 1.2,
            fontWeight: 600,
            color: '#fafafa',
          }}
        >
          Обновление портала
        </h1>
        <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: '#a1a1a3' }}>
          Подождите, пожалуйста, 5–10 минут.
        </p>
      </section>
    </main>
  );
}
