import { FormEvent, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { tracksApi } from '../api/tracks';
import { ApiError } from '../api/client';
import { Drawer } from './Drawer';

interface AddTrackDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

export function AddTrackDrawer({ open, onOpenChange, onUploaded }: AddTrackDrawerProps) {
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
    onSuccess: () => {
      onUploaded();
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
    <Drawer open={open} onOpenChange={onOpenChange} title={t('addTrackDrawer.title')}>
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
    </Drawer>
  );
}
