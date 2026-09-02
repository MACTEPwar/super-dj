import { FormEvent, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';

interface AddDestinationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function AddDestinationModal({ open, onOpenChange, onCreated }: AddDestinationModalProps) {
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
    onError: (err) => setManualError(err instanceof ApiError ? err.message : 'Failed to add destination'),
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
      toast.error(err instanceof ApiError ? err.message : 'Failed to start YouTube connection');
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-lg">
          <Dialog.Title className="mb-4 text-lg font-semibold">Add Destination</Dialog.Title>
          <Tabs.Root defaultValue="youtube">
            <Tabs.List className="mb-4 flex gap-2 border-b">
              <Tabs.Trigger value="youtube" className="px-3 py-2 text-sm data-[state=active]:border-b-2 data-[state=active]:border-black">YouTube</Tabs.Trigger>
              <Tabs.Trigger value="manual" className="px-3 py-2 text-sm data-[state=active]:border-b-2 data-[state=active]:border-black">Manual</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="youtube">
              <p className="mb-4 text-sm text-gray-600">Connect your YouTube channel to stream directly through it.</p>
              <button onClick={handleConnectYoutube} disabled={isConnectingYoutube} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
                {isConnectingYoutube ? 'Waiting for Google…' : 'Connect with Google'}
              </button>
            </Tabs.Content>

            <Tabs.Content value="manual">
              <form onSubmit={handleManualSubmit} className="space-y-3">
                <input className="w-full rounded border px-3 py-2" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
                <input className="w-full rounded border px-3 py-2" placeholder="RTMP URL" value={rtmpUrl} onChange={(e) => setRtmpUrl(e.target.value)} required />
                <input className="w-full rounded border px-3 py-2" placeholder="Stream key" value={streamKey} onChange={(e) => setStreamKey(e.target.value)} required />
                {manualError && <p className="text-sm text-red-600">{manualError}</p>}
                <button type="submit" disabled={manualMutation.isPending} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
                  {manualMutation.isPending ? 'Adding…' : 'Add'}
                </button>
              </form>
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
