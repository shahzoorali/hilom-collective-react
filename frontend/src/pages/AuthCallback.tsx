import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { handleCallback } from '../lib/auth';

export default function AuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const oauthError = params.get('error_description') ?? params.get('error');
    if (oauthError) {
      setError(oauthError);
      return;
    }
    const code = params.get('code');
    if (!code) {
      setError('No authorization code returned.');
      return;
    }
    handleCallback(code)
      .then((returnTo) => navigate(returnTo, { replace: true }))
      .catch((e: Error) => setError(e.message));
  }, [params, navigate]);

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 520, textAlign: 'center' }}>
        {error ? (
          <div className="panel">
            <div className="alert alert-error">{error}</div>
            <button className="btn btn-primary" onClick={() => navigate('/')}>
              Back to the site
            </button>
          </div>
        ) : (
          <div className="panel">
            <div className="spinner" />
            <p className="muted">Signing you in…</p>
          </div>
        )}
      </div>
    </section>
  );
}
