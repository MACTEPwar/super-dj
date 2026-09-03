import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';
import { usePageTitle } from '../hooks/usePageTitle';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  usePageTitle(t('auth.login.title'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await login(email, password);
      navigate('/library');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.login.failed'));
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="text-center">
        <div className="text-3xl font-bold">super-dj</div>
        <p className="mt-1 text-sm text-gray-500">{t('auth.tagline')}</p>
      </div>
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">{t('auth.login.title')}</h1>
        <input className="w-full rounded border px-3 py-2" type="email" placeholder={t('auth.login.email')} value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded border px-3 py-2" type="password" placeholder={t('auth.login.password')} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="w-full rounded bg-black px-3 py-2 text-white">{t('auth.login.submit')}</button>
        <p className="text-sm text-gray-500">{t('auth.login.noAccount')} <a className="underline" href="/register">{t('auth.login.registerLink')}</a></p>
      </form>
    </div>
  );
}
