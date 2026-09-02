import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { playlistsApi } from '../api/playlists';
import { destinationsApi } from '../api/destinations';
import { streamSessionsApi } from '../api/streamSessions';
import { ApiError } from '../api/client';
import { Drawer } from './Drawer';

interface StartStreamDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StartStreamDrawer({ open, onOpenChange }: StartStreamDrawerProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });

  const [playlistId, setPlaylistId] = useState('');
  const [destinationIds, setDestinationIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState<'public' | 'unlisted' | 'private'>('private');
  const [latencyPreference, setLatencyPreference] = useState<'normal' | 'low' | 'ultraLow'>('normal');
  const [formError, setFormError] = useState<string | null>(null);

  const selectedDestinations = (destinationsQuery.data ?? []).filter((d) => destinationIds.includes(d.id));
  const hasYoutubeDestination = selectedDestinations.some((d) => d.provider === 'youtube');

  const createMutation = useMutation({
    mutationFn: () => streamSessionsApi.create({
      playlistId,
      destinationIds,
      title: title || undefined,
      description: description || undefined,
      privacyStatus: hasYoutubeDestination ? privacyStatus : undefined,
      latencyPreference: hasYoutubeDestination ? latencyPreference : undefined,
    }),
    onSuccess: (session) => {
      onOpenChange(false);
      navigate(`/streams/${session.id}`);
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : t('startStreamDrawer.failed')),
  });

  function toggleDestination(id: string) {
    setDestinationIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!playlistId || destinationIds.length === 0) return;
    createMutation.mutate();
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t('startStreamDrawer.title')}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="stream-playlist" className="block text-sm font-medium">{t('startStreamDrawer.playlistLabel')}</label>
          <select
            id="stream-playlist"
            className="mt-1 w-full rounded border px-3 py-2"
            value={playlistId}
            onChange={(e) => setPlaylistId(e.target.value)}
            required
          >
            <option value="">{t('startStreamDrawer.selectPlaylist')}</option>
            {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div>
          <div className="block text-sm font-medium">{t('startStreamDrawer.destinationsLabel')}</div>
          <p className="text-xs text-gray-500">{t('startStreamDrawer.destinationsHelp')}</p>
          <ul className="mt-1 divide-y rounded border">
            {destinationsQuery.data?.map((destination) => (
              <li key={destination.id} className="flex items-center gap-2 p-2">
                <input
                  type="checkbox"
                  id={`stream-dest-${destination.id}`}
                  checked={destinationIds.includes(destination.id)}
                  onChange={() => toggleDestination(destination.id)}
                />
                <label htmlFor={`stream-dest-${destination.id}`} className="flex-1 text-sm">
                  {destination.name} <span className="text-xs text-gray-500">({destination.provider})</span>
                </label>
              </li>
            ))}
            {destinationsQuery.data?.length === 0 && <li className="p-2 text-sm text-gray-500">{t('startStreamDrawer.noDestinations')}</li>}
          </ul>
        </div>

        {hasYoutubeDestination && (
          <div className="space-y-3 rounded border p-3">
            <p className="text-xs text-gray-500">{t('startStreamDrawer.youtubeHelp')}</p>
            <input className="w-full rounded border px-3 py-2" placeholder={t('startStreamDrawer.titlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="w-full rounded border px-3 py-2" placeholder={t('startStreamDrawer.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} />
            <div>
              <label htmlFor="stream-privacy" className="block text-sm font-medium">{t('startStreamDrawer.privacyLabel')}</label>
              <select
                id="stream-privacy"
                className="mt-1 w-full rounded border px-3 py-2"
                value={privacyStatus}
                onChange={(e) => setPrivacyStatus(e.target.value as 'public' | 'unlisted' | 'private')}
              >
                <option value="private">{t('startStreamDrawer.private')}</option>
                <option value="unlisted">{t('startStreamDrawer.unlisted')}</option>
                <option value="public">{t('startStreamDrawer.public')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="stream-latency" className="block text-sm font-medium">{t('startStreamDrawer.latencyLabel')}</label>
              <select
                id="stream-latency"
                className="mt-1 w-full rounded border px-3 py-2"
                value={latencyPreference}
                onChange={(e) => setLatencyPreference(e.target.value as 'normal' | 'low' | 'ultraLow')}
              >
                <option value="normal">{t('startStreamDrawer.latencyNormal')}</option>
                <option value="low">{t('startStreamDrawer.latencyLow')}</option>
                <option value="ultraLow">{t('startStreamDrawer.latencyUltraLow')}</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">{t('startStreamDrawer.latencyHelp')}</p>
            </div>
          </div>
        )}

        {formError && <p className="text-sm text-red-600">{formError}</p>}
        <button
          type="submit"
          disabled={!playlistId || destinationIds.length === 0 || createMutation.isPending}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {createMutation.isPending ? t('startStreamDrawer.starting') : t('startStreamDrawer.startButton', { count: destinationIds.length })}
        </button>
      </form>
    </Drawer>
  );
}
