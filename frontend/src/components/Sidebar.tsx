import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { LanguageSwitcher } from './LanguageSwitcher';

export function Sidebar() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const links = [
    { to: '/library', label: t('sidebar.library') },
    { to: '/playlists', label: t('sidebar.playlists') },
    { to: '/destinations', label: t('sidebar.destinations') },
    { to: '/templates', label: t('sidebar.templates') },
    { to: '/streams', label: t('sidebar.streams') },
  ];
  return (
    <aside className="flex h-screen w-56 flex-col justify-between border-r bg-gray-50 p-4">
      <div>
        <div className="mb-6 text-lg font-bold">super-dj</div>
        <nav className="space-y-1">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `block rounded px-3 py-2 text-sm ${isActive ? 'bg-gray-200 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="space-y-2 text-sm">
        <LanguageSwitcher />
        <div className="truncate text-gray-500">{user?.email}</div>
        <button onClick={() => logout()} className="text-gray-600 underline">{t('sidebar.signOut')}</button>
      </div>
    </aside>
  );
}
