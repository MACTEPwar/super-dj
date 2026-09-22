import { FormEvent, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { tracksApi, Track } from '../api/tracks';
import { ApiError } from '../api/client';
import { Drawer } from './Drawer';

interface AddTrackDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (track: Track) => void;
}

type Tab = 'upload' | 'service';

function tabButtonClass(active: boolean): string {
  return `px-3 py-2 text-sm font-medium border-b-2 ${active ? 'border-black text-black' : 'border-transparent text-gray-500'}`;
}

function UploadTab({ onOpenChange, onAdded }: { onOpenChange: (open: boolean) => void; onAdded: (track: Track) => void }) {
  const { t } = useTranslation();
  const audioInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: () => {
      const audio = audioInputRef.current?.files?.[0];
      if (!audio) throw new Error('choose an audio file first');
      const cover = coverInputRef.current?.files?.[0] ?? null;
      return tracksApi.upload(audio, cover, name || undefined);
    },
    onSuccess: (track) => {
      onAdded(track);
      onOpenChange(false);
      setName('');
      if (audioInputRef.current) audioInputRef.current.value = '';
      if (coverInputRef.current) coverInputRef.current.value = '';
    },
    onError: (err) => setUploadError(err instanceof ApiError ? err.message : t('addTrackDrawer.failed')),
  });

  function handleUpload(e: FormEvent) {
    e.preventDefault();
    setUploadError(null);
    uploadMutation.mutate();
  }

  return (
    <form onSubmit={handleUpload} className="space-y-3">
      <div>
        <label htmlFor="track-audio-file" className="block text-sm font-medium">{t('addTrackDrawer.audioFile')}</label>
        <input id="track-audio-file" ref={audioInputRef} type="file" accept=".mp3,.wav,.flac,.m4a" required />
      </div>
      <div>
        <label htmlFor="track-cover-file" className="block text-sm font-medium">{t('addTrackDrawer.coverFile')}</label>
        <input id="track-cover-file" ref={coverInputRef} type="file" accept=".jpg,.jpeg,.png" />
      </div>
      <input className="w-full rounded border px-3 py-2" placeholder={t('addTrackDrawer.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
      {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
      <button type="submit" disabled={uploadMutation.isPending} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {uploadMutation.isPending ? t('addTrackDrawer.uploading') : t('addTrackDrawer.upload')}
      </button>
    </form>
  );
}

function ServiceTab({ onOpenChange, onAdded }: { onOpenChange: (open: boolean) => void; onAdded: (track: Track) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: () => tracksApi.searchPreview(query),
    onSuccess: ({ previewId: id }) => {
      setPreviewId(id);
      setName(query);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('addTrackDrawer.searchFailed')),
  });

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (!previewId) throw new Error('no preview to confirm');
      const cover = coverInputRef.current?.files?.[0] ?? null;
      return tracksApi.confirmPreview(previewId, name || undefined, cover);
    },
    onSuccess: (track) => {
      onAdded(track);
      onOpenChange(false);
      resetState();
    },
    onError: (err) => {
      // A 404 here means the preview expired or was already reaped (e.g. by the registry's own
      // prune sweep) — the dead <audio> element on screen can never be confirmed, so bounce back
      // to the query-input state (NOT resetState(), which would also throw away the streamer's
      // already-typed query — unnecessary friction on top of an already-annoying dead end).
      if (err instanceof ApiError && err.status === 404) {
        setPreviewId(null);
        setError(t('addTrackDrawer.previewExpired'));
        return;
      }
      setError(err instanceof ApiError ? err.message : t('addTrackDrawer.confirmFailed'));
    },
  });

  function resetState() {
    setQuery('');
    setPreviewId(null);
    setName('');
    setError(null);
    if (coverInputRef.current) coverInputRef.current.value = '';
  }

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    searchMutation.mutate();
  }

  function handleTryAnother() {
    if (previewId) tracksApi.discardPreview(previewId).catch(() => {});
    setPreviewId(null);
    setError(null);
  }

  if (previewId) {
    return (
      <div className="space-y-3">
        <audio controls data-testid="preview-audio" src={tracksApi.previewUrl(previewId)} className="w-full" />
        <input className="w-full rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('addTrackDrawer.namePlaceholder')} />
        <div>
          <label htmlFor="track-service-cover" className="block text-sm font-medium">{t('addTrackDrawer.coverFile')}</label>
          <input id="track-service-cover" ref={coverInputRef} type="file" accept=".jpg,.jpeg,.png" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending} className="flex-1 rounded bg-black px-4 py-2 text-white disabled:opacity-50">
            {confirmMutation.isPending ? t('addTrackDrawer.adding') : t('addTrackDrawer.add')}
          </button>
          <button onClick={handleTryAnother} disabled={confirmMutation.isPending} className="flex-1 rounded border px-4 py-2 disabled:opacity-50">
            {t('addTrackDrawer.tryAnother')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSearch} className="space-y-3">
      <div>
        <label htmlFor="track-service-query" className="block text-sm font-medium">{t('addTrackDrawer.queryLabel')}</label>
        <input id="track-service-query" value={query} onChange={(e) => setQuery(e.target.value)} required className="mt-1 w-full rounded border px-3 py-2" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={searchMutation.isPending || query.trim().length === 0} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {searchMutation.isPending ? t('addTrackDrawer.searching') : t('addTrackDrawer.search')}
      </button>
    </form>
  );
}

export function AddTrackDrawer({ open, onOpenChange, onAdded }: AddTrackDrawerProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('upload');

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t('addTrackDrawer.title')}>
      <div className="mb-4 flex border-b">
        <button className={tabButtonClass(tab === 'upload')} onClick={() => setTab('upload')}>{t('addTrackDrawer.tabUpload')}</button>
        <button className={tabButtonClass(tab === 'service')} onClick={() => setTab('service')}>{t('addTrackDrawer.tabService')}</button>
      </div>
      {tab === 'upload'
        ? <UploadTab onOpenChange={onOpenChange} onAdded={onAdded} />
        : <ServiceTab onOpenChange={onOpenChange} onAdded={onAdded} />}
    </Drawer>
  );
}
