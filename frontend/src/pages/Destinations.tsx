import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { AddDestinationModal } from '../components/AddDestinationModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePageTitle } from '../hooks/usePageTitle';

export default function Destinations() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  usePageTitle(t('destinations.title'));
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });
  const [isModalOpen, setModalOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => destinationsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['destinations'] });
      setConfirmingId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinations.deleteFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('destinations.title')}</h1>
        <button onClick={() => setModalOpen(true)} className="rounded bg-black px-4 py-2 text-white">{t('destinations.add')}</button>
      </div>

      {destinationsQuery.isLoading ? (
        <p className="text-sm text-gray-500">{t('destinations.loading')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {destinationsQuery.data?.map((destination) => (
            <li key={destination.id} className="flex items-center justify-between p-3">
              <span className="font-medium">
                {destination.name} <span className="text-xs text-gray-500">({destination.provider})</span>
              </span>
              <button onClick={() => setConfirmingId(destination.id)} className="text-sm text-red-600">{t('destinations.delete')}</button>
            </li>
          ))}
          {destinationsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('destinations.empty')}</li>}
        </ul>
      )}

      <AddDestinationModal
        open={isModalOpen}
        onOpenChange={setModalOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['destinations'] })}
      />

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title={t('destinations.deleteConfirmTitle')}
        description={t('destinations.deleteConfirmDescription')}
        confirmLabel={t('destinations.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmingId && deleteMutation.mutate(confirmingId)}
      />
    </div>
  );
}
