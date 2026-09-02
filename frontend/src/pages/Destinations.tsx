import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { AddDestinationModal } from '../components/AddDestinationModal';

export default function Destinations() {
  const queryClient = useQueryClient();
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });
  const [isModalOpen, setModalOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => destinationsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['destinations'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete destination'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Destinations</h1>
        <button onClick={() => setModalOpen(true)} className="rounded bg-black px-4 py-2 text-white">+ Add Destination</button>
      </div>

      <ul className="divide-y rounded-lg border">
        {destinationsQuery.data?.map((destination) => (
          <li key={destination.id} className="flex items-center justify-between p-3">
            <Link to={`/destinations/${destination.id}`} className="font-medium underline">
              {destination.name} <span className="text-xs text-gray-500">({destination.provider})</span>
            </Link>
            <button onClick={() => deleteMutation.mutate(destination.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {destinationsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No destinations yet.</li>}
      </ul>

      <AddDestinationModal
        open={isModalOpen}
        onOpenChange={setModalOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['destinations'] })}
      />
    </div>
  );
}
