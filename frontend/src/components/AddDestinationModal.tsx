import { FormEvent, useEffect, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { Drawer } from './Drawer';

interface AddDestinationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function AddDestinationModal({ open, onOpenChange, onCreated }: AddDestinationModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [rtmpUrl, setRtmpUrl] = useState('');
  const [streamKey, setStreamKey] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [isConnectingYoutube, setConnectingYoutube] = useState(false);
  const popupRef = useRef<Window | null>(null);

  const manualMutation = useMutation({
    mutationFn: () => destinationsApi.createManual(name, rtmpUrl, streamKey),
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
      setName(''); setRtmpUrl(''); setStreamKey('');
    },
    onError: (err) => setManualError(err instanceof ApiError ? err.message : t('addDestinationModal.addFailed')),
  });

  function handleManualSubmit(e: FormEvent) {
    e.preventDefault();
    setManualError(null);
    manualMutation.mutate();
  }

  async function handleConnectYoutube() {
    try {
      const { authUrl } = await destinationsApi.oauthStart('youtube');
      popupRef.current = window.open(authUrl, 'super-dj-oauth', 'width=500,height=700');
      setConnectingYoutube(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('addDestinationModal.connectFailed'));
    }
  }

  // Primary detection: the callback page (backend) posts this message and closes itself.
  // Fallback: if the popup closes without ever sending the message (blocked postMessage, manual
  // close), poll popup.closed and refresh the destinations list anyway — cheap insurance
  // against relying on a single signal.
  useEffect(() => {
    if (!isConnectingYoutube) return;

    function handleMessage(event: MessageEvent) {
      if (event.data === 'super-dj-oauth-connected') {
        setConnectingYoutube(false);
        onCreated();
        onOpenChange(false);
      }
    }
    window.addEventListener('message', handleMessage);

    const pollId = window.setInterval(() => {
      if (popupRef.current?.closed) {
        setConnectingYoutube(false);
        onCreated();
        onOpenChange(false);
      }
    }, 500);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.clearInterval(pollId);
    };
  }, [isConnectingYoutube, onCreated, onOpenChange]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t('addDestinationModal.title')}>
      <Tabs.Root defaultValue="youtube">
        <Tabs.List className="mb-4 flex gap-2 border-b">
          <Tabs.Trigger value="youtube" className="px-3 py-2 text-sm data-[state=active]:border-b-2 data-[state=active]:border-black">{t('addDestinationModal.tabYoutube')}</Tabs.Trigger>
          <Tabs.Trigger value="manual" className="px-3 py-2 text-sm data-[state=active]:border-b-2 data-[state=active]:border-black">{t('addDestinationModal.tabManual')}</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="youtube">
          <p className="mb-4 text-sm text-gray-600">{t('addDestinationModal.youtubeDescription')}</p>
          <button onClick={handleConnectYoutube} disabled={isConnectingYoutube} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
            {isConnectingYoutube ? t('addDestinationModal.waitingForGoogle') : t('addDestinationModal.connectWithGoogle')}
          </button>
        </Tabs.Content>

        <Tabs.Content value="manual">
          <form onSubmit={handleManualSubmit} className="space-y-3">
            <input className="w-full rounded border px-3 py-2" placeholder={t('addDestinationModal.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} required />
            <input className="w-full rounded border px-3 py-2" placeholder={t('addDestinationModal.rtmpUrlPlaceholder')} value={rtmpUrl} onChange={(e) => setRtmpUrl(e.target.value)} required />
            <input className="w-full rounded border px-3 py-2" placeholder={t('addDestinationModal.streamKeyPlaceholder')} value={streamKey} onChange={(e) => setStreamKey(e.target.value)} required />
            {manualError && <p className="text-sm text-red-600">{manualError}</p>}
            <button type="submit" disabled={manualMutation.isPending} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
              {manualMutation.isPending ? t('addDestinationModal.adding') : t('addDestinationModal.add')}
            </button>
          </form>
        </Tabs.Content>
      </Tabs.Root>
    </Drawer>
  );
}
