import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await register(email, password);
      navigate('/library');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.register.failed'));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">{t('auth.register.title')}</h1>
        <input className="w-full rounded border px-3 py-2" type="email" placeholder={t('auth.login.email')} value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full rounded border px-3 py-2" type="password" placeholder={t('auth.login.password')} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="w-full rounded bg-black px-3 py-2 text-white">{t('auth.register.submit')}</button>
        <p className="text-sm text-gray-500">{t('auth.register.haveAccount')} <a className="underline" href="/login">{t('auth.register.signInLink')}</a></p>
      </form>
    </div>
  );
}
