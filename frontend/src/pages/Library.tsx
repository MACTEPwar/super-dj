import { FormEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { tracksApi, Track } from '../api/tracks';
import { ApiError } from '../api/client';

export default function Library() {
  const queryClient = useQueryClient();
  const tracksQuery = useQuery({ queryKey: ['tracks'], queryFn: tracksApi.list });
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
      queryClient.invalidateQueries({ queryKey: ['tracks'] });
      setName('');
      if (audioInputRef.current) audioInputRef.current.value = '';
      if (coverInputRef.current) coverInputRef.current.value = '';
    },
    onError: (err) => setUploadError(err instanceof ApiError ? err.message : 'Upload failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tracksApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracks'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete track'),
  });

  function handleUpload(e: FormEvent) {
    e.preventDefault();
    setUploadError(null);
    uploadMutation.mutate();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Library</h1>

      <form onSubmit={handleUpload} className="space-y-3 rounded-lg border p-4">
        <div>
          <label className="block text-sm font-medium">Audio file</label>
          <input ref={audioInputRef} type="file" accept=".mp3,.wav,.flac,.m4a" required />
        </div>
        <div>
          <label className="block text-sm font-medium">Cover image (optional)</label>
          <input ref={coverInputRef} type="file" accept=".jpg,.jpeg,.png" />
        </div>
        <input className="w-full rounded border px-3 py-2" placeholder="Track name (optional — defaults to file name)" value={name} onChange={(e) => setName(e.target.value)} />
        {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
        <button type="submit" disabled={uploadMutation.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {uploadMutation.isPending ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      <ul className="divide-y rounded-lg border">
        {tracksQuery.data?.map((track: Track) => (
          <li key={track.id} className="flex items-center gap-3 p-3">
            {track.hasCover ? (
              <img src={tracksApi.coverUrl(track.id)} alt="" className="h-10 w-10 rounded object-cover" />
            ) : (
              <div className="h-10 w-10 rounded bg-gray-200" />
            )}
            <div className="flex-1">
              <div className="font-medium">{track.name}</div>
              <div className="text-sm text-gray-500">
                {track.durationSeconds !== null ? `${Math.round(track.durationSeconds)}s` : 'duration unknown'}
              </div>
            </div>
            <button onClick={() => deleteMutation.mutate(track.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {tracksQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No tracks yet.</li>}
      </ul>
    </div>
  );
}
